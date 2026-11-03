import { performance } from "node:perf_hooks";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { authSessionReferenceDeadline, type SessionIdentity } from "../auth/public.js";
import { workspaceReferenceActive } from "../workspaces.js";
import { approvalsSchema, type Connection, ExternalMcpError } from "./model.js";
import type { RuntimeOwnership } from "./ownership.js";

type ToolProof = { name: string; hash: string; sessionId: string };
/** Short physical admission/disclosure lease, NOT a 60s external-tool lock.
 * Destroyed work keeps its slot when server-side completion is unproven. */
export class ExternalLease {
  private outstanding = 0;
  constructor(
    private readonly pool: Pool,
    private readonly ownership: RuntimeOwnership,
    private readonly executionHostId: string,
  ) {}
  close() {
    return this.ownership.close();
  }
  health() {
    return { outstanding: this.outstanding, capacity: 8, available: this.outstanding < 8 };
  }
  run<T>(
    conn: Connection,
    who: SessionIdentity,
    action: (check: () => void, signal: AbortSignal, remainingMs: () => number) => Promise<T>,
    tool?: ToolProof,
    otherSessions: string[] = [],
  ) {
    return this.observe(conn, who, action, tool, otherSessions, true);
  }
  metadata(conn: Connection, who: SessionIdentity) {
    return this.observe(conn, who, async (check) => check(), undefined, [], false);
  }
  private async observe<T>(
    conn: Connection,
    who: SessionIdentity,
    action: (check: () => void, signal: AbortSignal, remainingMs: () => number) => Promise<T>,
    tool: ToolProof | undefined,
    otherSessions: string[],
    requireHost: boolean,
  ): Promise<T> {
    if (this.outstanding >= 8) throw new ExternalMcpError("EXTERNAL_MCP_AUTH_CAPACITY", 503);
    this.outstanding++;
    const end = performance.now() + 5000,
      abort = new AbortController();
    let c: PoolConnection | undefined,
      destroyed = false,
      expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      expired = true;
      abort.abort();
      if (c && !destroyed) {
        destroyed = true;
        c.destroy();
      }
    };
    let validUntil = Number.POSITIVE_INFINITY;
    const check = () => {
      if (expired || performance.now() >= end || Date.now() >= validUntil) {
        stop();
        throw new ExternalMcpError("EXTERNAL_MCP_AUTH_EXPIRED", 403);
      }
    };
    const work = (async () => {
      try {
        c = await this.pool.getConnection();
        c.on("error", stop);
        c.on("end", stop);
        check();
        await c.query("SET SESSION innodb_lock_wait_timeout=2, SESSION lock_wait_timeout=2");
        check();
        await c.beginTransaction();
        await this.ownership.assert(c);
        check();
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT ownerId,workspaceId,version,disabled,credentialRef,approvedTools,executionHostId FROM external_mcp_connection WHERE id=? AND ownerId=? FOR SHARE",
          [conn.id, who.ownerId],
        );
        check();
        const row = rows[0];
        if (requireHost && row?.executionHostId !== this.executionHostId)
          throw new ExternalMcpError("EXTERNAL_MCP_EXECUTION_HOST_CHANGED", 409);
        if (
          !row ||
          row.disabled ||
          row.workspaceId !== conn.workspaceId ||
          Number(row.version) !== conn.version ||
          row.credentialRef !== conn.credentialRef ||
          conn.ownerId !== who.ownerId
        )
          throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        if (!(await workspaceReferenceActive(c, who.ownerId, conn.workspaceId)))
          throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
        check();
        if (tool) {
          const approvals = approvalsSchema.parse(JSON.parse(String(row.approvedTools)));
          if (
            !approvals.some(
              (v) => v.name === tool.name && v.hash === tool.hash && v.sessionId === tool.sessionId,
            )
          )
            throw new ExternalMcpError("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
        }
        for (const session of new Set([
          who.sessionId,
          ...otherSessions,
          ...(tool ? [tool.sessionId] : []),
        ])) {
          const until = await authSessionReferenceDeadline(c, who.ownerId, session);
          check();
          if (until === undefined) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
          validUntil = Math.min(validUntil, until);
        }
        check();
        const value = await action(
          check,
          AbortSignal.any([
            abort.signal,
            AbortSignal.timeout(Math.max(1, Math.floor(validUntil - Date.now()))),
          ]),
          () => Math.max(0, Math.min(end - performance.now(), validUntil - Date.now())),
        );
        check();
        await c.commit();
        check();
        return value;
      } catch (error) {
        if (c && !destroyed) {
          try {
            await c.rollback();
          } catch {
            destroyed = true;
            c.destroy();
          }
        }
        throw error;
      } finally {
        abort.abort();
        c?.off("error", stop);
        c?.off("end", stop);
        if (c && !destroyed) c.release();
        if (!destroyed) this.outstanding--;
      }
    })();
    const timeout = new Promise<never>((_yes, no) => {
      timer = setTimeout(() => {
        stop();
        no(new ExternalMcpError("EXTERNAL_MCP_AUTH_TIMEOUT", 503));
      }, 5000);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
