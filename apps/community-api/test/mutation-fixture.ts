import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { authSessionReferenceActive } from "../src/auth.js";
import { DataSourceStore } from "../src/datasources/store.js";
import { migrateDatabase, migrateStage3 } from "../src/migrations.js";
import { inspectStage8, stage8MigrationFile } from "../src/mutations/migration.js";
import type { MutationBinding, PreviewMetadata } from "../src/mutations/model.js";
import { MutationStore } from "../src/mutations/store.js";

/** This fixture has no .env path or default connection. Every checkout is pinned before SQL. */
export async function mutationFixture() {
  const file = process.env.STAGE8_G3_MANIFEST;
  if (!file) throw Error("STAGE8_G3_MANIFEST must identify a freshly isolated instance");
  const resolved = path.resolve(file);
  if (
    !/[\\/]\.cache[\\/]stage8-g2-[0-9a-f]{32}[\\/]manifest\.json$/.test(resolved) ||
    (await fs.realpath(resolved)) !== resolved
  )
    throw Error("invalid isolated manifest path");
  const manifest: unknown = JSON.parse(await fs.readFile(resolved, "utf8"));
  if (!manifest || typeof manifest !== "object") throw Error("invalid isolated manifest");
  const get = (name: string): unknown => Reflect.get(manifest, name);
  if (
    get("host") !== "127.0.0.1" ||
    get("port") !== 13308 ||
    get("format") !== "stackoryn-stage8-g2-v1" ||
    get("adminUser") !== "root" ||
    typeof get("adminPassword") !== "string" ||
    !/^[0-9a-f]{64}$/.test(String(get("adminPassword"))) ||
    typeof get("serverUuid") !== "string" ||
    !/^[0-9a-f-]{36}$/.test(String(get("serverUuid")))
  )
    throw Error("manifest is not the fresh allowed instance");
  const dataDir = path.join(path.dirname(resolved), "mysql-data"),
    pidFile = path.join(path.dirname(resolved), "mysql.pid");
  if (
    path.resolve(String(get("dataDir"))) !== dataDir ||
    path.resolve(String(get("pidFile"))) !== pidFile ||
    (await fs.realpath(dataDir)) !== dataDir ||
    !(await fs.readFile(path.join(dataDir, "auto.cnf"), "utf8")).includes(
      `server-uuid=${get("serverUuid")}`,
    )
  )
    throw Error("isolated data identity mismatch");
  const options = {
    host: "127.0.0.1",
    port: 13308,
    user: "root",
    password: String(get("adminPassword")),
    timezone: "Z",
    multipleStatements: false,
    connectionLimit: 8,
  };
  async function verify(c: Pick<mysql.Connection, "query">) {
    const [rows] = await c.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port,@@datadir AS dir,@@server_uuid AS uuid,@@pid_file AS pid",
    );
    if (
      rows[0]?.port !== 13308 ||
      path.resolve(String(rows[0]?.dir)) !== dataDir ||
      rows[0]?.uuid !== get("serverUuid") ||
      path.resolve(String(rows[0]?.pid)) !== pidFile ||
      (await fs.readFile(pidFile, "utf8")).trim() !== String(get("ownerPid"))
    )
      throw Error("isolated target identity changed; fixture SQL refused");
  }
  const admin = await mysql.createConnection(options);
  await verify(admin);
  const database = `g3_mut_api_${randomBytes(8).toString("hex")}`;
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  const rawPool = mysql.createPool({ ...options, database });
  const checkedConnection = async () => {
    const c = await rawPool.getConnection();
    try {
      await verify(c);
      return c;
    } catch (error) {
      c.release();
      throw error;
    }
  };
  const pool = new Proxy(rawPool, {
    get(target, key, receiver) {
      if (key === "getConnection") return checkedConnection;
      if (key === "execute" || key === "query")
        return async (...args: unknown[]) => {
          const c = await checkedConnection();
          try {
            return await Reflect.apply(Reflect.get(c, key), c, args);
          } finally {
            c.release();
          }
        };
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  async function close() {
    await pool.end();
    try {
      await verify(admin);
      await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.end();
    }
  }
  try {
    await migrateDatabase(pool);
    await migrateStage3(pool);
    const c = await pool.getConnection();
    try {
      const { sql } = await stage8MigrationFile();
      for (const statement of sql
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await c.query(statement);
      await inspectStage8(c);
    } finally {
      c.release();
    }
    const binding: MutationBinding = {
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
      connectorId: randomUUID(),
    };
    const sessionId = randomUUID();
    await pool.execute(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'isolated',?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.ownerId, `${binding.ownerId}@example.invalid`],
    );
    await pool.execute(
      "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'isolated',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.workspaceId, binding.ownerId],
    );
    await pool.execute(
      "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'isolated',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.sourceId, binding.ownerId, binding.connectorId],
    );
    await pool.execute(
      "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
      [binding.workspaceId, binding.sourceId],
    );
    await pool.execute(
      "INSERT INTO session (id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [sessionId, binding.ownerId, randomBytes(32).toString("hex")],
    );
    const boot = randomBytes(32).toString("hex");
    const sources = new DataSourceStore(pool);
    const store = new MutationStore(pool, sources, boot, authSessionReferenceActive);
    const preview = (overrides: Partial<PreviewMetadata> = {}): PreviewMetadata => ({
      previewId: randomUUID(),
      commitment: randomBytes(32).toString("base64url"),
      revision: 1,
      apiBoot: boot,
      connectorBoot: randomBytes(32).toString("hex"),
      targetIdentity: `isolated:${database}`,
      targetEpoch: randomBytes(32).toString("hex"),
      policyGeneration: "1",
      installationGeneration: "1",
      operation: "update",
      table: "customers",
      rowCount: 1,
      expiresAt: new Date(Date.now() + 100000).toISOString(),
      ...overrides,
    });
    return { pool, database, binding, sessionId, boot, store, sources, preview, close };
  } catch (error) {
    await close();
    throw error;
  }
}
