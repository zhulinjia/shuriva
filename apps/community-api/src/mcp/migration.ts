import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { apiPackageRoot } from "../package-path.js";

async function definition() {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/007-mcp-server.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  const names = [...sql.matchAll(/create table\s+`?(mcp_[a-z_]+)`?\s*\(/gi)]
    .map((m) => m[1] as string)
    .sort();
  return { sql, names, checksum: createHash("sha256").update(sql).digest("hex") };
}
async function shape(c: PoolConnection, names: string[]) {
  const marks = names.map(() => "?").join(",");
  const [columns] = await c.execute<RowDataPacket[]>(
    `SELECT TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,ORDINAL_POSITION`,
    names,
  );
  const [indexes] = await c.execute<RowDataPacket[]>(
    `SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
    names,
  );
  const [tables] = await c.execute<RowDataPacket[]>(
    `SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${marks}) ORDER BY TABLE_NAME`,
    names,
  );
  if (tables.length !== names.length || tables.some((t) => t.ENGINE !== "InnoDB"))
    throw new Error("MCP_SCHEMA_INCOMPLETE");
  const [foreignKeys] = await c.execute<RowDataPacket[]>(
    `SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN (${marks}) ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`,
    names,
  );
  return createHash("sha256")
    .update(JSON.stringify({ columns, indexes, tables, foreignKeys }))
    .digest("hex");
}
export async function verifyMcpSchema(pool: Pool) {
  const c = await pool.getConnection();
  try {
    const file = await definition();
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT version,checksum,shapeHash FROM mcp_schema_version",
    );
    if (
      rows.length !== 1 ||
      rows[0]?.version !== 1 ||
      rows[0]?.checksum !== file.checksum ||
      rows[0]?.shapeHash !== (await shape(c, file.names))
    )
      throw new Error("MCP_SCHEMA_NOT_CURRENT");
  } finally {
    c.release();
  }
}
/** Explicit separate feature migration. A partially created schema is never reset. */
export async function migrateMcpSchema(pool: Pool) {
  const file = await definition(),
    c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<RowDataPacket[]>("SELECT DATABASE() AS name");
    const lockName = `mcp-migrate-${createHash("sha256").update(String(db[0]?.name)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<RowDataPacket[]>("SELECT GET_LOCK(?,5) AS acquired", [lockName]);
    if (Number(lock[0]?.acquired) !== 1) throw new Error("MCP_MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    const [present] = await c.execute<RowDataPacket[]>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'mcp\\_%'",
      [],
    );
    if (present.length) {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT version,checksum,shapeHash FROM mcp_schema_version",
      );
      if (
        rows.length !== 1 ||
        rows[0]?.version !== 1 ||
        rows[0]?.checksum !== file.checksum ||
        rows[0]?.shapeHash !== (await shape(c, file.names))
      )
        throw new Error("MCP_PARTIAL_MIGRATION_REVIEW_REQUIRED");
      return;
    }
    for (const statement of file.sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await c.query(statement);
    await c.execute("INSERT INTO mcp_schema_version(version,checksum,shapeHash) VALUES(1,?,?)", [
      file.checksum,
      await shape(c, file.names),
    ]);
  } finally {
    try {
      if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    } finally {
      c.release();
    }
  }
}
