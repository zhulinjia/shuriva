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
  const bindingSql = (
    await readFile(resolve(apiPackageRoot(), "migrations/010-mcp-grant-binding.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return {
    sql,
    names,
    bindingSql,
    baseline: createHash("sha256").update(sql).digest("hex"),
    checksum: createHash("sha256").update(sql).update(bindingSql).digest("hex"),
  };
}
async function shape(c: PoolConnection, names: string[], baseline = false) {
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
  const binding = columns.find(
    (column) => column.TABLE_NAME === "mcp_grant" && column.COLUMN_NAME === "bindingGeneration",
  );
  if (
    binding &&
    (binding.COLUMN_TYPE !== "char(36)" ||
      binding.IS_NULLABLE !== "YES" ||
      binding.COLUMN_DEFAULT !== null ||
      binding.COLLATION_NAME !== "ascii_bin" ||
      binding.EXTRA !== "" ||
      columns.some(
        (column) =>
          column.TABLE_NAME === "mcp_grant" && column.ORDINAL_POSITION > binding.ORDINAL_POSITION,
      ))
  )
    throw new Error("MCP_SCHEMA_INCOMPLETE");
  if (!baseline && !binding) throw new Error("MCP_SCHEMA_INCOMPLETE");
  const selected = baseline ? columns.filter((column) => column !== binding) : columns;
  const grantIndex = indexes.filter(
    (index) =>
      index.TABLE_NAME === "mcp_grant" && index.INDEX_NAME === "mcp_grant_binding_generation",
  );
  const grantFk = foreignKeys.filter(
    (fk) =>
      fk.TABLE_NAME === "mcp_grant" && fk.CONSTRAINT_NAME === "mcp_grant_binding_generation_fk",
  );
  const [localReference] = binding
    ? await c.execute<RowDataPacket[]>(
        "SELECT REFERENCED_TABLE_SCHEMA=DATABASE() AS localSchema FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_grant' AND CONSTRAINT_NAME='mcp_grant_binding_generation_fk'",
      )
    : [[]];
  if (
    (binding &&
      (grantIndex.length !== 1 ||
        grantIndex[0]?.COLUMN_NAME !== "bindingGeneration" ||
        Number(grantIndex[0]?.NON_UNIQUE) !== 1 ||
        grantFk.length !== 1 ||
        localReference.length !== 1 ||
        Number(localReference[0]?.localSchema) !== 1 ||
        grantFk[0]?.COLUMN_NAME !== "bindingGeneration" ||
        grantFk[0]?.REFERENCED_TABLE_NAME !== "source_binding_identity" ||
        grantFk[0]?.REFERENCED_COLUMN_NAME !== "generation" ||
        grantFk[0]?.DELETE_RULE !== "SET NULL" ||
        grantFk[0]?.UPDATE_RULE !== "NO ACTION")) ||
    (!binding && (grantIndex.length || grantFk.length))
  )
    throw new Error("MCP_SCHEMA_INCOMPLETE");
  return createHash("sha256")
    .update(
      JSON.stringify({
        columns: selected,
        indexes: baseline ? indexes.filter((index) => !grantIndex.includes(index)) : indexes,
        tables,
        foreignKeys: baseline ? foreignKeys.filter((fk) => !grantFk.includes(fk)) : foreignKeys,
      }),
    )
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
      rows[0]?.version !== 2 ||
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
      const row = rows[0];
      if (rows.length !== 1) throw new Error("MCP_PARTIAL_MIGRATION_REVIEW_REQUIRED");
      if (
        row.version === 2 &&
        row.checksum === file.checksum &&
        row.shapeHash === (await shape(c, file.names))
      )
        return;
      if (
        row.version !== 1 ||
        row.checksum !== file.baseline ||
        row.shapeHash !== (await shape(c, file.names, true))
      )
        throw new Error("MCP_PARTIAL_MIGRATION_REVIEW_REQUIRED");
    } else {
      for (const statement of file.sql
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await c.query(statement);
      await c.execute("INSERT INTO mcp_schema_version(version,checksum,shapeHash) VALUES(1,?,?)", [
        file.baseline,
        await shape(c, file.names, true),
      ]);
    }
    const [binding] = await c.execute<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_grant' AND COLUMN_NAME='bindingGeneration'",
    );
    if (!binding.length) await c.query(file.bindingSql);
    await c.execute(
      "UPDATE mcp_schema_version SET version=2,checksum=?,shapeHash=? WHERE version=1",
      [file.checksum, await shape(c, file.names)],
    );
  } finally {
    try {
      if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    } finally {
      c.release();
    }
  }
}
