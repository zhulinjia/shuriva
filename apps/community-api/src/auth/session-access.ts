import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { performance } from "node:perf_hooks";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "../auth.js";
import type { SessionAccess } from "./session.js";
import { OperationalError } from "../operational-error.js";
import { diagnostics } from "../logging/public.js";
const sessionCheckTimeoutMs = 2000;
const maxPendingSessionChecks = 32;
export function authSessionAccess(auth: Auth, pool: Pool): SessionAccess {
  // Retain timed-out acquisitions until the public pool API actually returns
  // them. Bound outstanding physical work, but never reuse another request's
  // authorization result: a later request needs its own current database read.
  const pending = new Set<Promise<boolean>>();
  return {
    async authenticate(headers) {
      const value = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
      return value ? { ownerId: value.user.id, sessionId: value.session.id } : undefined;
    },
    active(identity) {
      if (pending.size >= maxPendingSessionChecks)
        return Promise.reject(new OperationalError("AUTH_SESSION_CHECK_CAPACITY"));
      let resolve!: (active: boolean) => void, reject!: (error: unknown) => void;
      const result = new Promise<boolean>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      pending.add(result);
      const forget = () => {
        pending.delete(result);
      };
      const deadline = performance.now() + sessionCheckTimeoutMs;
      let connection: PoolConnection | undefined,
        settled = false,
        destroyed = false;
      const destroy = () => {
        destroyed = true;
        try {
          connection?.destroy();
        } catch (error) {
          diagnostics.error("auth.session_cleanup_failed", {}, error);
        }
      };
      const expire = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (connection) {
          destroy();
        }
        reject(new OperationalError("AUTH_SESSION_CHECK_TIMEOUT"));
      };
      const timer = setTimeout(expire, sessionCheckTimeoutMs);
      const run = async () => {
        try {
          connection = await pool.getConnection();
          if (settled) return;
          if (performance.now() >= deadline) {
            expire();
            return;
          }
          // The outer deadline owns cancellation. Driver sequence timeouts can
          // reject without terminating the active command and cannot be used.
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>UTC_TIMESTAMP(3)",
            [identity.sessionId, identity.ownerId],
          );
          if (settled) return;
          if (performance.now() >= deadline) {
            expire();
            return;
          }
          settled = true;
          resolve(rows.length === 1);
        } catch (error) {
          if (connection && !destroyed) destroy();
          if (!settled) {
            settled = true;
            reject(error);
          }
        } finally {
          clearTimeout(timer);
          if (connection && !destroyed) {
            try {
              connection.release();
            } catch (error) {
              destroy();
              diagnostics.error("auth.session_cleanup_failed", {}, error);
            }
          }
          forget();
        }
      };
      void run();
      return result;
    },
  };
}
