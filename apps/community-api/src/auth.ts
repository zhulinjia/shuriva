import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { diagnostics } from "./logging/public.js";

export interface AuthConfig {
  databaseUrl: string;
  secret: string;
  origin: string;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  const secret = env.BETTER_AUTH_SECRET;
  const origin = env.APP_ORIGIN?.trim();
  if (!databaseUrl || !secret || !origin)
    throw new Error("DATABASE_URL, BETTER_AUTH_SECRET and APP_ORIGIN are required");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const database = new URL(databaseUrl);
  if (database.protocol !== "mysql:" || !database.hostname || !database.pathname.slice(1))
    throw new Error("DATABASE_URL must be a MySQL database URL");
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol))
    throw new Error("APP_ORIGIN must be an HTTP(S) origin without a trailing slash");
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new Error("APP_ORIGIN must use HTTPS except on localhost");
  return { databaseUrl, secret, origin };
}

export function createDatabase(url: string): Pool {
  const parsed = new URL(url);
  return createPool({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    timezone: "Z",
    connectionLimit: 10,
  });
}

export function createAuth(config: AuthConfig, database: Pool) {
  return betterAuth({
    database,
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    trustedOrigins: [config.origin],
    // SDK messages and arguments may contain request or adapter details. Keep
    // them inside the same reviewed boundary as application diagnostics.
    logger: {
      level: "debug",
      log(level, _message, ...args: unknown[]) {
        const error = args.find((value) => value instanceof Error);
        if (level === "error") diagnostics.error("auth.failure", {}, error);
        else if (level === "warn") diagnostics.warn("auth.warning", {}, error);
        else if (level === "debug") diagnostics.debug("auth.debug");
        else diagnostics.info("auth.lifecycle");
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 64 })],
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: config.origin.startsWith("https:"),
    },
    session: { expiresIn: 60 * 60 * 24, updateAge: 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
      customRules: { "/sign-in/username": { window: 60, max: 5 } },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;

/** Opaque session reference only: callers must never persist the Cookie or token. */
export function authMutationIdentity(auth: Auth) {
  return async (
    headers: IncomingHttpHeaders,
  ): Promise<{ ownerId: string; sessionId: string } | undefined> => {
    const value = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    return value ? { ownerId: value.user.id, sessionId: value.session.id } : undefined;
  };
}

/** Called inside the authorization transaction; Better Auth session deletion waits for this lock. */
export async function authSessionReferenceActive(
  transaction: PoolConnection,
  ownerId: string,
  sessionId: string,
): Promise<boolean> {
  const [rows] = await transaction.execute<RowDataPacket[]>(
    "SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>UTC_TIMESTAMP(3) FOR SHARE",
    [sessionId, ownerId],
  );
  return rows.length === 1;
}
