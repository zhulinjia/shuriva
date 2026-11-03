import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { ExternalMcpError } from "./model.js";
/** One Community runtime per database. The named lock prevents simultaneous
 * recovery; the row fence is held through actual IO, including takeover races. */
export class RuntimeOwnership {
  private closed = false;
  private constructor(
    private readonly connection: PoolConnection,
    private readonly name: string,
    private readonly id: number,
    private readonly boot: string,
  ) {}
  static async claim(pool: Pool) {
    const c = await pool.getConnection();
    try {
      await c.query("SET SESSION innodb_lock_wait_timeout=5, SESSION lock_wait_timeout=5");
      const [rows] = await c.query<RowDataPacket[]>("SELECT DATABASE() db,CONNECTION_ID() id");
      const db = rows[0]?.db,
        id = Number(rows[0]?.id);
      if (typeof db !== "string" || !db || !Number.isSafeInteger(id) || id < 1)
        throw new ExternalMcpError("EXTERNAL_MCP_RUNTIME_LOST", 503);
      const name = `external-mcp-runtime-${createHash("sha256").update(db).digest("hex").slice(0, 40)}`,
        boot = randomUUID();
      const [locks] = await c.execute<RowDataPacket[]>("SELECT GET_LOCK(?,0) acquired", [name]);
      if (Number(locks[0]?.acquired) !== 1)
        throw new ExternalMcpError("EXTERNAL_MCP_RUNTIME_ALREADY_ACTIVE", 503);
      await c.beginTransaction();
      await c.execute("INSERT IGNORE INTO external_mcp_runtime(id,bootId) VALUES(1,?)", [boot]);
      await c.execute("UPDATE external_mcp_runtime SET bootId=? WHERE id=1", [boot]);
      await c.commit();
      const owner = new RuntimeOwnership(c, name, id, boot);
      c.on("error", () => {
        owner.closed = true;
        c.destroy();
      });
      return owner;
    } catch (e) {
      c.destroy();
      throw e;
    }
  }
  async assert(c: PoolConnection) {
    if (this.closed) throw new ExternalMcpError("EXTERNAL_MCP_RUNTIME_LOST", 503);
    const [rows] = await c.execute<RowDataPacket[]>(
      "SELECT bootId FROM external_mcp_runtime WHERE id=1 FOR SHARE",
    );
    const [locks] = await c.execute<RowDataPacket[]>("SELECT IS_USED_LOCK(?) owner", [this.name]);
    if (rows[0]?.bootId !== this.boot || Number(locks[0]?.owner) !== this.id || this.closed)
      throw new ExternalMcpError("EXTERNAL_MCP_RUNTIME_LOST", 503);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connection.execute("DO RELEASE_LOCK(?)", [this.name]);
      this.connection.release();
    } catch {
      this.connection.destroy();
    }
  }
}
