import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { delegatedTablesSchema, McpError, type GrantInput, type GrantView } from "./model.js";
import type { InvocationCleanupIntent } from "./invocation-cleanup.js";

type SessionDeadline = (
  c: PoolConnection,
  owner: string,
  session: string,
) => Promise<number | undefined>;
function grant(row: RowDataPacket): GrantView {
  const decode = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
  const scopes = decode(row.scopes);
  if (!Array.isArray(scopes) || scopes.some((s: unknown) => typeof s !== "string"))
    throw new McpError("MCP_STORAGE_INVALID", 503);
  return {
    id: row.id,
    ownerId: row.ownerId,
    clientId: row.clientId,
    approvalSessionId: row.approvalSessionId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    connectorId: row.connectorId,
    tables: delegatedTablesSchema.parse(decode(row.tables)),
    scopes,
    generation: Number(row.generation),
    expiresAt: new Date(row.expiresAt).getTime(),
    revoked: row.revokedAt !== null,
  };
}
/** MCP-owned persistence only; authentication/session and data bindings use public ports. */
export class McpStore {
  constructor(
    readonly pool: Pool,
    private readonly sessionDeadline: SessionDeadline,
  ) {}
  async transaction<T>(work: (c: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection();
    let broken = false;
    try {
      await c.query("SET SESSION lock_wait_timeout=2, SESSION innodb_lock_wait_timeout=2");
      await c.beginTransaction();
      const value = await work(c);
      await c.commit();
      return value;
    } catch (error) {
      try {
        await c.rollback();
      } catch {
        broken = true;
        c.destroy();
      }
      throw error;
    } finally {
      if (!broken) c.release();
    }
  }
  async clients(owner: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT clientId,name,redirectUri,mode,disabled FROM mcp_client WHERE ownerId=? ORDER BY disabled,createdAt DESC LIMIT 101",
      [owner],
    );
    return rows.map((r) => ({
      clientId: String(r.clientId),
      name: String(r.name),
      redirectUri: String(r.redirectUri),
      mode: String(r.mode),
      disabled: !!r.disabled,
    }));
  }
  async client(owner: string, id: string) {
    return (await this.clients(owner)).find((c) => c.clientId === id && !c.disabled);
  }
  async approvedCallback(id: string, redirectUri: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT clientId FROM mcp_client WHERE clientId=? AND redirectUri=? AND disabled=0",
      [id, redirectUri],
    );
    return rows.length === 1;
  }
  async registerClient(
    owner: string,
    value: { clientId: string; name: string; redirectUri: string; mode: string },
  ) {
    if ((await this.clients(owner)).filter((c) => !c.disabled).length >= 100)
      throw new McpError("MCP_CLIENT_CAPACITY", 429);
    // A local user trust domain has exactly one active identity, not per-app isolation.
    if (
      value.mode === "local_domain" &&
      (await this.clients(owner)).some((c) => c.mode === "local_domain" && !c.disabled)
    )
      throw new McpError("MCP_LOCAL_DOMAIN_EXISTS", 409);
    await this.transaction(async (c) => {
      if (value.mode === "local_domain")
        await c.execute("INSERT INTO mcp_local_domain(ownerId,clientId) VALUES (?,?)", [
          owner,
          value.clientId,
        ]);
      await c.execute(
        "INSERT INTO mcp_client (clientId,ownerId,name,redirectUri,mode,disabled,createdAt) VALUES (?,?,?,?,?,0,UTC_TIMESTAMP(3))",
        [value.clientId, owner, value.name, value.redirectUri, value.mode],
      );
    });
  }
  async grants(owner: string): Promise<GrantView[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM mcp_grant WHERE ownerId=? ORDER BY (revokedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)) DESC,createdAt DESC LIMIT 101",
      [owner],
    );
    return rows.map(grant);
  }
  async disableClient(owner: string, id: string) {
    await this.transaction(async (c) => {
      await c.execute("UPDATE mcp_client SET disabled=1 WHERE ownerId=? AND clientId=?", [
        owner,
        id,
      ]);
      await c.execute(
        "UPDATE mcp_grant SET revokedAt=COALESCE(revokedAt,UTC_TIMESTAMP(3)),generation=generation+1 WHERE ownerId=? AND clientId=? AND revokedAt IS NULL",
        [owner, id],
      );
      await c.execute("DELETE FROM mcp_local_domain WHERE ownerId=? AND clientId=?", [owner, id]);
    });
  }
  async createGrant(
    owner: string,
    session: string,
    input: GrantInput,
    connectorId: string,
    resource: string,
  ) {
    return this.transaction(async (c) => {
      const end = await this.sessionDeadline(c, owner, session);
      if (!end) throw new McpError("MCP_SESSION_EXPIRED", 401);
      const [clients] = await c.execute<RowDataPacket[]>(
        "SELECT clientId FROM mcp_client WHERE clientId=? AND ownerId=? AND disabled=0 FOR UPDATE",
        [input.clientId, owner],
      );
      if (clients.length !== 1) throw new McpError("MCP_CLIENT_NOT_FOUND", 404);
      const [counts] = await c.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM mcp_grant WHERE ownerId=? AND revokedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3)",
        [owner],
      );
      if (Number(counts[0]?.total) >= 100) throw new McpError("MCP_GRANT_CAPACITY", 429);
      await c.execute(
        "UPDATE mcp_grant SET revokedAt=COALESCE(revokedAt,UTC_TIMESTAMP(3)),generation=generation+1 WHERE ownerId=? AND clientId=? AND revokedAt IS NULL",
        [owner, input.clientId],
      );
      const id = randomUUID(),
        expiresAt = Math.min(end, Date.now() + input.durationMinutes * 60000);
      await c.execute(
        "INSERT INTO mcp_grant (id,ownerId,clientId,approvalSessionId,resource,generation,expiresAt,createdAt,workspaceId,sourceId,connectorId,tables,scopes) VALUES (?,?,?,?,?,1,?,UTC_TIMESTAMP(3),?,?,?,?,?)",
        [
          id,
          owner,
          input.clientId,
          session,
          resource,
          new Date(expiresAt),
          input.workspaceId,
          input.sourceId,
          connectorId,
          JSON.stringify(input.tables),
          JSON.stringify(input.scopes),
        ],
      );
      return id;
    });
  }
  async active(owner: string, id: string): Promise<GrantView> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM mcp_grant WHERE ownerId=? AND id=?",
      [owner, id],
    );
    const result = rows[0] ? grant(rows[0]) : undefined;
    if (!result || result.revoked || result.expiresAt <= Date.now())
      throw new McpError("MCP_GRANT_REJECTED", 403);
    return result;
  }
  async revoke(owner: string, id: string) {
    const [r] = await this.pool.execute<ResultSetHeader>(
      "UPDATE mcp_grant SET revokedAt=COALESCE(revokedAt,UTC_TIMESTAMP(3)),generation=generation+1 WHERE id=? AND ownerId=?",
      [id, owner],
    );
    if (!r.affectedRows) throw new McpError("MCP_GRANT_NOT_FOUND", 404);
  }
  async bindCode(owner: string, id: string, generation: number, code: string) {
    const current = await this.active(owner, id);
    if (current.generation !== generation) throw new McpError("MCP_GRANT_CHANGED", 403);
    await this.pool.execute(
      "INSERT INTO mcp_code (codeHash,grantId,generation,expiresAt,used) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE),0)",
      [hash(code), id, generation],
    );
  }
  async claimCode(
    code: string,
    admit?: (binding: { grantId: string; generation: number }) => void,
  ) {
    return this.transaction(async (c) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT codeHash,grantId,generation FROM mcp_code WHERE codeHash=? AND used=0 AND expiresAt>UTC_TIMESTAMP(3) FOR UPDATE",
        [hash(code)],
      );
      if (rows.length !== 1) throw new McpError("MCP_CODE_REJECTED", 400);
      admit?.({ grantId: String(rows[0]?.grantId), generation: Number(rows[0]?.generation) });
      await c.execute("UPDATE mcp_code SET used=1 WHERE codeHash=?", [hash(code)]);
      return { grantId: String(rows[0]?.grantId), generation: Number(rows[0]?.generation) };
    });
  }
  async bindToken(token: string, binding: { grantId: string; generation: number }) {
    await this.transaction(async (c) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT * FROM mcp_grant WHERE id=? AND revokedAt IS NULL AND generation=? AND expiresAt>UTC_TIMESTAMP(3) FOR SHARE",
        [binding.grantId, binding.generation],
      );
      const r = rows[0];
      if (!r || !(await this.sessionDeadline(c, String(r.ownerId), String(r.approvalSessionId))))
        throw new McpError("MCP_GRANT_REJECTED", 403);
      await c.execute(
        "INSERT INTO mcp_grant_token (tokenHash,grantId,issuedGeneration) VALUES (?,?,?)",
        [hash(token), binding.grantId, binding.generation],
      );
    });
  }
  async invocations(owner: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT id,grantId,generation,tool,state,createdAt,expiresAt FROM mcp_invocation WHERE ownerId=? ORDER BY createdAt DESC LIMIT 100",
      [owner],
    );
    return rows;
  }
  async invocation(owner: string, id: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM mcp_invocation WHERE ownerId=? AND id=?",
      [owner, id],
    );
    return rows[0] ?? null;
  }
  async reserve(
    owner: string,
    grantId: string,
    generation: number,
    id: string,
    commitment: string,
    boot: string,
    tool: string,
  ) {
    await this.transaction(async (c) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT id FROM mcp_grant WHERE ownerId=? AND id=? AND generation=? AND revokedAt IS NULL AND expiresAt>UTC_TIMESTAMP(3) FOR UPDATE",
        [owner, grantId, generation],
      );
      if (rows.length !== 1) throw new McpError("MCP_GRANT_REJECTED", 403);
      const [count] = await c.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM mcp_invocation WHERE state IN ('pending_approval','running') AND expiresAt>UTC_TIMESTAMP(3)",
        [],
      );
      if (Number(count[0]?.total) >= 128) throw new McpError("MCP_INVOCATION_CAPACITY", 429);
      await c.execute(
        "INSERT INTO mcp_invocation (id,ownerId,grantId,generation,commitment,bootId,tool,state,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,'pending_approval',UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE))",
        [id, owner, grantId, generation, commitment, boot, tool],
      );
    });
  }
  async transition(
    owner: string,
    id: string,
    from: string,
    state: string,
    session: string | null = null,
  ) {
    const [r] = await this.pool.execute<ResultSetHeader>(
      "UPDATE mcp_invocation SET state=?,approvalSessionId=COALESCE(?,approvalSessionId) WHERE id=? AND ownerId=? AND state=?",
      [state, session, id, owner, from],
    );
    return r.affectedRows === 1;
  }
  async recoverInvocations(boot: string) {
    await this.pool.execute(
      "UPDATE mcp_invocation SET state=CASE WHEN state='pending_approval' THEN 'expired' ELSE 'outcome_unknown' END WHERE bootId<>? AND state IN ('pending_approval','running')",
      [boot],
    );
  }
  async finishInvocation(intent: InvocationCleanupIntent) {
    await this.pool.execute(
      "UPDATE mcp_invocation SET state=CASE state WHEN 'pending_approval' THEN ? ELSE ? END,approvalSessionId=COALESCE(?,approvalSessionId) WHERE ownerId=? AND id=? AND grantId=? AND generation=? AND bootId=? AND commitment=? AND state IN ('pending_approval','running')",
      [
        intent.pending,
        intent.running,
        intent.approvalSessionId,
        intent.ownerId,
        intent.id,
        intent.grantId,
        intent.generation,
        intent.bootId,
        intent.commitment,
      ],
    );
  }
  async bindJob(owner: string, id: string, session: string, taskId: string, taskNonce: string) {
    const [r] = await this.pool.execute<ResultSetHeader>(
      "UPDATE mcp_invocation SET state='running',approvalSessionId=?,taskId=?,taskNonce=? WHERE ownerId=? AND id=? AND state='pending_approval' AND expiresAt>UTC_TIMESTAMP(3)",
      [session, taskId, taskNonce, owner, id],
    );
    return r.affectedRows === 1;
  }
  /** Active grants keep invocation tombstones throughout their lifetime. */
  async pruneMetadata() {
    await this.transaction(async (c) => {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT id FROM mcp_grant WHERE (revokedAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY) OR expiresAt<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 7 DAY)) LIMIT 100 FOR UPDATE",
      );
      const ids = rows.map((r) => String(r.id));
      if (!ids.length) return;
      const marks = ids.map(() => "?").join(",");
      await c.execute(`DELETE FROM mcp_invocation WHERE grantId IN (${marks})`, ids);
      await c.execute(`DELETE FROM mcp_code WHERE grantId IN (${marks})`, ids);
      await c.execute(`DELETE FROM mcp_grant_token WHERE grantId IN (${marks})`, ids);
      await c.execute(`DELETE FROM mcp_grant WHERE id IN (${marks})`, ids);
    });
  }
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
