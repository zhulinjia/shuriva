import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { apiPackageRoot } from "../package-path.js";

export const mutationTables = [
  "mutation_scope",
  "mutation_target",
  "mutation_preview",
  "mutation_confirmation",
  "mutation_execution",
  "mutation_permit",
  "mutation_outbox",
] as const;
export async function stage8MigrationFile() {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/006-controlled-writes.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}
const columns: Record<(typeof mutationTables)[number], Record<string, string>> = {
  mutation_scope: {
    ownerId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
  },
  mutation_target: {
    identity: "varchar(256)|NO|utf8mb4_bin|",
    frozen: "tinyint unsigned|NO||",
    code: "varchar(48)|YES|ascii_bin|",
  },
  mutation_preview: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    ownerId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    connectorId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    commitment: "varchar(43)|NO|ascii_bin|",
    revision: "int unsigned|NO||",
    apiBoot: "char(64)|NO|ascii_bin|",
    connectorBoot: "char(64)|NO|ascii_bin|",
    targetIdentity: "varchar(256)|NO|utf8mb4_bin|",
    targetEpoch: "char(64)|NO|ascii_bin|",
    policyGeneration: "varchar(128)|NO|ascii_bin|",
    installationGeneration: "varchar(128)|NO|ascii_bin|",
    operation: "varchar(8)|NO|ascii_bin|",
    tableName: "varchar(64)|NO|utf8mb4_bin|",
    rowCount: "int unsigned|NO||",
    expiresAt: "datetime(3)|NO||",
    state: "varchar(16)|NO|ascii_bin|",
    createdAt: "datetime(3)|NO||",
  },
  mutation_confirmation: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    previewId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    ownerId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    commitment: "varchar(43)|NO|ascii_bin|",
    revision: "int unsigned|NO||",
    state: "varchar(16)|NO|ascii_bin|",
    executionId: "varchar(36)|YES|utf8mb4_0900_ai_ci|",
  },
  mutation_execution: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sequence: "bigint unsigned|NO||auto_increment",
    confirmationId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    previewId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sessionId: "varchar(128)|NO|ascii_bin|",
    state: "varchar(32)|NO|ascii_bin|",
    cancelRequested: "tinyint unsigned|NO||",
    code: "varchar(48)|YES|ascii_bin|",
    reconciliationExpiresAt: "datetime(3)|YES||",
    affectedRows: "int unsigned|YES||",
    createdAt: "datetime(3)|NO||",
    updatedAt: "datetime(3)|NO||",
  },
  mutation_permit: {
    executionId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    permitId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    request: "json|NO||",
    signature: "varchar(86)|NO|ascii_bin|",
  },
  mutation_outbox: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    executionId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    ownerId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci|",
    event: "varchar(32)|NO|ascii_bin|",
    delivered: "tinyint unsigned|NO||",
    createdAt: "datetime(3)|NO||",
  },
};
const indexes: Record<(typeof mutationTables)[number], string[]> = {
  mutation_scope: ["PRIMARY|0|ownerId,workspaceId,sourceId"],
  mutation_target: ["PRIMARY|0|identity"],
  mutation_preview: [
    "PRIMARY|0|id",
    "mutation_preview_scope|1|ownerId,workspaceId,sourceId,state",
    "mutation_preview_target|1|targetIdentity",
  ],
  mutation_confirmation: ["PRIMARY|0|id", "mutation_confirmation_preview|0|previewId"],
  mutation_execution: [
    "PRIMARY|0|id",
    "mutation_execution_confirmation|0|confirmationId",
    "mutation_execution_preview|0|previewId",
    "mutation_execution_sequence|0|sequence",
    "mutation_execution_state|1|state,previewId",
  ],
  mutation_permit: ["PRIMARY|0|executionId", "mutation_permit_id|0|permitId"],
  mutation_outbox: ["PRIMARY|0|id", "mutation_outbox_pending|1|delivered,createdAt,id"],
};
export async function stage8TableCount(c: PoolConnection): Promise<number> {
  const [rows] = await c.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${mutationTables.map(() => "?").join(",")})`,
    [...mutationTables],
  );
  return Number(rows[0]?.count);
}
export async function inspectStage8(c: PoolConnection): Promise<void> {
  for (const table of mutationTables) {
    const [engine] = await c.execute<RowDataPacket[]>(
      "SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
    );
    if (
      engine.length !== 1 ||
      engine[0]?.ENGINE !== "InnoDB" ||
      engine[0]?.TABLE_TYPE !== "BASE TABLE"
    )
      throw Error("Mutation table differs from required schema");
    const [actual] = await c.execute<RowDataPacket[]>(
      "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
    );
    if (
      actual.length !== Object.keys(columns[table]).length ||
      actual.some(
        (r) =>
          columns[table][String(r.COLUMN_NAME)] !==
          `${r.COLUMN_TYPE}|${r.IS_NULLABLE}|${r.COLLATION_NAME ?? ""}|${r.EXTRA}`,
      )
    )
      throw Error("Mutation columns differ from required schema");
    const [keys] = await c.execute<RowDataPacket[]>(
      "SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS fields FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? GROUP BY INDEX_NAME,NON_UNIQUE",
      [table],
    );
    const expected = new Set(indexes[table]);
    if (
      keys.length !== expected.size ||
      keys.some((r) => !expected.has(`${r.INDEX_NAME}|${r.NON_UNIQUE}|${r.fields}`))
    )
      throw Error("Mutation indexes differ from required schema");
    const [foreign] = await c.execute<RowDataPacket[]>(
      "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL",
      [table],
    );
    if (foreign.length)
      throw Error("Mutation schema must not inherit cascading cross-module relations");
  }
}
