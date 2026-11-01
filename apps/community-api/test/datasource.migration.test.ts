import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { migrateDatabase, migrateStage3, verifyDatabaseCurrent } from "../src/migrations.js";

test("stage 3 migration preserves baseline and fails closed on partial DDL", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const connection = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
  };
  const admin = await mysql.createConnection(connection);
  let verified = false;
  const suffix = randomBytes(6).toString("hex");
  const names = [`stage3_mig_${suffix}`, `stage3_partial_${suffix}`];
  const created: string[] = [];
  try {
    const [rows] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port, @@datadir AS dir",
    );
    const instance = rows[0];
    if (
      instance?.port !== 13307 ||
      !String(instance.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw new Error("unexpected test database");
    verified = true;
    for (const name of names) {
      await admin.query(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      created.push(name);
    }
    const pool = mysql.createPool({ ...connection, database: names[0] });
    try {
      await migrateDatabase(pool);
      const user = randomUUID();
      const workspace = randomUUID();
      await pool.execute(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'fixture', ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [user, `${user}@example.invalid`],
      );
      await pool.execute(
        "INSERT INTO workspace (id, name, createdByAccountId, createdAt, updatedAt) VALUES (?, 'fixture', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [workspace, user],
      );
      await assert.rejects(() => verifyDatabaseCurrent(pool, true));
      await migrateStage3(pool);
      await migrateStage3(pool);
      await verifyDatabaseCurrent(pool, true);
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM workspace WHERE id = ? AND createdByAccountId = ?",
        [workspace, user],
      );
      assert.equal(rows.length, 1);
      await pool.query("ALTER TABLE schema_scan MODIFY COLUMN `sequence` bigint unsigned NOT NULL");
      await assert.rejects(() => verifyDatabaseCurrent(pool, true), /auto-incrementing/);
      await assert.rejects(() => migrateStage3(pool), /auto-incrementing/);
    } finally {
      await pool.end();
    }
    const partial = mysql.createPool({ ...connection, database: names[1] });
    try {
      await migrateDatabase(partial);
      await partial.query("CREATE TABLE data_source (fixture INT NOT NULL)");
      await partial.query("INSERT INTO data_source VALUES (7)");
      await assert.rejects(() => migrateStage3(partial), /inspect manually/);
      const [rows] = await partial.query<mysql.RowDataPacket[]>("SELECT fixture FROM data_source");
      assert.equal(rows[0]?.fixture, 7);
    } finally {
      await partial.end();
    }
  } finally {
    if (verified) for (const name of created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
