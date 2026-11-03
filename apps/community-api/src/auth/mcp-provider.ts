import { randomUUID } from "node:crypto";
import { mcp, type McpOptions } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { Kysely, MysqlDialect } from "kysely";
import type { Pool } from "mysql2/promise";
import type { AuthConfig } from "../auth.js";
import {
  createMcpResourceVerifier,
  type AuthorizedMcpGrant,
  type VerifiedMcpToken,
} from "../mcp/public.js";

/** Dedicated bounded pool; SDK owns all OAuth tables and credentials. */
export function createMcpIdentityProvider(
  config: AuthConfig,
  pool: Pool,
  options: McpOptions,
  authorize: (
    token: string,
    initial: VerifiedMcpToken,
    confirm: () => Promise<VerifiedMcpToken | null>,
  ) => Promise<AuthorizedMcpGrant | null>,
) {
  const database = new Kysely<unknown>({ dialect: new MysqlDialect({ pool: pool.pool }) });
  return betterAuth({
    database: { db: database, type: "mysql" },
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    trustedOrigins: [config.origin],
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: config.origin.startsWith("https:"),
    },
    session: { cookieCache: { enabled: false } },
    logger: { disabled: true },
    onAPIError: { throw: true },
    plugins: [mcp(options), createMcpResourceVerifier(options, authorize)],
  });
}

/** Auth owns SDK tables. Expired token metadata has no application authority;
 * retain seven days, then clean one bounded batch per maintenance tick. */
export async function pruneMcpIdentityMetadata(pool: Pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET SESSION lock_wait_timeout=2, SESSION innodb_lock_wait_timeout=2");
    await connection.execute(
      "DELETE FROM mcp_oauth_access_token WHERE expiresAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY) LIMIT 100",
    );
    await connection.execute(
      "DELETE FROM mcp_oauth_refresh_token WHERE expiresAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY) LIMIT 100",
    );
    await connection.execute(
      "DELETE FROM mcp_oauth_client_assertion WHERE expiresAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY) LIMIT 100",
    );
  } finally {
    connection.release();
  }
}
