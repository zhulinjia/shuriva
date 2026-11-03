import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, getSession } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { username } from "better-auth/plugins";
import type { ExecuteValues, FieldPacket, Pool, QueryResult, RowDataPacket } from "mysql2/promise";
import { credentialTransactions, transactionalEndpoint } from "./auth/credential-transaction.js";
import { databaseConnectionOptions } from "./auth/database.js";
import { AuthRequestError, prepareAuthRequest } from "./auth/http-request.js";
import { diagnostics } from "./logging/public.js";
import { OperationalError } from "./operational-error.js";

export { createDatabase } from "./auth/database.js";
export { authSessionAccess } from "./auth/session-access.js";

export interface AuthConfig {
  databaseUrl: string;
  secret: string;
  origin: string;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  const secret = env.BETTER_AUTH_SECRET;
  const origin = env.APP_ORIGIN?.trim();
  if (!databaseUrl || !secret || !origin) throw new OperationalError("AUTH_CONFIG_REQUIRED");
  if (secret.length < 32) throw new OperationalError("AUTH_SECRET_TOO_SHORT");
  databaseConnectionOptions(databaseUrl);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new OperationalError("APP_ORIGIN_INVALID");
  }
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol))
    throw new OperationalError("APP_ORIGIN_INVALID");
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new OperationalError("APP_ORIGIN_INSECURE");
  return { databaseUrl, secret, origin };
}

export function createAuth(config: AuthConfig, database: Pool) {
  const credentials = credentialTransactions(database);
  const auth = betterAuth({
    database: credentials.adapter,
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    trustedOrigins: [config.origin],
    // better-call otherwise writes raw adapter exceptions (including SQL) to
    // console.error after the SDK logger. The outer handler owns safe reporting.
    onAPIError: { throw: true },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/change-password")
          return { context: { ...context, body: { ...context.body, revokeOtherSessions: true } } };
        if (context.path === "/sign-out") {
          // The public raw endpoint propagates failures; getSessionFromCtx
          // intentionally swallows them and cannot establish this invariant.
          const value = await getSession()({
            ...context,
            headers: context.headers ?? new Headers(),
            method: "GET",
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
            query: { disableCookieCache: true, disableRefresh: true },
          });
          credentials.captureSignOutSession(value?.session.id);
        }
      }),
      after: createAuthMiddleware(async (context) => {
        const result: unknown = context.context.returned;
        if (
          context.path === "/sign-out" &&
          result &&
          typeof result === "object" &&
          "success" in result &&
          result.success === true
        )
          await credentials.assertSignOutRevoked();
      }),
    },
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
  let activeCredentials = 0;
  const responseCleanup = new WeakMap<Response, () => void>();
  let readingBodies = 0;
  const prepare = async (request: Request) => {
    if (request.method !== "POST") return request;
    if (readingBodies >= 32) throw new OperationalError("AUTH_REQUEST_CAPACITY");
    readingBodies++;
    try {
      return await prepareAuthRequest(request, config.origin);
    } finally {
      readingBodies--;
    }
  };
  const run = async <T>(operation: () => Promise<T>) => {
    // No queue of credential transactions may exhaust the shared DB pool.
    if (activeCredentials >= 3) throw new OperationalError("AUTH_CREDENTIAL_CAPACITY");
    activeCredentials++;
    try {
      await auth.$context;
      return await credentials.run(operation);
    } finally {
      activeCredentials--;
    }
  };
  return {
    ...auth,
    api: {
      ...auth.api,
      signInUsername: transactionalEndpoint(auth.api.signInUsername, run),
      signInEmail: transactionalEndpoint(auth.api.signInEmail, run),
      changePassword: transactionalEndpoint(auth.api.changePassword, run),
      signOut: transactionalEndpoint(auth.api.signOut, run),
    },
    handler: async (request: Request) => {
      try {
        const ready = await prepare(request);
        // The product router owns the endpoint allowlist. Every state-changing
        // SDK HTTP request shares the same atomic credential boundary.
        return await (request.method === "POST"
          ? run(() => auth.handler(ready))
          : auth.handler(ready));
      } catch (error) {
        if (error instanceof AuthRequestError) {
          const response = Response.json(
            { error: "INVALID_AUTH_REQUEST" },
            { status: error.status, headers: { "Cache-Control": "no-store", Connection: "close" } },
          );
          responseCleanup.set(response, () => error.finish());
          return response;
        }
        diagnostics.error("auth.failure", {}, error);
        return Response.json(
          { error: "AUTH_UNAVAILABLE" },
          {
            status: 500,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
    },
    completeResponse(response: Response) {
      const cleanup = responseCleanup.get(response);
      responseCleanup.delete(response);
      cleanup?.();
    },
  };
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
type AuthSessionTransaction = {
  execute<T extends QueryResult>(sql: string, values: ExecuteValues[]): Promise<[T, FieldPacket[]]>;
};
export async function authSessionReferenceActive(
  transaction: AuthSessionTransaction,
  ownerId: string,
  sessionId: string,
): Promise<boolean> {
  return (await authSessionReferenceDeadline(transaction, ownerId, sessionId)) !== undefined;
}

/** Auth-owned expiry proof for callers that must await further work/commit.
 * The row remains shared-locked on the caller's transaction connection. */
export async function authSessionReferenceDeadline(
  transaction: AuthSessionTransaction,
  ownerId: string,
  sessionId: string,
): Promise<number | undefined> {
  const [rows] = await transaction.execute<RowDataPacket[]>(
    "SELECT expiresAt FROM session WHERE id=? AND userId=? AND expiresAt>UTC_TIMESTAMP(3) FOR SHARE",
    [sessionId, ownerId],
  );
  if (rows.length !== 1) return undefined;
  const value: unknown = rows[0]?.expiresAt;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("AUTH_SESSION_EXPIRY_INVALID");
  return value.getTime();
}
