import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { DataSourceError } from "./errors.js";
import type { BoundSnapshot, BoundSourceAccess, SourceBindingIdentity } from "./public.js";
import { validateSnapshot } from "./snapshot.js";

export { DataSourceError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validId = (value: string): boolean => UUID.test(value);
export function validSourceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 120 &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}
interface SourceRow extends RowDataPacket {
  id: string;
  connectorId: string;
  name: string;
  createdAt: Date;
}
interface BindingRow extends SourceRow {
  isDefault: number;
  scanStatus: string | null;
  errorCode: string | null;
}
interface ScanRow extends RowDataPacket {
  id: string;
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
  status: string;
  expiresAt: Date;
  nonce: string;
  issuedAt: number;
  expiresUnix: number;
}
interface SnapshotRow extends RowDataPacket {
  id: string;
  version: string;
  contentHash: string;
  content: unknown;
  createdAt: Date;
}

const bindingProjection =
  "SELECT s.id, s.connectorId, s.name, s.createdAt, (d.sourceId IS NOT NULL) AS isDefault, CASE WHEN sc.status = 'pending' AND sc.expiresAt <= UTC_TIMESTAMP(3) THEN 'expired' ELSE sc.status END AS scanStatus, sc.errorCode FROM workspace_data_source b JOIN workspace w ON w.id = b.workspaceId JOIN data_source s ON s.id = b.sourceId LEFT JOIN workspace_default_source d ON d.workspaceId = b.workspaceId AND d.sourceId = b.sourceId LEFT JOIN schema_scan sc ON sc.id = (SELECT lastScan.id FROM schema_scan lastScan WHERE lastScan.workspaceId = b.workspaceId AND lastScan.sourceId = b.sourceId ORDER BY lastScan.`sequence` DESC LIMIT 1) WHERE w.id = ? AND w.createdByAccountId = ? AND w.archivedAt IS NULL AND s.ownerId = ?";

export class DataSourceStore implements BoundSourceAccess {
  constructor(
    private readonly pool: Pool,
    private readonly bindingIdentities = false,
  ) {}

  private async transaction<T>(
    fn: (connection: PoolConnection) => Promise<T>,
    boundedLockWait = false,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let previousLockWait: number | undefined;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      if (boundedLockWait) {
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT @@SESSION.innodb_lock_wait_timeout AS timeout",
        );
        const timeout = Number(rows[0]?.timeout);
        if (!Number.isInteger(timeout) || timeout < 1) throw new DataSourceError("NOT_FOUND");
        previousLockWait = timeout;
        await connection.query("SET SESSION innodb_lock_wait_timeout=5");
      }
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      outcome = { ok: true, value: result };
    } catch (error) {
      outcome = { ok: false, error };
      try {
        await connection.rollback();
      } catch (rollbackError) {
        outcome = {
          ok: false,
          error: new AggregateError(
            [error, rollbackError],
            "Source transaction and rollback failed",
          ),
        };
      }
    }
    try {
      if (previousLockWait !== undefined) {
        try {
          // mysql2's prepared numeric parameter is DOUBLE; this MySQL integer
          // system variable requires the escaped integer in the text protocol.
          await connection.query("SET SESSION innodb_lock_wait_timeout=?", [previousLockWait]);
        } catch (error) {
          connection.destroy();
          outcome = {
            ok: false,
            error: outcome.ok
              ? error
              : new AggregateError(
                  [outcome.error, error],
                  "Source operation and connection reset failed",
                ),
          };
        }
      }
    } finally {
      connection.release();
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async withBoundSnapshot<T>(
    owner: string,
    workspace: string,
    source: string,
    action: (
      connection: PoolConnection,
      snapshot: BoundSnapshot | null,
      binding: SourceBindingIdentity,
    ) => Promise<T>,
  ): Promise<T> {
    if (!validId(workspace) || !validId(source)) throw new DataSourceError("INVALID");
    return this.transaction(async (connection) => {
      // Keep the same lock order as binding changes and scan publication.
      await this.lockWorkspace(connection, owner, workspace);
      const currentSource = await this.lockSource(connection, owner, source);
      await this.lockBinding(connection, workspace, source);
      const binding = {
        connectorId: currentSource.connectorId,
        bindingGeneration: await this.bindingGeneration(connection, workspace, source),
      };
      const [rows] = await connection.execute<SnapshotRow[]>(
        "SELECT sn.id, sn.content FROM schema_snapshot sn JOIN schema_scan sc ON sc.id=sn.scanId WHERE sn.workspaceId=? AND sn.sourceId=? ORDER BY sc.`sequence` DESC LIMIT 1",
        [workspace, source],
      );
      const row = rows[0];
      if (!row) return action(connection, null, binding);
      const content: unknown =
        typeof row.content === "string" ? JSON.parse(row.content) : row.content;
      validateSnapshot(content);
      return action(connection, { id: row.id, content }, binding);
    });
  }

  /** The callback owns the actual binding locks, including across processes. */
  async withBoundIdentity<T>(
    owner: string,
    workspace: string,
    source: string,
    action: (binding: { connectorId: string; bindingGeneration: string }) => Promise<T>,
  ): Promise<T> {
    if (!this.bindingIdentities || !validId(workspace) || !validId(source))
      throw new DataSourceError("NOT_FOUND");
    return this.transaction(async (c) => {
      await this.lockWorkspace(c, owner, workspace);
      const current = await this.lockSource(c, owner, source);
      await this.lockBinding(c, workspace, source);
      const generation = await this.bindingGeneration(c, workspace, source);
      if (!generation) throw new DataSourceError("NOT_FOUND");
      return action({ connectorId: current.connectorId, bindingGeneration: generation });
    }, true);
  }

  async list(
    ownerId: string,
    archived = false,
    after?: string,
  ): Promise<{ sources: SourceRow[]; nextCursor: string | null }> {
    if (after !== undefined && !validId(after)) throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<SourceRow[]>(
      `SELECT id, connectorId, name, createdAt FROM data_source WHERE ownerId = ? AND archivedAt ${archived ? "IS NOT NULL" : "IS NULL"} AND id > ? ORDER BY id LIMIT 101`,
      [ownerId, after ?? ""],
    );
    const sources = rows.slice(0, 100);
    return { sources, nextCursor: rows.length > 100 ? (sources.at(-1)?.id ?? null) : null };
  }

  async rename(ownerId: string, id: string, name: string): Promise<void> {
    if (!validId(id) || !validSourceName(name)) throw new DataSourceError("INVALID");
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE data_source SET name = ?, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND ownerId = ? AND archivedAt IS NULL",
      [name.trim(), id, ownerId],
    );
    if (!result.affectedRows) throw new DataSourceError("NOT_FOUND");
  }

  async reassign(ownerId: string, id: string, connectorId: string): Promise<void> {
    if (!validId(id) || !validId(connectorId)) throw new DataSourceError("INVALID");
    await this.transaction(async (connection) => {
      await this.lockSource(connection, ownerId, id);
      const [bindings] = await connection.execute<RowDataPacket[]>(
        "SELECT workspaceId FROM workspace_data_source WHERE sourceId = ? LIMIT 1",
        [id],
      );
      if (bindings.length) throw new DataSourceError("CONFLICT");
      await connection.execute(
        "UPDATE schema_scan SET status = 'cancelled', errorCode = 'unbound', finishedAt = UTC_TIMESTAMP(3) WHERE sourceId = ? AND status = 'pending'",
        [id],
      );
      await connection.execute(
        "UPDATE data_source SET connectorId = ?, updatedAt = UTC_TIMESTAMP(3) WHERE id = ?",
        [connectorId, id],
      );
    });
  }

  async archive(ownerId: string, id: string): Promise<void> {
    if (!validId(id)) throw new DataSourceError("INVALID");
    await this.transaction(async (connection) => {
      await this.lockSource(connection, ownerId, id);
      const [bindings] = await connection.execute<RowDataPacket[]>(
        "SELECT workspaceId FROM workspace_data_source WHERE sourceId = ? LIMIT 1",
        [id],
      );
      if (bindings.length) throw new DataSourceError("CONFLICT");
      await connection.execute(
        "UPDATE data_source SET archivedAt = UTC_TIMESTAMP(3), updatedAt = UTC_TIMESTAMP(3) WHERE id = ?",
        [id],
      );
    });
  }

  async restore(ownerId: string, id: string): Promise<void> {
    if (!validId(id)) throw new DataSourceError("INVALID");
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE data_source SET archivedAt = NULL, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND ownerId = ? AND archivedAt IS NOT NULL",
      [id, ownerId],
    );
    if (!result.affectedRows) throw new DataSourceError("NOT_FOUND");
  }

  async cancelWorkspaceScans(connection: PoolConnection, workspaceId: string): Promise<void> {
    await connection.execute(
      "UPDATE schema_scan SET status = 'cancelled', errorCode = 'archived', finishedAt = UTC_TIMESTAMP(3) WHERE workspaceId = ? AND status = 'pending'",
      [workspaceId],
    );
  }

  async create(ownerId: string, id: string, connectorId: string, name: string): Promise<void> {
    if (!validId(id) || !validId(connectorId) || !validSourceName(name))
      throw new DataSourceError("INVALID");
    try {
      await this.pool.execute(
        "INSERT INTO data_source (id, ownerId, connectorId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [id, ownerId, connectorId, name.trim()],
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY")
        throw new DataSourceError("CONFLICT");
      throw error;
    }
  }

  private async lockWorkspace(
    connection: PoolConnection,
    ownerId: string,
    workspaceId: string,
  ): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT id FROM workspace WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NULL FOR UPDATE",
      [workspaceId, ownerId],
    );
    if (rows.length !== 1) throw new DataSourceError("NOT_FOUND");
  }

  private async lockSource(
    connection: PoolConnection,
    ownerId: string,
    sourceId: string,
  ): Promise<SourceRow> {
    const [rows] = await connection.execute<SourceRow[]>(
      "SELECT id, connectorId, name, createdAt FROM data_source WHERE id = ? AND ownerId = ? AND archivedAt IS NULL FOR UPDATE",
      [sourceId, ownerId],
    );
    const source = rows[0];
    if (!source) throw new DataSourceError("NOT_FOUND");
    return source;
  }

  private async lockBinding(
    connection: PoolConnection,
    workspaceId: string,
    sourceId: string,
  ): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT workspaceId FROM workspace_data_source WHERE workspaceId = ? AND sourceId = ? FOR UPDATE",
      [workspaceId, sourceId],
    );
    if (rows.length !== 1) throw new DataSourceError("NOT_FOUND");
  }

  async bind(ownerId: string, workspaceId: string, sourceId: string): Promise<void> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    await this.transaction(async (connection) => {
      await this.lockWorkspace(connection, ownerId, workspaceId);
      await this.lockSource(connection, ownerId, sourceId);
      try {
        await connection.execute(
          "INSERT INTO workspace_data_source (workspaceId, sourceId, boundAt) VALUES (?, ?, UTC_TIMESTAMP(3))",
          [workspaceId, sourceId],
        );
        if (this.bindingIdentities)
          await connection.execute(
            "INSERT INTO source_binding_identity(workspaceId,sourceId,generation) VALUES(?,?,?)",
            [workspaceId, sourceId, randomUUID()],
          );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY")
          throw new DataSourceError("CONFLICT");
        throw error;
      }
    });
  }

  async unbind(ownerId: string, workspaceId: string, sourceId: string): Promise<void> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    await this.transaction(async (connection) => {
      await this.lockWorkspace(connection, ownerId, workspaceId);
      await this.lockSource(connection, ownerId, sourceId);
      await this.lockBinding(connection, workspaceId, sourceId);
      await connection.execute(
        "UPDATE schema_scan SET status = 'cancelled', errorCode = 'unbound', finishedAt = UTC_TIMESTAMP(3) WHERE workspaceId = ? AND sourceId = ? AND status = 'pending'",
        [workspaceId, sourceId],
      );
      await connection.execute(
        "DELETE FROM workspace_data_source WHERE workspaceId = ? AND sourceId = ?",
        [workspaceId, sourceId],
      );
    });
  }

  async setDefault(ownerId: string, workspaceId: string, sourceId: string): Promise<void> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    await this.transaction(async (connection) => {
      await this.lockWorkspace(connection, ownerId, workspaceId);
      await this.lockSource(connection, ownerId, sourceId);
      await this.lockBinding(connection, workspaceId, sourceId);
      await connection.execute(
        "INSERT INTO workspace_default_source (workspaceId, sourceId) VALUES (?, ?) ON DUPLICATE KEY UPDATE sourceId = ?",
        [workspaceId, sourceId, sourceId],
      );
    });
  }

  async bindings(ownerId: string, workspaceId: string, after?: string): Promise<BindingRow[]> {
    if (!validId(workspaceId) || (after !== undefined && !validId(after)))
      throw new DataSourceError("INVALID");
    const [workspaces] = await this.pool.execute<RowDataPacket[]>(
      "SELECT id FROM workspace WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NULL",
      [workspaceId, ownerId],
    );
    if (workspaces.length !== 1) throw new DataSourceError("NOT_FOUND");
    const [rows] = await this.pool.execute<BindingRow[]>(
      `${bindingProjection} AND s.id > ? ORDER BY s.id LIMIT 101`,
      [workspaceId, ownerId, ownerId, after ?? ""],
    );
    return rows;
  }

  /** Current projections for exactly the requested IDs, with one bounded batch query. */
  async bindingStatuses(
    ownerId: string,
    workspaceId: string,
    sourceIds: string[],
  ): Promise<BindingRow[]> {
    if (
      !validId(workspaceId) ||
      sourceIds.length > 100 ||
      new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some((id) => !validId(id))
    )
      throw new DataSourceError("INVALID");
    const [workspaces] = await this.pool.execute<RowDataPacket[]>(
      "SELECT id FROM workspace WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NULL",
      [workspaceId, ownerId],
    );
    if (workspaces.length !== 1) throw new DataSourceError("NOT_FOUND");
    if (!sourceIds.length) return [];
    const placeholders = sourceIds.map(() => "?").join(",");
    const [rows] = await this.pool.execute<BindingRow[]>(
      `${bindingProjection} AND s.id IN (${placeholders}) ORDER BY s.id`,
      [workspaceId, ownerId, ownerId, ...sourceIds],
    );
    return rows;
  }

  async beginScan(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
  ): Promise<{ id: string; connectorId: string }> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    return this.transaction(async (connection) => {
      await this.lockWorkspace(connection, ownerId, workspaceId);
      const source = await this.lockSource(connection, ownerId, sourceId);
      await this.lockBinding(connection, workspaceId, sourceId);
      const [pending] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM schema_scan WHERE workspaceId = ? AND sourceId = ? AND status = 'pending' AND expiresAt > UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE",
        [workspaceId, sourceId],
      );
      if (pending.length) throw new DataSourceError("CONFLICT");
      const id = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      const issuedAt = Math.floor(Date.now() / 1000);
      await connection.execute(
        "INSERT INTO schema_scan (id, ownerId, workspaceId, sourceId, connectorId, nonce, issuedAt, expiresEpoch, status, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND))",
        [id, ownerId, workspaceId, sourceId, source.connectorId, nonce, issuedAt, issuedAt + 60],
      );
      return { id, connectorId: source.connectorId };
    });
  }

  async boundSource(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
  ): Promise<{ connectorId: string; bindingGeneration: string | null } | null> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<SourceRow[]>(
      "SELECT s.connectorId FROM data_source s JOIN workspace_data_source b ON b.sourceId = s.id JOIN workspace w ON w.id = b.workspaceId WHERE s.id = ? AND s.ownerId = ? AND s.archivedAt IS NULL AND w.id = ? AND w.createdByAccountId = ? AND w.archivedAt IS NULL",
      [sourceId, ownerId, workspaceId, ownerId],
    );
    const row = rows[0];
    if (!row) return null;
    if (!this.bindingIdentities) return { connectorId: row.connectorId, bindingGeneration: null };
    const [identities] = await this.pool.execute<RowDataPacket[]>(
      "SELECT i.generation,s.connectorId FROM source_binding_identity i JOIN workspace_data_source b ON b.workspaceId=i.workspaceId AND b.sourceId=i.sourceId JOIN data_source s ON s.id=b.sourceId JOIN workspace w ON w.id=b.workspaceId WHERE b.workspaceId=? AND b.sourceId=? AND s.ownerId=? AND w.createdByAccountId=? AND s.archivedAt IS NULL AND w.archivedAt IS NULL",
      [workspaceId, sourceId, ownerId, ownerId],
    );
    const identity = identities[0];
    if (!identity) return null;
    if (!validId(String(identity.generation))) throw new DataSourceError("INVALID");
    return {
      connectorId: String(identity.connectorId),
      bindingGeneration: String(identity.generation),
    };
  }

  private async bindingGeneration(
    connection: PoolConnection,
    workspaceId: string,
    sourceId: string,
  ): Promise<string | null> {
    if (!this.bindingIdentities) return null;
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT generation FROM source_binding_identity WHERE workspaceId=? AND sourceId=? FOR UPDATE",
      [workspaceId, sourceId],
    );
    if (!rows[0] || !validId(String(rows[0].generation))) throw new DataSourceError("NOT_FOUND");
    return String(rows[0].generation);
  }

  async nextScan(connectorId: string): Promise<ScanRow | null> {
    if (!validId(connectorId)) return null;
    const [rows] = await this.pool.execute<ScanRow[]>(
      "SELECT sc.id, sc.ownerId, sc.workspaceId, sc.sourceId, sc.connectorId, sc.status, sc.nonce, sc.expiresAt, sc.issuedAt, sc.expiresEpoch AS expiresUnix FROM schema_scan sc JOIN workspace w ON w.id = sc.workspaceId AND w.createdByAccountId = sc.ownerId AND w.archivedAt IS NULL JOIN data_source s ON s.id = sc.sourceId AND s.ownerId = sc.ownerId AND s.connectorId = sc.connectorId JOIN workspace_data_source b ON b.workspaceId = sc.workspaceId AND b.sourceId = sc.sourceId WHERE sc.connectorId = ? AND sc.status = 'pending' AND sc.expiresAt > UTC_TIMESTAMP(3) ORDER BY sc.`sequence` LIMIT 1",
      [connectorId],
    );
    return rows[0] ?? null;
  }

  async scanStatus(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
  ): Promise<{ status: string; errorCode: string | null } | null> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT CASE WHEN sc.status = 'pending' AND sc.expiresAt <= UTC_TIMESTAMP(3) THEN 'expired' ELSE sc.status END AS status, sc.errorCode FROM schema_scan sc JOIN workspace w ON w.id = sc.workspaceId AND w.createdByAccountId = ? AND w.archivedAt IS NULL JOIN data_source s ON s.id = sc.sourceId AND s.ownerId = ? JOIN workspace_data_source b ON b.workspaceId = sc.workspaceId AND b.sourceId = sc.sourceId WHERE sc.workspaceId = ? AND sc.sourceId = ? ORDER BY sc.`sequence` DESC LIMIT 1",
      [ownerId, ownerId, workspaceId, sourceId],
    );
    const row = rows[0];
    return row
      ? {
          status: String(row.status),
          errorCode: row.errorCode === null ? null : String(row.errorCode),
        }
      : null;
  }

  async authorizedScan(scanId: string, connectorId: string): Promise<ScanRow | null> {
    if (!validId(scanId) || !validId(connectorId)) return null;
    const [rows] = await this.pool.execute<ScanRow[]>(
      "SELECT sc.id, sc.ownerId, sc.workspaceId, sc.sourceId, sc.connectorId, sc.status, sc.expiresAt FROM schema_scan sc JOIN workspace w ON w.id = sc.workspaceId AND w.createdByAccountId = sc.ownerId AND w.archivedAt IS NULL JOIN data_source s ON s.id = sc.sourceId AND s.ownerId = sc.ownerId AND s.connectorId = sc.connectorId JOIN workspace_data_source b ON b.workspaceId = sc.workspaceId AND b.sourceId = sc.sourceId WHERE sc.id = ? AND sc.connectorId = ? AND sc.status = 'pending' AND sc.expiresAt > UTC_TIMESTAMP(3)",
      [scanId, connectorId],
    );
    return rows[0] ?? null;
  }

  async completeScan(scanId: string, connectorId: string, content: unknown): Promise<void> {
    if (!validId(scanId) || !validId(connectorId)) throw new DataSourceError("INVALID");
    validateSnapshot(content);
    const json = JSON.stringify(content);
    if (!json || Buffer.byteLength(json) > 1_048_576) throw new DataSourceError("INVALID");
    // Lookup is advisory. Every ownership and binding condition is locked and checked again below.
    const existing = await this.authorizedScan(scanId, connectorId);
    if (!existing) throw new DataSourceError("NOT_FOUND");
    await this.transaction(async (connection) => {
      await this.lockWorkspace(connection, existing.ownerId, existing.workspaceId);
      const source = await this.lockSource(connection, existing.ownerId, existing.sourceId);
      await this.lockBinding(connection, existing.workspaceId, existing.sourceId);
      const [scans] = await connection.execute<ScanRow[]>(
        "SELECT id, ownerId, workspaceId, sourceId, connectorId, status, expiresAt FROM schema_scan WHERE id = ? AND connectorId = ? AND status = 'pending' AND expiresAt > UTC_TIMESTAMP(3) FOR UPDATE",
        [scanId, connectorId],
      );
      const scan = scans[0];
      if (
        !scan ||
        source.connectorId !== connectorId ||
        scan.ownerId !== existing.ownerId ||
        scan.workspaceId !== existing.workspaceId ||
        scan.sourceId !== existing.sourceId
      )
        throw new DataSourceError("NOT_FOUND");
      await connection.execute(
        "INSERT INTO schema_snapshot (id, scanId, workspaceId, sourceId, contentHash, content, createdAt) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))",
        [
          randomUUID(),
          scanId,
          scan.workspaceId,
          scan.sourceId,
          createHash("sha256").update(json).digest("hex"),
          json,
        ],
      );
      const [updated] = await connection.execute<ResultSetHeader>(
        "UPDATE schema_scan SET status = 'completed', finishedAt = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'pending'",
        [scanId],
      );
      if (updated.affectedRows !== 1) throw new DataSourceError("CONFLICT");
    });
  }

  async failScan(scanId: string, connectorId: string, errorCode: string): Promise<void> {
    if (
      !validId(scanId) ||
      !validId(connectorId) ||
      !["connection", "permissions", "scope", "limit", "metadata", "local_config"].includes(
        errorCode,
      )
    )
      throw new DataSourceError("INVALID");
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE schema_scan sc JOIN workspace w ON w.id = sc.workspaceId AND w.createdByAccountId = sc.ownerId AND w.archivedAt IS NULL JOIN data_source s ON s.id = sc.sourceId AND s.ownerId = sc.ownerId AND s.connectorId = sc.connectorId JOIN workspace_data_source b ON b.workspaceId = sc.workspaceId AND b.sourceId = sc.sourceId SET sc.status = 'failed', sc.errorCode = ?, sc.finishedAt = UTC_TIMESTAMP(3) WHERE sc.id = ? AND sc.connectorId = ? AND sc.status = 'pending' AND sc.expiresAt > UTC_TIMESTAMP(3)",
      [errorCode, scanId, connectorId],
    );
    if (result.affectedRows !== 1) throw new DataSourceError("NOT_FOUND");
  }

  async latest(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
  ): Promise<SnapshotRow | null> {
    if (!validId(workspaceId) || !validId(sourceId)) throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<SnapshotRow[]>(
      "SELECT sn.id, CAST(sc.`sequence` AS CHAR) AS version, sn.contentHash, sn.content, sn.createdAt FROM schema_snapshot sn JOIN schema_scan sc ON sc.id = sn.scanId JOIN workspace w ON w.id = sn.workspaceId AND w.createdByAccountId = ? AND w.archivedAt IS NULL JOIN data_source s ON s.id = sn.sourceId AND s.ownerId = ? JOIN workspace_data_source b ON b.workspaceId = sn.workspaceId AND b.sourceId = sn.sourceId WHERE sn.workspaceId = ? AND sn.sourceId = ? ORDER BY sc.`sequence` DESC LIMIT 1",
      [ownerId, ownerId, workspaceId, sourceId],
    );
    return rows[0] ?? null;
  }

  async snapshot(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
    snapshotId: string,
  ): Promise<SnapshotRow | null> {
    if (!validId(workspaceId) || !validId(sourceId) || !validId(snapshotId))
      throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<SnapshotRow[]>(
      "SELECT sn.id, CAST(sc.`sequence` AS CHAR) AS version, sn.contentHash, sn.content, sn.createdAt FROM schema_snapshot sn JOIN schema_scan sc ON sc.id = sn.scanId JOIN workspace w ON w.id = sn.workspaceId AND w.createdByAccountId = ? AND w.archivedAt IS NULL JOIN data_source s ON s.id = sn.sourceId AND s.ownerId = ? JOIN workspace_data_source b ON b.workspaceId = sn.workspaceId AND b.sourceId = sn.sourceId WHERE sn.workspaceId = ? AND sn.sourceId = ? AND sn.id = ? LIMIT 1",
      [ownerId, ownerId, workspaceId, sourceId, snapshotId],
    );
    return rows[0] ?? null;
  }

  async history(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
    before?: string,
  ): Promise<{
    snapshots: Array<{ id: string; version: string; createdAt: Date; contentHash: string }>;
    nextCursor: string | null;
  }> {
    if (
      !validId(workspaceId) ||
      !validId(sourceId) ||
      (before !== undefined &&
        (!/^[1-9][0-9]{0,19}$/.test(before) || BigInt(before) > 18_446_744_073_709_551_615n))
    )
      throw new DataSourceError("INVALID");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT sn.id, CAST(sc.\`sequence\` AS CHAR) AS version, sn.contentHash, sn.createdAt FROM schema_snapshot sn JOIN schema_scan sc ON sc.id = sn.scanId JOIN workspace w ON w.id = sn.workspaceId AND w.createdByAccountId = ? AND w.archivedAt IS NULL JOIN data_source s ON s.id = sn.sourceId AND s.ownerId = ? JOIN workspace_data_source b ON b.workspaceId = sn.workspaceId AND b.sourceId = sn.sourceId WHERE sn.workspaceId = ? AND sn.sourceId = ? ${before ? "AND sc.`sequence` < CAST(? AS UNSIGNED)" : ""} ORDER BY sc.\`sequence\` DESC LIMIT 51`,
      before
        ? [ownerId, ownerId, workspaceId, sourceId, before]
        : [ownerId, ownerId, workspaceId, sourceId],
    );
    const items = rows.slice(0, 50).map((row) => ({
      id: String(row.id),
      version: String(row.version),
      createdAt: row.createdAt as Date,
      contentHash: String(row.contentHash),
    }));
    return {
      snapshots: items,
      nextCursor: rows.length > 50 ? (items[items.length - 1]?.version ?? null) : null,
    };
  }
}
