import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { DataSourceStore } from "../src/datasources/store.js";
import {
  migrateDatabase,
  migrateStage3,
  migrateStage6,
  verifyDatabaseCurrent,
} from "../src/migrations.js";
import { emptySemanticDocument } from "../src/semantic/model.js";
import { SemanticStore } from "../src/semantic/store.js";

test("semantic migration preserves data and isolates and versions workspace definitions", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const options = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
  };
  const admin = await mysql.createConnection(options);
  const name = `stage6_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    const [identity] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port, @@datadir AS dir",
    );
    if (
      identity[0]?.port !== 13307 ||
      !String(identity[0]?.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw new Error("unexpected test database");
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    const pool = mysql.createPool({ ...options, database: name });
    try {
      await migrateDatabase(pool);
      await migrateStage3(pool);
      assert.deepEqual(await verifyDatabaseCurrent(pool, true, false), {
        hasStage3: true,
        hasSemantics: false,
        hasHistory: false,
      });
      await assert.rejects(() => verifyDatabaseCurrent(pool, true, true));
      await migrateStage6(pool);
      await migrateStage6(pool);
      await verifyDatabaseCurrent(pool, true, true);
      // Hiding management must never make the stored disclosure policy disappear.
      assert.deepEqual(await verifyDatabaseCurrent(pool, true, false), {
        hasStage3: true,
        hasSemantics: true,
        hasHistory: false,
      });
      const owner = randomUUID(),
        other = randomUUID(),
        workspace = randomUUID(),
        source = randomUUID(),
        connector = randomUUID(),
        scan = randomUUID(),
        snapshotId = randomUUID();
      for (const id of [owner, other])
        await pool.execute(
          "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?, 'fixture', ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
          [id, `${id}@example.invalid`],
        );
      await pool.execute(
        "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?, 'fixture', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [workspace, owner],
      );
      await pool.execute(
        "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [source, owner, connector],
      );
      await pool.execute(
        "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
        [workspace, source],
      );
      await pool.execute(
        "INSERT INTO schema_scan (id,ownerId,workspaceId,sourceId,connectorId,nonce,issuedAt,expiresEpoch,status,createdAt,expiresAt) VALUES (?,?,?,?,?,'fixture',1,2,'completed',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [scan, owner, workspace, source, connector],
      );
      const content = {
        database: "fixture",
        serverVersion: "26.7.0",
        tables: [{ name: "customers", kind: "BASE TABLE" }],
        columns: [{ table: "customers", name: "id", type: "int", nullable: false, position: 1 }],
        relations: [],
        externalRelationsOmitted: 0,
      };
      await pool.execute(
        "INSERT INTO schema_snapshot (id,scanId,workspaceId,sourceId,contentHash,content,createdAt) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))",
        [snapshotId, scan, workspace, source, "a".repeat(64), JSON.stringify(content)],
      );
      const sources = new DataSourceStore(pool);
      const store = new SemanticStore(sources);
      const document = {
        ...emptySemanticDocument(),
        fields: [
          {
            name: "客户编号",
            description: "编号",
            aliases: ["客户号"],
            sensitivity: "normal",
            table: "customers",
            column: "id",
            type: "int",
          },
        ],
      };
      assert.equal((await store.get(owner, workspace, source)).revision, 0);
      const initial = await store.get(owner, workspace, source);
      assert.equal(initial.snapshot?.database, "fixture");
      assert.equal(initial.snapshot?.columns[0]?.nullable, false);
      assert.equal(initial.snapshot?.columns[0]?.position, 1);
      let unauthorizedAction = false;
      await assert.rejects(
        () =>
          sources.withBoundSnapshot(other, workspace, source, async () => {
            unauthorizedAction = true;
          }),
        /NOT_FOUND/,
      );
      assert.equal(unauthorizedAction, false);
      assert.deepEqual(await store.save(owner, workspace, source, 0, snapshotId, document), {
        revision: 1,
      });
      assert.equal(
        (await store.get(owner, workspace, source)).document.fields[0]?.name,
        "客户编号",
      );
      await assert.rejects(
        () => store.save(owner, workspace, source, 0, snapshotId, document),
        /CONFLICT/,
      );
      await assert.rejects(() => store.get(other, workspace, source), /NOT_FOUND/);
      await assert.rejects(
        () => store.save(owner, workspace, randomUUID(), 1, snapshotId, document),
        /NOT_FOUND/,
      );
      await assert.rejects(
        () =>
          store.save(owner, workspace, source, 1, snapshotId, {
            ...document,
            fields: [{ ...document.fields[0], type: "varchar" }],
          }),
        /INVALID/,
      );
      const concurrent = await Promise.allSettled([
        store.save(owner, workspace, source, 1, snapshotId, document),
        store.save(owner, workspace, source, 1, snapshotId, document),
      ]);
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
      const nextScan = randomUUID(),
        nextSnapshot = randomUUID();
      await pool.execute(
        "INSERT INTO schema_scan (id,ownerId,workspaceId,sourceId,connectorId,nonce,issuedAt,expiresEpoch,status,createdAt,expiresAt) VALUES (?,?,?,?,?,'fixture',1,2,'completed',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [nextScan, owner, workspace, source, connector],
      );
      const changed = { ...content, columns: [{ ...content.columns[0], type: "bigint" }] };
      await pool.execute(
        "INSERT INTO schema_snapshot (id,scanId,workspaceId,sourceId,contentHash,content,createdAt) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))",
        [nextSnapshot, nextScan, workspace, source, "b".repeat(64), JSON.stringify(changed)],
      );
      assert.deepEqual((await store.get(owner, workspace, source)).stale, ["字段：客户编号"]);
      await assert.rejects(
        () => store.save(owner, workspace, source, 2, snapshotId, document),
        /CONFLICT/,
      );
      await assert.rejects(
        () => store.save(owner, workspace, source, 2, nextSnapshot, document),
        /INVALID/,
      );
      const priorField = document.fields[0];
      assert.ok(priorField);
      const updated = { ...document, fields: [{ ...priorField, type: "bigint" }] };
      assert.deepEqual(await store.save(owner, workspace, source, 2, nextSnapshot, updated), {
        revision: 3,
      });
      await assert.rejects(
        () =>
          sources.withBoundSnapshot(owner, workspace, source, async (connection, latest) => {
            assert.equal(latest?.id, nextSnapshot);
            await connection.execute(
              "UPDATE semantic_model SET revision=99 WHERE workspaceId=? AND sourceId=?",
              [workspace, source],
            );
            throw new Error("fixture transaction failure");
          }),
        /fixture transaction failure/,
      );
      assert.equal((await store.get(owner, workspace, source)).revision, 3);
      await pool.execute("DELETE FROM workspace_data_source WHERE workspaceId=? AND sourceId=?", [
        workspace,
        source,
      ]);
      await assert.rejects(() => store.get(owner, workspace, source), /NOT_FOUND/);
      await pool.execute(
        "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
        [workspace, source],
      );
      assert.equal((await store.get(owner, workspace, source)).revision, 3);
    } finally {
      await pool.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});

test("semantic migration refuses partial DDL without destroying it", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const options = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
  };
  const admin = await mysql.createConnection(options);
  const name = `stage6_partial_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const [identity] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port, @@datadir AS dir",
    );
    if (
      identity[0]?.port !== 13307 ||
      !String(identity[0]?.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw new Error("unexpected test database");
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    const pool = mysql.createPool({ ...options, database: name });
    try {
      await migrateDatabase(pool);
      await migrateStage3(pool);
      await pool.query("CREATE TABLE semantic_model (fixture INT NOT NULL)");
      await pool.query("INSERT INTO semantic_model VALUES (7)");
      await assert.rejects(() => migrateStage6(pool), /inspect manually/);
      await assert.rejects(() => verifyDatabaseCurrent(pool, true, false), /inspect manually/);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT fixture FROM semantic_model");
      assert.equal(rows[0]?.fixture, 7);
    } finally {
      await pool.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
