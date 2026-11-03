import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { MigrationVerificationError } from "../migration-error.js";
import { inspectMutationSchema } from "../mutations/public.js";
import { apiPackageRoot } from "../package-path.js";
import { inspectStage3 } from "./stage3-schema.js";

const tables = ["source_binding_identity", "mutation_preview_binding", "binding_identity_schema"];
const specifications: Record<string, Record<string, string>> = {
  source_binding_identity: {
    workspaceId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    sourceId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    generation: "char(36)|NO|ascii_bin",
  },
  mutation_preview_binding: {
    previewId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    generation: "char(36)|NO|ascii_bin",
  },
  binding_identity_schema: { version: "int unsigned|NO|", checksum: "char(64)|NO|ascii_bin" },
};
async function definition() {
  const sql = (
    await readFile(resolve(apiPackageRoot(), "migrations/009-binding-identities.sql"), "utf8")
  ).replace(/^\uFEFF/, "");
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}
async function present(c: PoolConnection) {
  const [rows] = await c.query<RowDataPacket[]>(
    "SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('source_binding_identity','mutation_preview_binding','binding_identity_schema')",
  );
  return rows;
}
async function inspectTable(c: PoolConnection, table: string) {
  const expected = specifications[table];
  if (!expected) throw new MigrationVerificationError("Binding identity table is unknown");
  const [rows] = await c.execute<RowDataPacket[]>(
    "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLLATION_NAME,EXTRA,COLUMN_DEFAULT,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    [table],
  );
  if (
    rows.length !== Object.keys(expected).length ||
    rows.some(
      (r) =>
        expected[String(r.COLUMN_NAME)] !==
          [r.COLUMN_TYPE, r.IS_NULLABLE, r.COLLATION_NAME ?? ""].join("|") ||
        r.EXTRA !== "" ||
        r.COLUMN_DEFAULT !== null ||
        r.GENERATION_EXPRESSION !== "",
    )
  )
    throw new MigrationVerificationError("Binding identity columns differ");
  const [indexes] = await c.execute<RowDataPacket[]>(
    "SELECT INDEX_NAME,NON_UNIQUE,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columnsUsed,MIN(IS_VISIBLE) AS visible,MAX(SUB_PART) AS prefixLength,MIN(INDEX_TYPE) AS indexType FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? GROUP BY INDEX_NAME,NON_UNIQUE",
    [table],
  );
  const required =
    table === "source_binding_identity"
      ? ["PRIMARY|0|workspaceId,sourceId", "source_binding_generation|0|generation"]
      : [table === "mutation_preview_binding" ? "PRIMARY|0|previewId" : "PRIMARY|0|version"];
  if (
    indexes.length !== required.length ||
    indexes.some(
      (r) =>
        !required.includes([r.INDEX_NAME, Number(r.NON_UNIQUE), r.columnsUsed].join("|")) ||
        r.visible !== "YES" ||
        r.prefixLength !== null ||
        r.indexType !== "BTREE",
    )
  )
    throw new MigrationVerificationError("Binding identity indexes differ");
  const [keys] = await c.execute<RowDataPacket[]>(
    "SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,k.ORDINAL_POSITION,r.DELETE_RULE,r.UPDATE_RULE,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS localReference FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? ORDER BY k.ORDINAL_POSITION",
    [table],
  );
  const expectedKeys =
    table === "source_binding_identity"
      ? [
          "source_binding_identity_fk|workspaceId|workspace_data_source|workspaceId|1|CASCADE|NO ACTION",
          "source_binding_identity_fk|sourceId|workspace_data_source|sourceId|2|CASCADE|NO ACTION",
        ]
      : table === "mutation_preview_binding"
        ? ["mutation_preview_binding_fk|previewId|mutation_preview|id|1|CASCADE|NO ACTION"]
        : [];
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      (r, i) =>
        Number(r.localReference) !== 1 ||
        [
          r.CONSTRAINT_NAME,
          r.COLUMN_NAME,
          r.REFERENCED_TABLE_NAME,
          r.REFERENCED_COLUMN_NAME,
          Number(r.ORDINAL_POSITION),
          r.DELETE_RULE,
          r.UPDATE_RULE,
        ].join("|") !== expectedKeys[i],
    )
  )
    throw new MigrationVerificationError("Binding identity foreign keys differ");
  const [unexpected] = await c.execute<RowDataPacket[]>(
    "SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?) + (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK') AS count",
    [table, table],
  );
  if (Number(unexpected[0]?.count) !== 0)
    throw new MigrationVerificationError("Binding identity has unexpected rules");
}
export async function bindingIdentitiesAvailable(c: PoolConnection): Promise<boolean> {
  const existing = await present(c);
  if (!existing.length) return false;
  if (
    existing.length !== tables.length ||
    existing.some(
      (r) =>
        r.TABLE_TYPE !== "BASE TABLE" ||
        r.ENGINE !== "InnoDB" ||
        r.TABLE_COLLATION !== "utf8mb4_0900_ai_ci",
    )
  )
    throw new MigrationVerificationError("Binding identity migration is incomplete");
  for (const table of tables) await inspectTable(c, table);
  const file = await definition();
  const [version] = await c.query<RowDataPacket[]>(
    "SELECT version,checksum FROM binding_identity_schema",
  );
  if (version.length !== 1 || version[0]?.version !== 1 || version[0]?.checksum !== file.checksum)
    throw new MigrationVerificationError("Binding identity migration is not current");
  return true;
}

/** Explicit, resumable forward migration. Caller must stop binding writers first. */
export async function migrateBindingIdentities(
  pool: Pool,
  afterStep?: (step: string) => Promise<void>,
) {
  const c = await pool.getConnection();
  let locked = false;
  let lockName = "";
  try {
    const [db] = await c.query<RowDataPacket[]>("SELECT DATABASE() AS name");
    if (!db[0]?.name) throw new MigrationVerificationError("Binding migration requires a database");
    lockName = `binding-migrate-${createHash("sha256").update(String(db[0].name)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<RowDataPacket[]>("SELECT GET_LOCK(?,5) AS acquired", [lockName]);
    if (Number(lock[0]?.acquired) !== 1)
      throw new MigrationVerificationError("Binding migration lock unavailable");
    locked = true;
    await inspectStage3(c);
    await inspectMutationSchema(c);
    const file = await definition();
    const existing = await present(c);
    if (
      existing.some(
        (r) =>
          r.TABLE_TYPE !== "BASE TABLE" ||
          r.ENGINE !== "InnoDB" ||
          r.TABLE_COLLATION !== "utf8mb4_0900_ai_ci",
      )
    )
      throw new MigrationVerificationError("Binding identity table differs");
    for (const row of existing) await inspectTable(c, String(row.TABLE_NAME));
    const statements = file.sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      if (!table) throw new MigrationVerificationError("Binding definition incomplete");
      if (!existing.some((r) => r.TABLE_NAME === table)) await c.query(statements[i] ?? "");
      await inspectTable(c, table);
      await afterStep?.(`table:${table}`);
    }
    const [version] = await c.query<RowDataPacket[]>(
      "SELECT version,checksum FROM binding_identity_schema",
    );
    if (
      version.length &&
      (version.length !== 1 || version[0]?.version !== 1 || version[0]?.checksum !== file.checksum)
    )
      throw new MigrationVerificationError("Binding migration checksum differs");
    // Lock actual binding rows in bounded batches. Missing rows are never recreated.
    for (;;) {
      await c.beginTransaction();
      try {
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT b.workspaceId,b.sourceId FROM workspace_data_source b LEFT JOIN source_binding_identity i ON i.workspaceId=b.workspaceId AND i.sourceId=b.sourceId WHERE i.generation IS NULL ORDER BY b.workspaceId,b.sourceId LIMIT 100 FOR UPDATE",
        );
        for (const row of rows) {
          await c.execute(
            "INSERT INTO source_binding_identity(workspaceId,sourceId,generation) VALUES(?,?,?)",
            [row.workspaceId, row.sourceId, randomUUID()],
          );
          await afterStep?.("backfill-row");
        }
        await c.commit();
        await afterStep?.("backfill-batch");
        if (!rows.length) break;
      } catch (error) {
        await c.rollback();
        throw error;
      }
    }
    const [invalid] = await c.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM source_binding_identity WHERE generation NOT REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'",
    );
    if (Number(invalid[0]?.count) !== 0)
      throw new MigrationVerificationError("Binding generation format differs");
    await afterStep?.("verified");
    if (!version.length)
      await c.execute("INSERT INTO binding_identity_schema(version,checksum) VALUES(1,?)", [
        file.checksum,
      ]);
    await afterStep?.("recorded");
    await bindingIdentitiesAvailable(c);
  } finally {
    try {
      if (locked) await c.execute("DO RELEASE_LOCK(?)", [lockName]);
    } finally {
      c.release();
    }
  }
}
