import { MigrationVerificationError } from "../migration-error.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { apiPackageRoot } from "../package-path.js";

const id = "varchar(36)|NO|utf8mb4_0900_ai_ci";
const date = "datetime(3)|NO|";
const specs: Record<string, Record<string, string>> = {
  data_source: {
    id,
    ownerId: id,
    connectorId: id,
    name: "varchar(120)|NO|utf8mb4_0900_ai_ci",
    createdAt: date,
    updatedAt: date,
    archivedAt: "datetime(3)|YES|",
  },
  workspace_data_source: { workspaceId: id, sourceId: id, boundAt: date },
  workspace_default_source: { workspaceId: id, sourceId: id },
  schema_scan: {
    id,
    sequence: "bigint unsigned|NO|",
    ownerId: id,
    workspaceId: id,
    sourceId: id,
    connectorId: id,
    nonce: "varchar(64)|NO|ascii_bin",
    issuedAt: "bigint|NO|",
    expiresEpoch: "bigint|NO|",
    status: "varchar(16)|NO|utf8mb4_0900_ai_ci",
    errorCode: "varchar(32)|YES|utf8mb4_0900_ai_ci",
    createdAt: date,
    expiresAt: date,
    finishedAt: "datetime(3)|YES|",
  },
  schema_snapshot: {
    id,
    scanId: id,
    workspaceId: id,
    sourceId: id,
    contentHash: "char(64)|NO|ascii_bin",
    content: "json|NO|",
    createdAt: date,
  },
};
const foreignKeys: Record<string, string> = {
  source_owner_fk: "data_source|ownerId|user|id|RESTRICT",
  binding_workspace_fk: "workspace_data_source|workspaceId|workspace|id|RESTRICT",
  binding_source_fk: "workspace_data_source|sourceId|data_source|id|RESTRICT",
  default_source_binding_fk:
    "workspace_default_source|workspaceId,sourceId|workspace_data_source|workspaceId,sourceId|CASCADE",
  scan_owner_fk: "schema_scan|ownerId|user|id|RESTRICT",
  scan_workspace_fk: "schema_scan|workspaceId|workspace|id|RESTRICT",
  scan_source_fk: "schema_scan|sourceId|data_source|id|RESTRICT",
  snapshot_scan_fk: "schema_snapshot|scanId|schema_scan|id|RESTRICT",
  snapshot_workspace_fk: "schema_snapshot|workspaceId|workspace|id|RESTRICT",
  snapshot_source_fk: "schema_snapshot|sourceId|data_source|id|RESTRICT",
};
export async function stage3MigrationFile(): Promise<{ sql: string; checksum: string }> {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/003-datasources.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}
export async function stage3TableCount(connection: PoolConnection): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('data_source','workspace_data_source','workspace_default_source','schema_scan','schema_snapshot')",
  );
  return Number(rows[0]?.count);
}
export async function inspectStage3(connection: PoolConnection): Promise<void> {
  const [tables] = await connection.query<RowDataPacket[]>(
    "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('data_source','workspace_data_source','workspace_default_source','schema_scan','schema_snapshot')",
  );
  if (tables.length !== Object.keys(specs).length || tables.some((row) => row.ENGINE !== "InnoDB"))
    throw new MigrationVerificationError("Stage 3 tables differ from expected schema");
  const [columns] = await connection.query<RowDataPacket[]>(
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('data_source','workspace_data_source','workspace_default_source','schema_scan','schema_snapshot')",
  );
  for (const [table, expected] of Object.entries(specs)) {
    const actual = columns.filter((row) => row.TABLE_NAME === table);
    if (actual.length !== Object.keys(expected).length)
      throw new MigrationVerificationError(`Stage 3 columns differ in ${table}`);
    for (const row of actual) {
      const description = [row.COLUMN_TYPE, row.IS_NULLABLE, row.COLLATION_NAME ?? ""].join("|");
      if (expected[String(row.COLUMN_NAME)] !== description)
        throw new MigrationVerificationError(`Stage 3 columns differ in ${table}`);
      if (
        table === "schema_scan" &&
        row.COLUMN_NAME === "sequence" &&
        row.EXTRA !== "auto_increment"
      )
        throw new MigrationVerificationError("Stage 3 scan sequence is not auto-incrementing");
    }
  }
  const [keys] = await connection.query<RowDataPacket[]>(
    "SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',') AS columnsUsed, k.REFERENCED_TABLE_NAME, GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',') AS referencedColumns, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME IN ('data_source','workspace_data_source','workspace_default_source','schema_scan','schema_snapshot') AND k.REFERENCED_TABLE_NAME IS NOT NULL GROUP BY k.CONSTRAINT_NAME, k.TABLE_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE",
  );
  if (keys.length !== Object.keys(foreignKeys).length)
    throw new MigrationVerificationError("Stage 3 foreign keys differ");
  for (const row of keys) {
    const description = [
      row.TABLE_NAME,
      row.columnsUsed,
      row.REFERENCED_TABLE_NAME,
      row.referencedColumns,
      row.DELETE_RULE,
    ].join("|");
    if (foreignKeys[String(row.CONSTRAINT_NAME)] !== description)
      throw new MigrationVerificationError("Stage 3 foreign keys differ");
  }
  const [indexes] = await connection.query<RowDataPacket[]>(
    "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columnsUsed FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('data_source','workspace_data_source','workspace_default_source','schema_scan','schema_snapshot') GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE",
  );
  const required = [
    "data_source|PRIMARY|0|id",
    "workspace_data_source|PRIMARY|0|workspaceId,sourceId",
    "workspace_default_source|PRIMARY|0|workspaceId",
    "schema_scan|PRIMARY|0|id",
    "schema_scan|scan_sequence|0|sequence",
    "schema_snapshot|PRIMARY|0|id",
    "schema_snapshot|snapshot_scan|0|scanId",
  ];
  const actualIndexes = new Set(
    indexes.map((row) =>
      [row.TABLE_NAME, row.INDEX_NAME, Number(row.NON_UNIQUE), row.columnsUsed].join("|"),
    ),
  );
  if (required.some((index) => !actualIndexes.has(index)))
    throw new MigrationVerificationError("Stage 3 indexes differ");
  if (!actualIndexes.has("schema_scan|scan_dispatch|1|connectorId,status,sequence,expiresAt"))
    throw new MigrationVerificationError("Stage 3 dispatch index differs");
  if (indexes.filter((index) => Number(index.NON_UNIQUE) === 0).length !== required.length)
    throw new MigrationVerificationError("Stage 3 unique indexes differ");
}
