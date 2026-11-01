import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { apiPackageRoot } from "../package-path.js";

export async function stage6MigrationFile(): Promise<{ sql: string; checksum: string }> {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/004-semantics.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}

export async function stage6TableCount(c: PoolConnection): Promise<number> {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='semantic_model'",
  );
  return Number(rows[0]?.count);
}

/** Fail closed on partial, manually altered or incorrectly constrained DDL. */
export async function inspectStage6(c: PoolConnection): Promise<void> {
  const [tables] = await c.query<RowDataPacket[]>(
    "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='semantic_model'",
  );
  if (tables.length !== 1 || tables[0]?.ENGINE !== "InnoDB")
    throw new Error("Semantic table differs from expected schema");
  const [columns] = await c.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='semantic_model'",
  );
  const expected: Record<string, string> = {
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    snapshotId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    revision: "int unsigned|NO|",
    content: "json|NO|",
    updatedAt: "datetime(3)|NO|",
  };
  if (
    columns.length !== Object.keys(expected).length ||
    columns.some(
      (row) =>
        expected[String(row.COLUMN_NAME)] !==
        `${row.COLUMN_TYPE}|${row.IS_NULLABLE}|${row.COLLATION_NAME ?? ""}`,
    )
  )
    throw new Error("Semantic columns differ from expected schema");
  const [indexes] = await c.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='semantic_model' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",
  );
  if (indexes.map((row) => row.COLUMN_NAME).join(",") !== "workspaceId,sourceId")
    throw new Error("Semantic primary key differs");
  const [keys] = await c.query<RowDataPacket[]>(
    "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='semantic_model' AND k.REFERENCED_TABLE_NAME IS NOT NULL",
  );
  const expectedKeys = new Set([
    "semantic_workspace_fk|workspaceId|workspace|id|RESTRICT",
    "semantic_source_fk|sourceId|data_source|id|RESTRICT",
    "semantic_snapshot_fk|snapshotId|schema_snapshot|id|RESTRICT",
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
    throw new Error("Semantic foreign keys differ");
}
