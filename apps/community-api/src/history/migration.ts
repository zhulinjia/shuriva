import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { apiPackageRoot } from "../package-path.js";

export async function stage7MigrationFile() {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/005-history.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}
export async function stage7TableCount(c: PoolConnection): Promise<number> {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='history_entry'",
  );
  return Number(rows[0]?.count);
}
export async function inspectStage7(c: PoolConnection): Promise<void> {
  const [tables] = await c.query<RowDataPacket[]>(
    "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='history_entry'",
  );
  if (tables.length !== 1 || tables[0]?.ENGINE !== "InnoDB")
    throw Error("History table differs from expected schema");
  const expected: Record<string, string> = {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sequence: "bigint unsigned|NO||auto_increment",
    ownerId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    workspaceId: "varchar(36)|YES|utf8mb4_0900_ai_ci|",
    sourceId: "varchar(36)|YES|utf8mb4_0900_ai_ci|",
    kind: "varchar(16)|NO|ascii_bin|",
    revision: "int unsigned|NO||",
    content: "json|NO||",
    deletedAt: "datetime(3)|YES||",
    createdAt: "datetime(3)|NO||",
    updatedAt: "datetime(3)|NO||",
  };
  const [columns] = await c.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='history_entry'",
  );
  if (
    columns.length !== Object.keys(expected).length ||
    columns.some(
      (row) =>
        expected[String(row.COLUMN_NAME)] !==
        `${row.COLUMN_TYPE}|${row.IS_NULLABLE}|${row.COLLATION_NAME ?? ""}|${row.EXTRA}`,
    )
  )
    throw Error("History columns differ from expected schema");
  const [indexes] = await c.query<RowDataPacket[]>(
    "SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS fields FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='history_entry' GROUP BY INDEX_NAME,NON_UNIQUE",
  );
  const expectedIndexes = new Set([
    "PRIMARY|0|id",
    "history_sequence|0|sequence",
    "history_scope|1|ownerId,workspaceId,sourceId,kind,deletedAt,sequence",
    "history_owner_kind|1|ownerId,kind,sequence",
    "history_workspace|1|workspaceId",
    "history_source|1|sourceId",
  ]);
  if (
    indexes.length !== expectedIndexes.size ||
    indexes.some((row) => !expectedIndexes.has(`${row.INDEX_NAME}|${row.NON_UNIQUE}|${row.fields}`))
  )
    throw Error("History indexes differ");
  const [keys] = await c.query<RowDataPacket[]>(
    "SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='history_entry' AND k.REFERENCED_TABLE_NAME IS NOT NULL",
  );
  const expectedKeys = new Set([
    "history_owner_fk|ownerId|user|id|RESTRICT",
    "history_workspace_fk|workspaceId|workspace|id|RESTRICT",
    "history_source_fk|sourceId|data_source|id|RESTRICT",
  ]);
  if (
    keys.length !== expectedKeys.size ||
    keys.some(
      (row) =>
        !expectedKeys.has(
          `${row.CONSTRAINT_NAME}|${row.COLUMN_NAME}|${row.REFERENCED_TABLE_NAME}|${row.REFERENCED_COLUMN_NAME}|${row.DELETE_RULE}`,
        ),
    )
  )
    throw Error("History foreign keys differ");
}
