import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

interface WorkspaceRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}
export function workspaceName(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("name" in input) || typeof input.name !== "string")
    return;
  const name = input.name.trim();
  return name.length >= 1 && name.length <= 120 ? name : undefined;
}
export class WorkspaceStore {
  constructor(
    private readonly pool: Pool,
    private readonly cancelScans?: (
      connection: PoolConnection,
      workspaceId: string,
    ) => Promise<void>,
  ) {}
  async list(ownerId: string, archived: boolean, after?: string) {
    const condition = archived ? "IS NOT NULL" : "IS NULL";
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `SELECT id, name, description, createdAt, updatedAt, archivedAt FROM workspace WHERE createdByAccountId = ? AND archivedAt ${condition} AND id > ? ORDER BY id LIMIT 51`,
      [ownerId, after ?? ""],
    );
    const hasMore = rows.length > 50;
    const workspaces = rows.slice(0, 50);
    return {
      workspaces,
      nextCursor: hasMore ? (workspaces[workspaces.length - 1]?.id ?? null) : null,
    };
  }
  async create(ownerId: string, name: string) {
    const id = randomUUID();
    await this.pool.execute(
      "INSERT INTO workspace (id, name, description, createdByAccountId, createdAt, updatedAt) VALUES (?, ?, NULL, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [id, name, ownerId],
    );
    return { id, name };
  }
  async rename(ownerId: string, id: string, name: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE workspace SET name = ?, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NULL",
      [name, id, ownerId],
    );
    return result.affectedRows > 0;
  }
  async setArchived(ownerId: string, id: string, archived: boolean) {
    const statement = archived
      ? "UPDATE workspace SET archivedAt = UTC_TIMESTAMP(3), updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NULL"
      : "UPDATE workspace SET archivedAt = NULL, updatedAt = UTC_TIMESTAMP(3) WHERE id = ? AND createdByAccountId = ? AND archivedAt IS NOT NULL";
    if (!archived) {
      const [result] = await this.pool.execute<ResultSetHeader>(statement, [id, ownerId]);
      return result.affectedRows > 0;
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(statement, [id, ownerId]);
      if (result.affectedRows && this.cancelScans) await this.cancelScans(connection, id);
      await connection.commit();
      return result.affectedRows > 0;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
