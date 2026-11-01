import { readMigrationCommand } from "./migration-command.js";
import { OperationalError } from "./operational-error.js";
import { MigrationVerificationError } from "./migration-error.js";
import { createHash } from "node:crypto";
import { diagnostics } from "./logging/public.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { createDatabase } from "./auth.js";
import {
  inspectStage3,
  stage3MigrationFile,
  stage3TableCount,
} from "./datasources/stage3-schema.js";
import { inspectStage7, stage7MigrationFile, stage7TableCount } from "./history/migration.js";
import { apiPackageRoot } from "./package-path.js";
import { inspectStage8, stage8MigrationFile, stage8TableCount } from "./mutations/migration.js";
import { inspectStage6, stage6MigrationFile, stage6TableCount } from "./semantic/migration.js";

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLLATION_NAME: string | null;
}
interface IndexRow extends RowDataPacket {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number;
  SEQ_IN_INDEX: number;
  COLUMN_NAME: string;
}
interface MigrationRow extends RowDataPacket {
  version: string;
  checksum: string;
}
interface ScalarRow extends RowDataPacket {
  value: string | number | null;
}

const initialColumns: Record<string, string[]> = {
  user: [
    "id",
    "name",
    "email",
    "emailVerified",
    "image",
    "username",
    "displayUsername",
    "createdAt",
    "updatedAt",
  ],
  session: [
    "id",
    "expiresAt",
    "token",
    "createdAt",
    "updatedAt",
    "ipAddress",
    "userAgent",
    "userId",
  ],
  account: [
    "id",
    "accountId",
    "providerId",
    "userId",
    "accessToken",
    "refreshToken",
    "idToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "scope",
    "password",
    "createdAt",
    "updatedAt",
  ],
  verification: ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"],
  workspace: ["id", "name", "description", "createdByAccountId", "createdAt", "updatedAt"],
};
// Type, nullability and collation form part of the baseline, not just column names.
const specifications: Record<string, Record<string, string>> = {
  user: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    name: "varchar(100)|NO|utf8mb4_0900_ai_ci",
    email: "varchar(255)|NO|utf8mb4_0900_ai_ci",
    emailVerified: "tinyint(1)|NO|",
    image: "text|YES|utf8mb4_0900_ai_ci",
    username: "varchar(64)|YES|utf8mb4_0900_ai_ci",
    displayUsername: "varchar(64)|YES|utf8mb4_0900_ai_ci",
    createdAt: "datetime(3)|NO|",
    updatedAt: "datetime(3)|NO|",
  },
  session: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    expiresAt: "datetime(3)|NO|",
    token: "varchar(255)|NO|ascii_bin",
    createdAt: "datetime(3)|NO|",
    updatedAt: "datetime(3)|NO|",
    ipAddress: "text|YES|utf8mb4_0900_ai_ci",
    userAgent: "text|YES|utf8mb4_0900_ai_ci",
    userId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
  },
  account: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    accountId: "varchar(255)|NO|utf8mb4_0900_ai_ci",
    providerId: "varchar(100)|NO|utf8mb4_0900_ai_ci",
    userId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    accessToken: "text|YES|utf8mb4_0900_ai_ci",
    refreshToken: "text|YES|utf8mb4_0900_ai_ci",
    idToken: "text|YES|utf8mb4_0900_ai_ci",
    accessTokenExpiresAt: "datetime(3)|YES|",
    refreshTokenExpiresAt: "datetime(3)|YES|",
    scope: "text|YES|utf8mb4_0900_ai_ci",
    password: "text|YES|utf8mb4_0900_ai_ci",
    createdAt: "datetime(3)|NO|",
    updatedAt: "datetime(3)|NO|",
  },
  verification: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    identifier: "varchar(255)|NO|utf8mb4_0900_ai_ci",
    value: "text|NO|utf8mb4_0900_ai_ci",
    expiresAt: "datetime(3)|NO|",
    createdAt: "datetime(3)|NO|",
    updatedAt: "datetime(3)|NO|",
  },
  workspace: {
    id: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    name: "varchar(120)|NO|utf8mb4_0900_ai_ci",
    description: "text|YES|utf8mb4_0900_ai_ci",
    createdByAccountId: "varchar(36)|NO|utf8mb4_0900_ai_ci",
    createdAt: "datetime(3)|NO|",
    updatedAt: "datetime(3)|NO|",
  },
};
const indexes: Record<string, Array<[string, string[], boolean]>> = {
  user: [
    ["PRIMARY", ["id"], true],
    ["email", ["email"], true],
    ["username", ["username"], true],
  ],
  session: [
    ["PRIMARY", ["id"], true],
    ["token", ["token"], true],
    ["session_user_id", ["userId"], false],
  ],
  account: [
    ["PRIMARY", ["id"], true],
    ["account_user_id", ["userId"], false],
    ["account_provider_identity", ["providerId", "accountId"], true],
  ],
  verification: [
    ["PRIMARY", ["id"], true],
    ["verification_identifier", ["identifier"], false],
  ],
  workspace: [
    ["PRIMARY", ["id"], true],
    ["workspace_owner", ["createdByAccountId", "createdAt"], false],
  ],
};
const names = Object.keys(initialColumns);
async function getColumns(c: PoolConnection): Promise<ColumnRow[]> {
  const [rows] = await c.query<ColumnRow[]>(
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user','session','account','verification','workspace')",
  );
  return rows;
}
async function inspect(c: PoolConnection): Promise<"empty" | "baseline" | "archived"> {
  const columns = await getColumns(c);
  if (columns.length === 0) return "empty";
  const archived = columns.some(
    (r) => r.TABLE_NAME === "workspace" && r.COLUMN_NAME === "archivedAt",
  );
  for (const table of names) {
    const baselineColumns = initialColumns[table];
    if (!baselineColumns) throw new MigrationVerificationError(`Unknown table ${table}`);
    const expected = [
      ...baselineColumns,
      ...(table === "workspace" && archived ? ["archivedAt"] : []),
    ].sort();
    const actual = columns
      .filter((r) => r.TABLE_NAME === table)
      .map((r) => r.COLUMN_NAME)
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new MigrationVerificationError(
        `Schema differs in ${table}; refusing to assume a migration baseline`,
      );
  }
  for (const row of columns) {
    if (row.TABLE_NAME === "workspace" && row.COLUMN_NAME === "archivedAt") continue;
    const actual = [row.COLUMN_TYPE, row.IS_NULLABLE, row.COLLATION_NAME ?? ""].join("|");
    if (specifications[row.TABLE_NAME]?.[row.COLUMN_NAME] !== actual)
      throw new MigrationVerificationError(
        `Schema column ${row.TABLE_NAME}.${row.COLUMN_NAME} does not match baseline`,
      );
  }
  const [engines] = await c.query<ScalarRow[]>(
    "SELECT COUNT(*) AS value FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('user','session','account','verification','workspace') AND ENGINE = 'InnoDB'",
  );
  if (Number(engines[0]?.value) !== 5)
    throw new MigrationVerificationError("Tables must use InnoDB");
  const token = columns.find((r) => r.TABLE_NAME === "session" && r.COLUMN_NAME === "token");
  if (
    token?.COLUMN_TYPE !== "varchar(255)" ||
    token.IS_NULLABLE !== "NO" ||
    token.COLLATION_NAME !== "ascii_bin"
  )
    throw new MigrationVerificationError("Session token column does not match baseline");
  if (
    archived &&
    !columns.some(
      (r) =>
        r.TABLE_NAME === "workspace" &&
        r.COLUMN_NAME === "archivedAt" &&
        r.COLUMN_TYPE === "datetime(3)" &&
        r.IS_NULLABLE === "YES",
    )
  )
    throw new MigrationVerificationError("Archive column does not match migration");
  const [indexRows] = await c.query<IndexRow[]>(
    "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('user','session','account','verification','workspace') ORDER BY SEQ_IN_INDEX",
  );
  for (const [table, definitions] of Object.entries(indexes)) {
    const required = [
      ...definitions,
      ...(table === "workspace" && archived
        ? [
            ["workspace_owner_archive", ["createdByAccountId", "archivedAt", "id"], false] as [
              string,
              string[],
              boolean,
            ],
          ]
        : []),
    ];
    for (const [index, fields, unique] of required) {
      const actual = indexRows.filter((r) => r.TABLE_NAME === table && r.INDEX_NAME === index);
      if (
        JSON.stringify(actual.map((r) => r.COLUMN_NAME)) !== JSON.stringify(fields) ||
        actual.some((r) => Number(r.NON_UNIQUE) !== (unique ? 0 : 1))
      )
        throw new MigrationVerificationError(
          `Schema index ${table}.${index} does not match baseline`,
        );
    }
  }
  const [fk] = await c.query<ScalarRow[]>(
    "SELECT COUNT(*) AS value FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='session' AND COLUMN_NAME='userId' AND REFERENCED_TABLE_NAME='user' AND REFERENCED_COLUMN_NAME='id') OR (TABLE_NAME='account' AND COLUMN_NAME='userId' AND REFERENCED_TABLE_NAME='user' AND REFERENCED_COLUMN_NAME='id') OR (TABLE_NAME='workspace' AND COLUMN_NAME='createdByAccountId' AND REFERENCED_TABLE_NAME='user' AND REFERENCED_COLUMN_NAME='id'))",
  );
  if (Number(fk[0]?.value) !== 3)
    throw new MigrationVerificationError("Foreign keys do not match baseline");
  const [rules] = await c.query<ScalarRow[]>(
    "SELECT COUNT(*) AS value FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND ((CONSTRAINT_NAME IN ('session_user_fk', 'account_user_fk') AND DELETE_RULE='CASCADE') OR (CONSTRAINT_NAME='workspace_owner_fk' AND DELETE_RULE='RESTRICT'))",
  );
  if (Number(rules[0]?.value) !== 3)
    throw new MigrationVerificationError("Foreign key delete rules do not match baseline");
  return archived ? "archived" : "baseline";
}

async function migrationFile(name: string): Promise<{ sql: string; checksum: string }> {
  const packageDir = apiPackageRoot();
  const sql = (await readFile(resolve(packageDir, "migrations", name), "utf8")).replace(
    /^\uFEFF/,
    "",
  );
  return { sql, checksum: createHash("sha256").update(sql).digest("hex") };
}

/** MySQL DDL commits implicitly; on restart inspect the exact known state before recording completion. */
export async function migrateDatabase(pool: Pool): Promise<void> {
  const c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<ScalarRow[]>("SELECT DATABASE() AS value");
    if (!db[0]?.value) throw new OperationalError("MIGRATION_NO_DATABASE");
    const lockName = `aw-migrate-${createHash("sha256").update(String(db[0].value)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<ScalarRow[]>("SELECT GET_LOCK(?, 15) AS value", [lockName]);
    if (Number(lock[0]?.value) !== 1) throw new OperationalError("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    const first = await migrationFile("001-auth-workspaces.sql");
    const second = await migrationFile("002-workspace-archive.sql");
    const third = await stage3MigrationFile();
    const fourth = await stage6MigrationFile();
    const fifth = await stage7MigrationFile();
    const sixth = await stage8MigrationFile();
    let state = await inspect(c);
    const [historyExists] = await c.query<ScalarRow[]>(
      "SELECT COUNT(*) AS value FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='_workspace_migrations'",
    );
    if (Number(historyExists[0]?.value)) {
      const [history] = await c.query<MigrationRow[]>(
        "SELECT version, checksum FROM `_workspace_migrations`",
      );
      for (const item of history) {
        const expected =
          item.version === "001"
            ? first.checksum
            : item.version === "002"
              ? second.checksum
              : item.version === "003"
                ? third.checksum
                : item.version === "004"
                  ? fourth.checksum
                  : item.version === "005"
                    ? fifth.checksum
                    : item.version === "006"
                      ? sixth.checksum
                      : null;
        if (!expected || expected !== item.checksum)
          throw new MigrationVerificationError(`Unknown or altered migration ${item.version}`);
      }
      if (history.some((x) => x.version === "002") && state !== "archived")
        throw new MigrationVerificationError("Migration history does not match schema");
      if (history.some((x) => x.version === "001") && state === "empty")
        throw new MigrationVerificationError("Migration history does not match schema");
      if (history.some((x) => x.version === "003")) {
        if (
          !history.some((x) => x.version === "001") ||
          !history.some((x) => x.version === "002") ||
          state !== "archived"
        )
          throw new MigrationVerificationError("Migration history does not match schema");
        await inspectStage3(c);
      }
      if (history.some((x) => x.version === "004")) {
        if (!history.some((x) => x.version === "003"))
          throw new MigrationVerificationError("Semantic migration requires stage 3");
        await inspectStage6(c);
      }
      if (history.some((x) => x.version === "005")) {
        if (!history.some((x) => x.version === "004"))
          throw new MigrationVerificationError("History migration requires semantics");
        await inspectStage7(c);
      }
      if (history.some((x) => x.version === "006")) {
        if (!history.some((x) => x.version === "005"))
          throw new MigrationVerificationError("Mutations require history migration");
        await inspectStage8(c);
      }
    }
    if (state === "empty") {
      for (const statement of first.sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await c.query(statement);
      state = await inspect(c);
      if (state !== "baseline")
        throw new MigrationVerificationError("Baseline verification failed");
    }
    await c.query(
      "CREATE TABLE IF NOT EXISTS `_workspace_migrations` (version VARCHAR(32) NOT NULL PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, appliedAt DATETIME(3) NOT NULL) ENGINE=InnoDB",
    );
    await c.execute(
      "INSERT IGNORE INTO `_workspace_migrations` (version, checksum, appliedAt) VALUES ('001', ?, UTC_TIMESTAMP(3))",
      [first.checksum],
    );
    if (state === "baseline") {
      await c.query(second.sql.trim().replace(/;\s*$/, ""));
      state = await inspect(c);
      if (state !== "archived")
        throw new MigrationVerificationError("Archive migration verification failed");
    }
    await c.execute(
      "INSERT IGNORE INTO `_workspace_migrations` (version, checksum, appliedAt) VALUES ('002', ?, UTC_TIMESTAMP(3))",
      [second.checksum],
    );
    await c.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    locked = false;
  } finally {
    if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    c.release();
  }
}

async function inspectCurrentConnection(
  c: PoolConnection,
  stage3Enabled = false,
  stage6Enabled = false,
  stage7Enabled = false,
  stage8Enabled = false,
): Promise<{
  hasStage3: boolean;
  hasSemantics: boolean;
  hasHistory: boolean;
  hasMutations: boolean;
}> {
  if ((await inspect(c)) !== "archived")
    throw new MigrationVerificationError("Database schema is not at the current migration version");
  const [history] = await c.query<MigrationRow[]>(
    "SELECT version, checksum FROM _workspace_migrations ORDER BY version",
  );
  const files = await Promise.all([
    migrationFile("001-auth-workspaces.sql"),
    migrationFile("002-workspace-archive.sql"),
    stage3MigrationFile(),
    stage6MigrationFile(),
    stage7MigrationFile(),
    stage8MigrationFile(),
  ]);
  if (
    history.length < 2 ||
    history.length > 6 ||
    history.some(
      (entry, i) => entry.version !== `00${i + 1}` || entry.checksum !== files[i]?.checksum,
    ) ||
    (stage3Enabled && history.length < 3) ||
    (stage6Enabled && history.length < 4) ||
    (stage7Enabled && history.length < 5) ||
    (stage8Enabled && history.length !== 6)
  )
    throw new MigrationVerificationError(
      "Database migration history is missing or differs from the SQL files",
    );
  if (history.length < 4 && (await stage6TableCount(c)) !== 0)
    throw new MigrationVerificationError(
      "Semantic table exists without verified history; inspect manually",
    );
  if (history.length >= 3) await inspectStage3(c);
  if (history.length < 5 && (await stage7TableCount(c)) !== 0)
    throw new MigrationVerificationError(
      "History table exists without verified history; inspect manually",
    );
  if (history.length >= 4) await inspectStage6(c);
  if (history.length >= 5) await inspectStage7(c);
  if (history.length < 6 && (await stage8TableCount(c)) !== 0)
    throw new MigrationVerificationError(
      "Mutation tables exist without verified history; inspect manually",
    );
  if (history.length === 6) await inspectStage8(c);
  return {
    hasStage3: history.length >= 3,
    hasSemantics: history.length >= 4,
    hasHistory: history.length >= 5,
    hasMutations: history.length === 6,
  };
}

/** Read-only startup check. Running migrations is always an explicit operation. */
export async function verifyDatabaseCurrent(
  pool: Pool,
  stage3Enabled = false,
  stage6Enabled = false,
  stage7Enabled = false,
  stage8Enabled = false,
) {
  const c = await pool.getConnection();
  try {
    return await inspectCurrentConnection(
      c,
      stage3Enabled,
      stage6Enabled,
      stage7Enabled,
      stage8Enabled,
    );
  } finally {
    c.release();
  }
}

/** Explicit, fail-closed migration: ambiguous partial DDL requires manual review. */
export async function migrateStage3(pool: Pool): Promise<void> {
  const c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<ScalarRow[]>("SELECT DATABASE() AS value");
    if (!db[0]?.value) throw new OperationalError("MIGRATION_NO_DATABASE");
    const lockName = `aw-migrate-${createHash("sha256").update(String(db[0].value)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<ScalarRow[]>("SELECT GET_LOCK(?, 15) AS value", [lockName]);
    if (Number(lock[0]?.value) !== 1) throw new OperationalError("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    if ((await inspect(c)) !== "archived")
      throw new MigrationVerificationError("Existing migrations must be verified first");
    const [history] = await c.query<MigrationRow[]>(
      "SELECT version, checksum FROM _workspace_migrations ORDER BY version",
    );
    const first = await migrationFile("001-auth-workspaces.sql");
    const second = await migrationFile("002-workspace-archive.sql");
    const third = await stage3MigrationFile();
    if (
      history.length < 2 ||
      history.length > 6 ||
      history[0]?.version !== "001" ||
      history[0]?.checksum !== first.checksum ||
      history[1]?.version !== "002" ||
      history[1]?.checksum !== second.checksum
    )
      throw new MigrationVerificationError("Existing migration history differs");
    if (history.length >= 3) {
      if (history[2]?.version !== "003" || history[2]?.checksum !== third.checksum)
        throw new MigrationVerificationError("Stage 3 migration history differs");
      await inspectStage3(c);
      if (history.length >= 4) {
        const fourth = await stage6MigrationFile();
        if (history[3]?.version !== "004" || history[3]?.checksum !== fourth.checksum)
          throw new MigrationVerificationError("Stage 6 migration history differs");
        await inspectStage6(c);
      }
      if (history.length >= 5) {
        const fifth = await stage7MigrationFile();
        if (history[4]?.version !== "005" || history[4]?.checksum !== fifth.checksum)
          throw new MigrationVerificationError("Stage 7 migration history differs");
        await inspectStage7(c);
      }
      if (history.length === 6) {
        const sixth = await stage8MigrationFile();
        if (history[5]?.version !== "006" || history[5]?.checksum !== sixth.checksum)
          throw new MigrationVerificationError("Mutation migration history differs");
        await inspectStage8(c);
      }
    } else {
      if ((await stage3TableCount(c)) !== 0)
        throw new MigrationVerificationError(
          "Stage 3 tables already exist without verified history; inspect manually",
        );
      for (const statement of third.sql
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean))
        await c.query(statement);
      await inspectStage3(c);
      await c.execute(
        "INSERT INTO _workspace_migrations (version, checksum, appliedAt) VALUES ('003', ?, UTC_TIMESTAMP(3))",
        [third.checksum],
      );
    }
    await c.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    locked = false;
  } finally {
    if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    c.release();
  }
}

/** Stage 6 is explicit and refuses an ambiguous partial migration. */
export async function migrateStage6(pool: Pool): Promise<void> {
  const c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<ScalarRow[]>("SELECT DATABASE() AS value");
    if (!db[0]?.value) throw new OperationalError("MIGRATION_NO_DATABASE");
    const lockName = `aw-migrate-${createHash("sha256").update(String(db[0].value)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<ScalarRow[]>("SELECT GET_LOCK(?, 15) AS value", [lockName]);
    if (Number(lock[0]?.value) !== 1) throw new OperationalError("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    if ((await inspect(c)) !== "archived")
      throw new MigrationVerificationError("Existing migrations must be verified first");
    const [history] = await c.query<MigrationRow[]>(
      "SELECT version, checksum FROM _workspace_migrations ORDER BY version",
    );
    const files = await Promise.all([
      migrationFile("001-auth-workspaces.sql"),
      migrationFile("002-workspace-archive.sql"),
      stage3MigrationFile(),
      stage6MigrationFile(),
      stage7MigrationFile(),
      stage8MigrationFile(),
    ]);
    if (
      history.length < 3 ||
      history.length > 6 ||
      history.some(
        (entry, i) => entry.version !== `00${i + 1}` || entry.checksum !== files[i]?.checksum,
      )
    )
      throw new MigrationVerificationError("Existing migration history differs");
    await inspectStage3(c);
    if (history.length >= 4) {
      await inspectStage6(c);
      if (history.length >= 5) await inspectStage7(c);
      if (history.length === 6) await inspectStage8(c);
    } else {
      if ((await stage6TableCount(c)) !== 0)
        throw new MigrationVerificationError(
          "Semantic table exists without verified history; inspect manually",
        );
      const fourth = files[3];
      if (!fourth) throw new MigrationVerificationError("Semantic migration missing");
      await c.query(fourth.sql.trim().replace(/;\s*$/, ""));
      await inspectStage6(c);
      await c.execute(
        "INSERT INTO _workspace_migrations (version, checksum, appliedAt) VALUES ('004', ?, UTC_TIMESTAMP(3))",
        [fourth.checksum],
      );
    }
    await c.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    locked = false;
  } finally {
    if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    c.release();
  }
}

/** Local history is opt-in; partial DDL is inspected and never erased automatically. */
export async function migrateStage7(pool: Pool): Promise<void> {
  const c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<ScalarRow[]>("SELECT DATABASE() AS value");
    if (!db[0]?.value) throw new OperationalError("MIGRATION_NO_DATABASE");
    const lockName = `aw-migrate-${createHash("sha256").update(String(db[0].value)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<ScalarRow[]>("SELECT GET_LOCK(?, 15) AS value", [lockName]);
    if (Number(lock[0]?.value) !== 1) throw new OperationalError("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    if ((await inspect(c)) !== "archived")
      throw new MigrationVerificationError("Existing migrations must be verified first");
    const [history] = await c.query<MigrationRow[]>(
      "SELECT version, checksum FROM _workspace_migrations ORDER BY version",
    );
    const files = await Promise.all([
      migrationFile("001-auth-workspaces.sql"),
      migrationFile("002-workspace-archive.sql"),
      stage3MigrationFile(),
      stage6MigrationFile(),
      stage7MigrationFile(),
      stage8MigrationFile(),
    ]);
    if (
      history.length < 4 ||
      history.length > 6 ||
      history.some(
        (entry, i) => entry.version !== `00${i + 1}` || entry.checksum !== files[i]?.checksum,
      )
    )
      throw new MigrationVerificationError("Existing migration history differs");
    await inspectStage3(c);
    await inspectStage6(c);
    if (history.length >= 5) {
      await inspectStage7(c);
      if (history.length === 6) await inspectStage8(c);
    } else {
      if ((await stage7TableCount(c)) !== 0)
        throw new MigrationVerificationError(
          "History table exists without verified history; inspect manually",
        );
      const file = files[4];
      if (!file) throw new MigrationVerificationError("History migration missing");
      await c.query(file.sql.trim().replace(/;\s*$/, ""));
      await inspectStage7(c);
      await c.execute(
        "INSERT INTO _workspace_migrations (version,checksum,appliedAt) VALUES ('005',?,UTC_TIMESTAMP(3))",
        [file.checksum],
      );
    }
    await c.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    locked = false;
  } finally {
    if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    c.release();
  }
}

/** An explicit migration only. Application startup never installs mutation tables. */
export async function migrateStage8(pool: Pool): Promise<void> {
  const c = await pool.getConnection();
  let locked = false;
  try {
    const [db] = await c.query<ScalarRow[]>("SELECT DATABASE() AS value");
    if (!db[0]?.value) throw new OperationalError("MIGRATION_NO_DATABASE");
    const lockName = `aw-migrate-${createHash("sha256").update(String(db[0].value)).digest("hex").slice(0, 40)}`;
    const [lock] = await c.execute<ScalarRow[]>("SELECT GET_LOCK(?,15) AS value", [lockName]);
    if (Number(lock[0]?.value) !== 1) throw new OperationalError("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    const current = await inspectCurrentConnection(c, true, true, true);
    if (!current.hasMutations) {
      if ((await stage8TableCount(c)) !== 0)
        throw new MigrationVerificationError("Partial mutation schema requires manual review");
      const file = await stage8MigrationFile();
      for (const statement of file.sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await c.query(statement);
      await inspectStage8(c);
      await c.execute(
        "INSERT INTO _workspace_migrations(version,checksum,appliedAt) VALUES ('006',?,UTC_TIMESTAMP(3))",
        [file.checksum],
      );
    }
    await c.query("SELECT RELEASE_LOCK(?)", [lockName]);
    locked = false;
  } finally {
    if (locked) await c.query("DO RELEASE_ALL_LOCKS()");
    c.release();
  }
}

async function main() {
  const { databaseUrl, stage } = readMigrationCommand(process.env, process.argv.slice(2));
  const pool = createDatabase(databaseUrl);
  try {
    if (stage === "stage3") await migrateStage3(pool);
    else if (stage === "stage6") await migrateStage6(pool);
    else if (stage === "stage7") await migrateStage7(pool);
    else if (stage === "stage8") await migrateStage8(pool);
    else await migrateDatabase(pool);
    console.log("Database migrations verified and applied.");
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    diagnostics.error("migration.failed", {}, error);
    process.exitCode = 1;
  });
}
