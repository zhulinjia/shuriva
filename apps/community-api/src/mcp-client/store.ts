import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { authSessionReferenceDeadline, type SessionIdentity } from "../auth/public.js";
import { workspaceReferenceActive } from "../workspaces.js";
import { MetadataDatabase, type MetadataSession } from "./metadata.js";
import {
  approvalsSchema,
  type CallRecord,
  type StoredCallState,
  type Connection,
  type ConnectionReference,
  storedCallStates,
  connectionConfig,
  ExternalMcpError,
  type ToolSnapshot,
  toolSnapshotSchema,
} from "./model.js";
import { digest } from "./tool-policy.js";

function textJson(raw: unknown): unknown {
  if (typeof raw !== "string") throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_INVALID", 503);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_INVALID", 503);
  }
}
function connectionReference(r: RowDataPacket): ConnectionReference {
  return {
    id: String(r.id),
    ownerId: String(r.ownerId),
    workspaceId: String(r.workspaceId),
    name: String(r.name),
    version: z.number().int().positive().parse(Number(r.version)),
    credentialRef: z.string().uuid().parse(r.credentialRef),
    disabled: !!r.disabled,
  };
}
function decodeConnection(
  r: RowDataPacket,
  config = connectionConfig.parse(textJson(r.config)),
): Connection {
  const snap = textJson(r.snapshot),
    approved = textJson(r.approvedTools);
  if (!Array.isArray(snap) || !Array.isArray(approved))
    throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_INVALID", 503);
  // Snapshot is written only after bounded validation; validate its shape again
  // at the application boundary before using a tool or compiling its schema.
  return {
    ...connectionReference(r),
    executionHostId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(r.executionHostId),
    config,
    snapshot: z.array(toolSnapshotSchema).max(100).parse(snap),
    snapshotHash: r.snapshotHash === null ? null : String(r.snapshotHash),
    approvedTools: approvalsSchema.parse(approved),
    installationHash: r.installationHash === null ? null : String(r.installationHash),
  };
}
function decodeCall(r: RowDataPacket): CallRecord {
  return {
    id: String(r.id),
    ownerId: String(r.ownerId),
    connectionId: String(r.connectionId),
    version: Number(r.version),
    tool: String(r.tool),
    toolHash: String(r.toolHash),
    state: z.enum(storedCallStates).parse(r.state),
    sessionId: String(r.sessionId),
    bootId: String(r.bootId),
    commitment: String(r.commitment),
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    acknowledged: !!r.acknowledged,
  };
}
export class ExternalMcpStore {
  readonly metadata: MetadataDatabase;
  constructor(readonly pool: Pool) {
    this.metadata = new MetadataDatabase(pool);
  }
  private transaction<T>(
    owner: string,
    action: (c: MetadataSession) => Promise<T>,
    assert: () => void = () => {},
  ) {
    return this.metadata.transaction(async (c) => {
      await c.execute("INSERT IGNORE INTO external_mcp_owner(ownerId) VALUES(?)", [owner]);
      await c.execute("SELECT ownerId FROM external_mcp_owner WHERE ownerId=? FOR UPDATE", [owner]);
      return action(c);
    }, assert);
  }
  async list(owner: string, workspace: string) {
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      "SELECT * FROM external_mcp_connection WHERE ownerId=? AND workspaceId=? ORDER BY id LIMIT 101",
      [owner, workspace],
    );
    return rows.map((row) => {
      const stored = textJson(row.config);
      const config = connectionConfig.safeParse(stored);
      return config.success
        ? decodeConnection(row, config.data)
        : { ...connectionReference(row), config: null, cleanupRequired: stored !== null };
    });
  }
  async connection(owner: string, id: string) {
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      "SELECT * FROM external_mcp_connection WHERE ownerId=? AND id=?",
      [owner, id],
    );
    const r = rows[0];
    if (!r) throw new ExternalMcpError("EXTERNAL_MCP_NOT_FOUND", 404);
    const config = connectionConfig.safeParse(textJson(r.config));
    if (!config.success) throw new ExternalMcpError("EXTERNAL_MCP_URL_REJECTED", 409);
    return decodeConnection(r, config.data);
  }
  async connectionReference(owner: string, id: string) {
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      "SELECT id,ownerId,workspaceId,name,disabled,version,credentialRef FROM external_mcp_connection WHERE ownerId=? AND id=?",
      [owner, id],
    );
    if (!rows[0]) throw new ExternalMcpError("EXTERNAL_MCP_NOT_FOUND", 404);
    return connectionReference(rows[0]);
  }
  async create(
    owner: string,
    workspace: string,
    name: string,
    config: Connection["config"],
    executionHostId: string,
    id: string,
    ref: string,
  ) {
    return this.transaction(owner, async (c) => {
      const [count] = await c.execute<RowDataPacket[]>(
        "SELECT COUNT(*) total FROM external_mcp_connection WHERE ownerId=?",
        [owner],
      );
      if (Number(count[0]?.total) >= 100)
        throw new ExternalMcpError("EXTERNAL_MCP_CONNECTION_LIMIT", 429);
      const [staged] = await c.execute<RowDataPacket[]>(
        "SELECT ref FROM external_mcp_secret_gc WHERE ownerId=? AND ref=? AND executionHostId=? AND connectionId IS NULL AND notBefore>UTC_TIMESTAMP(3) FOR UPDATE",
        [owner, ref, executionHostId],
      );
      if (!staged.length) throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_STAGE_EXPIRED", 409);
      await c.execute(
        "INSERT INTO external_mcp_connection(id,ownerId,workspaceId,name,config,executionHostId,version,credentialRef,disabled,snapshot,approvedTools,createdAt,updatedAt) VALUES(?,?,?,?,?,?,1,?,0,'[]','[]',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [id, owner, workspace, name, JSON.stringify(config), executionHostId, ref],
      );
      await c.execute("DELETE FROM external_mcp_secret_gc WHERE ownerId=? AND ref=?", [owner, ref]);
      return id;
    });
  }
  async disable(reference: ConnectionReference, who: SessionIdentity) {
    const { ownerId: owner, id, workspaceId, version } = reference;
    if (who.ownerId !== owner) throw new ExternalMcpError("EXTERNAL_MCP_NOT_FOUND", 404);
    let until = Number.POSITIVE_INFINITY;
    const check = () => {
      if (Date.now() >= until) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
    };
    await this.transaction(
      owner,
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT credentialRef,executionHostId,config FROM external_mcp_connection WHERE ownerId=? AND id=? AND workspaceId=? AND version=? FOR UPDATE",
          [owner, id, workspaceId, version],
        );
        if (!rows[0]) throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        if (!(await workspaceReferenceActive(c, owner, workspaceId)))
          throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
        const deadline = await authSessionReferenceDeadline(c, owner, who.sessionId);
        if (deadline === undefined) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
        until = deadline;
        const redact = !connectionConfig.safeParse(textJson(rows[0].config)).success;
        await c.execute(
          "UPDATE external_mcp_connection SET disabled=1,version=version+1,approvedTools='[]',config=IF(?,CAST('null' AS JSON),config),updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=?",
          [redact ? 1 : 0, owner, id],
        );
        await c.execute(
          "INSERT INTO external_mcp_secret_gc(ref,ownerId,executionHostId,connectionId,notBefore) VALUES(?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE connectionId=VALUES(connectionId),notBefore=VALUES(notBefore)",
          [rows[0].credentialRef, owner, rows[0].executionHostId, id],
        );
      },
      check,
    );
  }
  async stageCredential(owner: string, ref: string, executionHostId: string) {
    await this.transaction(owner, async (c) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT COUNT(*) total FROM external_mcp_secret_gc WHERE ownerId=?",
        [owner],
      );
      if (Number(rows[0]?.total) >= 100)
        throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_CAPACITY", 503);
      await c.execute(
        "INSERT INTO external_mcp_secret_gc(ref,ownerId,executionHostId,notBefore) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE))",
        [ref, owner, executionHostId],
      );
    });
  }
  async changedCredential(
    owner: string,
    id: string,
    version: number,
    ref: string,
    who: SessionIdentity,
    assert: () => void = () => {},
  ) {
    let until = Number.POSITIVE_INFINITY;
    const check = () => {
      assert();
      if (Date.now() >= until) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
    };
    await this.transaction(
      owner,
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT credentialRef,executionHostId,workspaceId FROM external_mcp_connection WHERE ownerId=? AND id=? AND version=? AND disabled=0 FOR UPDATE",
          [owner, id, version],
        );
        if (!rows[0]) throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        const [staged] = await c.execute<RowDataPacket[]>(
          "SELECT ref FROM external_mcp_secret_gc WHERE ownerId=? AND ref=? AND notBefore>UTC_TIMESTAMP(3) FOR UPDATE",
          [owner, ref],
        );
        if (!staged.length)
          throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_STAGE_EXPIRED", 409);
        {
          if (who.ownerId !== owner)
            throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
          if (!(await workspaceReferenceActive(c, owner, String(rows[0].workspaceId))))
            throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
          const deadline = await authSessionReferenceDeadline(c, owner, who.sessionId);
          if (deadline === undefined)
            throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
          until = deadline;
          check();
        }
        await c.execute(
          "UPDATE external_mcp_connection SET credentialRef=?,version=version+1,approvedTools='[]',updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=?",
          [ref, owner, id],
        );
        await c.execute("DELETE FROM external_mcp_secret_gc WHERE ref=?", [ref]);
        await c.execute(
          "INSERT INTO external_mcp_secret_gc(ref,ownerId,executionHostId,connectionId,notBefore) VALUES(?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE connectionId=VALUES(connectionId),notBefore=VALUES(notBefore)",
          [rows[0].credentialRef, owner, rows[0].executionHostId, id],
        );
      },
      check,
    );
  }
  async cleanupCredentials(
    executionHostId: string,
    remove: (ref: string) => void,
    published: (ref: string) => boolean,
  ) {
    let vaultFailed = false;
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      "SELECT ownerId,ref FROM external_mcp_secret_gc WHERE executionHostId=? AND notBefore<=UTC_TIMESTAMP(3) ORDER BY notBefore LIMIT 16",
      [executionHostId],
    );
    for (const row of rows) {
      const owner = z.string().min(1).max(36).parse(row.ownerId),
        ref = z.string().uuid().parse(row.ref);
      await this.transaction(owner, async (c) => {
        const [due] = await c.execute<RowDataPacket[]>(
          "SELECT ref,connectionId FROM external_mcp_secret_gc WHERE ownerId=? AND ref=? AND notBefore<=UTC_TIMESTAMP(3) FOR UPDATE",
          [owner, ref],
        );
        if (!due.length) return;
        const [active] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM external_mcp_connection WHERE ownerId=? AND credentialRef=? AND disabled=0 FOR SHARE",
          [owner, ref],
        );
        if (active.length) return;
        const postpone = () =>
          c.execute(
            "UPDATE external_mcp_secret_gc SET notBefore=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE ref=?",
            [ref],
          );
        try {
          // An absent retired record contains no secret to retain. Do not let
          // repeated failed publications exhaust the bounded staging queue.
          if (!published(ref)) {
            await c.execute("DELETE FROM external_mcp_secret_gc WHERE ref=?", [ref]);
            return;
          }
          // A selected empty reference is a failed publication, never proof that the
          // previous known credential can be erased. There is no automatic fallback.
          if (due[0]?.connectionId) {
            const [current] = await c.execute<RowDataPacket[]>(
              "SELECT credentialRef,disabled FROM external_mcp_connection WHERE ownerId=? AND id=? FOR SHARE",
              [owner, z.string().uuid().parse(due[0].connectionId)],
            );
            if (
              current[0] &&
              !current[0].disabled &&
              !published(z.string().uuid().parse(current[0].credentialRef))
            ) {
              await postpone();
              return;
            }
          }
          remove(ref);
          await c.execute("DELETE FROM external_mcp_secret_gc WHERE ref=?", [ref]);
        } catch (error) {
          if (
            !(error instanceof ExternalMcpError) ||
            error.code !== "EXTERNAL_MCP_VAULT_UNAVAILABLE"
          )
            throw error;
          vaultFailed = true;
          await postpone();
        }
      });
    }
    if (vaultFailed) throw new ExternalMcpError("EXTERNAL_MCP_VAULT_UNAVAILABLE", 503);
  }
  async discovery(
    owner: string,
    id: string,
    version: number,
    tools: ToolSnapshot[],
    installationHash: string | null,
    who: SessionIdentity,
    assert: () => void = () => {},
  ) {
    const hash = digest(tools);
    let until = Number.POSITIVE_INFINITY;
    const check = () => {
      assert();
      if (Date.now() >= until) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
    };
    await this.transaction(
      owner,
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT * FROM external_mcp_connection WHERE id=? AND ownerId=? AND version=? AND disabled=0 FOR UPDATE",
          [id, owner, version],
        );
        if (!rows[0]) throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        const current = decodeConnection(rows[0]);
        if (
          who.ownerId !== owner ||
          !(await workspaceReferenceActive(c, owner, current.workspaceId))
        )
          throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
        const deadline = await authSessionReferenceDeadline(c, owner, who.sessionId);
        if (deadline === undefined) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
        until = deadline;
        check();
        const changed =
          hash !== current.snapshotHash || installationHash !== current.installationHash;
        await c.execute(
          `UPDATE external_mcp_connection SET snapshot=?,snapshotHash=?,installationHash=?,approvedTools=${changed ? "'[]'" : "approvedTools"},updatedAt=UTC_TIMESTAMP(3) WHERE id=? AND ownerId=? AND version=?`,
          [JSON.stringify(tools), hash, installationHash, id, owner, version],
        );
      },
      check,
    );
    return hash;
  }
  async revokeTools(owner: string, id: string, version: number, who: SessionIdentity) {
    if (who.ownerId !== owner) throw new ExternalMcpError("EXTERNAL_MCP_NOT_FOUND", 404);
    let until = Number.POSITIVE_INFINITY;
    const check = () => {
      if (Date.now() >= until) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
    };
    await this.transaction(
      owner,
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT workspaceId FROM external_mcp_connection WHERE id=? AND ownerId=? AND version=? AND disabled=0 FOR UPDATE",
          [id, owner, version],
        );
        if (!rows[0]) throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        if (!(await workspaceReferenceActive(c, owner, String(rows[0].workspaceId))))
          throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
        const deadline = await authSessionReferenceDeadline(c, owner, who.sessionId);
        if (deadline === undefined) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
        until = deadline;
        check();
        await c.execute(
          "UPDATE external_mcp_connection SET approvedTools='[]',updatedAt=UTC_TIMESTAMP(3) WHERE id=? AND ownerId=? AND version=?",
          [id, owner, version],
        );
      },
      check,
    );
  }
  async approveTools(
    owner: string,
    id: string,
    version: number,
    hash: string,
    tools: Connection["approvedTools"],
    who: SessionIdentity,
    assert: () => void,
  ) {
    let until = Number.POSITIVE_INFINITY;
    const check = () => {
      assert();
      if (Date.now() >= until) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
    };
    await this.transaction(
      owner,
      async (c) => {
        const [rows] = await c.execute<RowDataPacket[]>(
          "SELECT workspaceId FROM external_mcp_connection WHERE id=? AND ownerId=? AND version=? AND snapshotHash=? AND disabled=0 FOR UPDATE",
          [id, owner, version, hash],
        );
        if (!rows[0] || who.ownerId !== owner)
          throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        if (!(await workspaceReferenceActive(c, owner, String(rows[0].workspaceId))))
          throw new ExternalMcpError("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
        const deadline = await authSessionReferenceDeadline(c, owner, who.sessionId);
        if (deadline === undefined) throw new ExternalMcpError("EXTERNAL_MCP_SESSION_EXPIRED", 403);
        until = deadline;
        check();
        await c.execute(
          "UPDATE external_mcp_connection SET approvedTools=?,updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=? AND version=? AND snapshotHash=? AND disabled=0",
          [JSON.stringify(tools), owner, id, version, hash],
        );
      },
      check,
    );
  }
  async call(owner: string, id: string) {
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      "SELECT * FROM external_mcp_call WHERE ownerId=? AND id=?",
      [owner, id],
    );
    return rows[0] ? decodeCall(rows[0]) : null;
  }
  async calls(owner: string, connectionId: string) {
    const [rows] = await this.metadata.execute<RowDataPacket[]>(
      // Every admission blocker must remain reachable as newer entries are acknowledged.
      "SELECT * FROM external_mcp_call WHERE ownerId=? AND connectionId=? ORDER BY CASE WHEN state='outcome_unknown' AND acknowledged=0 THEN 0 ELSE 1 END,createdAt DESC,id DESC LIMIT 50",
      [owner, connectionId],
    );
    return rows.map(decodeCall);
  }
  async prepareCall(
    row: Omit<CallRecord, "state" | "createdAt" | "updatedAt" | "acknowledged">,
    assert: () => void,
  ) {
    await this.transaction(
      row.ownerId,
      async (c) => {
        const [conn] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM external_mcp_connection WHERE id=? AND ownerId=? AND version=? AND disabled=0 FOR UPDATE",
          [row.connectionId, row.ownerId, row.version],
        );
        if (!conn.length) throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
        const [unknown] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM external_mcp_call WHERE ownerId=? AND connectionId=? AND state='outcome_unknown' AND acknowledged=0 LIMIT 1",
          [row.ownerId, row.connectionId],
        );
        if (unknown.length) throw new ExternalMcpError("EXTERNAL_MCP_UNKNOWN_CALL_PENDING", 409);
        const [count] = await c.execute<RowDataPacket[]>(
          "SELECT COUNT(*) total FROM external_mcp_call WHERE ownerId=? AND (slot IS NOT NULL OR (state='outcome_unknown' AND acknowledged=0))",
          [row.ownerId],
        );
        if (Number(count[0]?.total) >= 16)
          throw new ExternalMcpError("EXTERNAL_MCP_CALL_CAPACITY", 429);
        await c.execute(
          "INSERT INTO external_mcp_call(id,ownerId,connectionId,version,tool,toolHash,state,sessionId,bootId,commitment,slot,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'pending_approval',?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
          [
            row.id,
            row.ownerId,
            row.connectionId,
            row.version,
            row.tool,
            row.toolHash,
            row.sessionId,
            row.bootId,
            row.commitment,
            row.connectionId,
          ],
        );
      },
      assert,
    );
  }
  async start(owner: string, id: string, version: number) {
    const [r] = await this.metadata.execute<ResultSetHeader>(
      "UPDATE external_mcp_call SET state='running',updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=? AND version=? AND state='pending_approval'",
      [owner, id, version],
    );
    return r.affectedRows === 1;
  }
  async terminal(owner: string, id: string, state: StoredCallState) {
    await this.metadata.execute(
      "UPDATE external_mcp_call SET state=?,slot=IF(?='outcome_unknown',slot,NULL),updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=? AND (state IN ('pending_approval','running','cancel_requested') OR (state='result_retained' AND ? IN ('succeeded','failed','outcome_unknown')))",
      [state, state, owner, id, state],
    );
  }
  async acknowledge(owner: string, id: string) {
    await this.metadata.execute(
      "UPDATE external_mcp_call SET acknowledged=1,slot=NULL,updatedAt=UTC_TIMESTAMP(3) WHERE ownerId=? AND id=? AND state='outcome_unknown'",
      [owner, id],
    );
  }
  async recover(boot: string) {
    await this.metadata.execute(
      "UPDATE external_mcp_call SET slot=IF(state='pending_approval',NULL,slot),state=IF(state='pending_approval','expired','outcome_unknown'),updatedAt=UTC_TIMESTAMP(3) WHERE bootId<>? AND state IN ('pending_approval','running','cancel_requested','result_retained')",
      [boot],
    );
  }
}
