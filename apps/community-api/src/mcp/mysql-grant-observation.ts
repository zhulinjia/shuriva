import { performance } from "node:perf_hooks";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { McpGrantObservation, McpGrantRecord } from "./grant-authority.js";

type SessionDeadline = (
  connection: PoolConnection,
  ownerId: string,
  sessionId: string,
) => Promise<number | undefined>;

interface GrantRow extends RowDataPacket {
  id: string;
  ownerId: string;
  clientId: string;
  approvalSessionId: string;
  resource: string;
  generation: number | string;
  issuedGeneration: number | string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Only this adapter reads MCP grant tables. The auth module owns the session
 * lookup, using the same transaction. Both this pool and the SDK pool must be
 * dedicated and bounded: session lock-wait settings are changed on checkout. */
export function mysqlMcpGrantObservation(
  pool: Pool,
  sessionDeadline: SessionDeadline,
  lockDeadlineMs = 5_000,
): McpGrantObservation {
  if (!Number.isSafeInteger(lockDeadlineMs) || lockDeadlineMs < 1 || lockDeadlineMs > 30_000)
    throw new Error("MCP_GRANT_DEADLINE_INVALID");
  // A timed-out checkout or callback can still be pending inside a driver or
  // SDK. Keep its slot until it actually settles, preventing an unbounded queue.
  let outstanding = 0;
  return {
    async observe(tokenHash, decide) {
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) return false;
      if (outstanding >= 8) throw new Error("MCP_GRANT_CAPACITY");
      outstanding++;
      const deadline = performance.now() + lockDeadlineMs;
      let connection: PoolConnection | undefined;
      let expired = false;
      let destroyed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expire = () => {
        expired = true;
        if (connection && !destroyed) {
          destroyed = true;
          try {
            connection.destroy();
          } catch {
            /* never reuse this connection */
          }
        }
      };
      const checkDeadline = () => {
        if (expired || performance.now() >= deadline) {
          expire();
          throw new Error("MCP_GRANT_DEADLINE_EXCEEDED");
        }
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expire();
          reject(new Error("MCP_GRANT_DEADLINE_EXCEEDED"));
        }, lockDeadlineMs);
      });
      const work = async () => {
        try {
          connection = await pool.getConnection();
          // If checkout completed after timeout, this connection has not been
          // used and can be returned; no transaction has been started.
          if (expired || performance.now() >= deadline) {
            expired = true;
            throw new Error("MCP_GRANT_DEADLINE_EXCEEDED");
          }
          // Client socket destruction does not guarantee an executing MySQL
          // thread stops. Bound both metadata and InnoDB row-lock waits on the
          // server; this connection must belong to a dedicated MCP pool.
          await connection.query(
            "SET SESSION lock_wait_timeout = 2, SESSION innodb_lock_wait_timeout = 2",
          );
          checkDeadline();
          await connection.beginTransaction();
          checkDeadline();
          const [rows] = await connection.execute<GrantRow[]>(
            "SELECT g.id,g.ownerId,g.clientId,g.approvalSessionId,g.resource,g.generation,g.expiresAt,g.revokedAt,t.issuedGeneration FROM mcp_grant g JOIN mcp_grant_token t ON t.grantId=g.id WHERE t.tokenHash=? FOR SHARE",
            [tokenHash],
          );
          checkDeadline();
          const row = rows[0];
          if (rows.length > 1) throw new Error("MCP_GRANT_METADATA_INVALID");
          let grant: McpGrantRecord | null = null;
          if (row) {
            if (!(row.expiresAt instanceof Date) || !Number.isFinite(row.expiresAt.getTime()))
              throw new Error("MCP_GRANT_METADATA_INVALID");
            grant = {
              id: row.id,
              ownerId: row.ownerId,
              clientId: row.clientId,
              approvalSessionId: row.approvalSessionId,
              resource: row.resource,
              generation: Number(row.generation),
              tokenGeneration: Number(row.issuedGeneration),
              expiresAt: row.expiresAt.getTime(),
              revoked: row.revokedAt !== null,
            };
          }
          const sessionExpiresAt = grant
            ? await sessionDeadline(connection, grant.ownerId, grant.approvalSessionId)
            : undefined;
          checkDeadline();
          const accepted = await decide({ grant, sessionExpiresAt });
          checkDeadline();
          await connection.commit();
          checkDeadline();
          return accepted;
        } catch (error) {
          if (expired || !connection) throw error;
          try {
            await connection.rollback();
          } catch (rollback) {
            destroyed = true;
            try {
              connection.destroy();
            } catch (cleanup) {
              throw new AggregateError([error, rollback, cleanup], "MCP_GRANT_ROLLBACK_FAILED");
            }
            throw new AggregateError([error, rollback], "MCP_GRANT_ROLLBACK_FAILED");
          }
          throw error;
        } finally {
          try {
            if (connection && !destroyed) connection.release();
          } finally {
            // A destroyed socket cannot prove that the server thread stopped.
            // Retain this slot for the lifetime of the authority so repeated
            // timeouts cannot produce unbounded abandoned server work.
            if (!destroyed) outstanding--;
          }
        }
      };
      try {
        return await Promise.race([work(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
