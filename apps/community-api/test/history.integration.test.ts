import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import mysql from "mysql2/promise";
import { DataSourceStore } from "../src/datasources/store.js";
import { HistoryStore } from "../src/history/store.js";
import {
  migrateDatabase,
  migrateStage3,
  migrateStage6,
  migrateStage7,
  verifyDatabaseCurrent,
} from "../src/migrations.js";

test("history migration, isolation, revisions, retention and execution recovery work in an isolated database", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const options = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
  };
  const admin = await mysql.createConnection(options),
    name = `stage7_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    const [identity] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port,@@datadir AS dir",
    );
    if (
      identity[0]?.port !== 13307 ||
      !String(identity[0]?.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw Error("unexpected isolated database");
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    const pool = mysql.createPool({ ...options, database: name });
    try {
      await migrateDatabase(pool);
      await migrateStage3(pool);
      await migrateStage6(pool);
      await assert.rejects(() => verifyDatabaseCurrent(pool, true, true, true));
      await migrateStage7(pool);
      await migrateStage7(pool);
      assert.equal((await verifyDatabaseCurrent(pool, true, true, true)).hasHistory, true);
      // Every explicit migrator recognizes the current, fully verified history.
      await migrateDatabase(pool);
      await migrateStage3(pool);
      await migrateStage6(pool);
      const owner = randomUUID(),
        other = randomUUID(),
        workspace = randomUUID(),
        workspace2 = randomUUID(),
        source = randomUUID(),
        connector = randomUUID();
      for (const user of [owner, other])
        await pool.execute(
          "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'fixture',?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
          [user, `${user}@example.invalid`],
        );
      for (const id of [workspace, workspace2])
        await pool.execute(
          "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'fixture',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
          [id, owner],
        );
      await pool.execute(
        "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [source, owner, connector],
      );
      for (const id of [workspace, workspace2])
        await pool.execute(
          "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
          [id, source],
        );
      const scope = { ownerId: owner, workspaceId: workspace, sourceId: source };
      const store = new HistoryStore(pool, new DataSourceStore(pool));
      const id = randomUUID(),
        message = { id: randomUUID(), role: "user", text: "本机业务信息" };
      const conversation = { title: "演示对话", messages: [message] };
      assert.deepEqual(await store.save(scope, "conversation", id, 0, conversation), {
        id,
        revision: 1,
      });
      assert.deepEqual((await store.get(scope, "conversation", id)).content, conversation);
      await assert.rejects(
        () => store.get({ ...scope, ownerId: other }, "conversation", id),
        /NOT_FOUND/,
      );
      await assert.rejects(
        () => store.get({ ...scope, workspaceId: workspace2 }, "conversation", id),
        /NOT_FOUND/,
      );
      const concurrent = await Promise.allSettled([
        store.save(scope, "conversation", id, 1, conversation),
        store.save(scope, "conversation", id, 1, conversation),
      ]);
      assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
      await store.setDeleted(scope, "conversation", id, 2, true);
      assert.equal((await store.list(scope, "conversation")).items.length, 0);
      assert.equal((await store.list(scope, "conversation", undefined, true)).items.length, 1);
      await store.setDeleted(scope, "conversation", id, 3, false);
      assert.equal((await store.get(scope, "conversation", id)).revision, 4);
      await store.recordExport(scope);
      const artifact = {
        name: "保存查询",
        kind: "query",
        sql: "SELECT id FROM customers WHERE id=?",
        parameterKinds: ["integer"],
        maxRows: 10,
        schemaVersion: null,
        notes: "",
        chart: null,
      };
      await store.save(scope, "artifact", randomUUID(), 0, artifact);
      await assert.rejects(
        () =>
          store.save(scope, "artifact", randomUUID(), 0, { ...artifact, parameters: ["private"] }),
        /INVALID/,
      );
      const task = randomUUID(),
        instance = randomUUID();
      assert.equal((await store.beginExecution(scope, task, connector, instance)).created, true);
      assert.equal((await store.beginExecution(scope, task, connector, instance)).created, false);
      await assert.rejects(
        () => store.beginExecution(scope, task, connector, randomUUID()),
        /CONFLICT/,
      );
      await store.setExecutionState(scope, task, "running");
      // Revocation denies content access, but trusted terminal publication must remain possible.
      await pool.execute("DELETE FROM workspace_data_source WHERE workspaceId=? AND sourceId=?", [
        workspace,
        source,
      ]);
      await assert.rejects(() => store.get(scope, "conversation", id), /NOT_FOUND/);
      await assert.rejects(() => store.recordExport(scope), /NOT_FOUND/);
      await store.setExecutionState(scope, task, "completed", { rowCount: 3, truncated: false });
      await store.setExecutionState(scope, task, "failed", { code: "error" });
      await assert.rejects(
        () =>
          store.beginExecution({ ...scope, workspaceId: workspace2 }, task, connector, instance),
        /CONFLICT/,
      );
      assert.equal((await store.listExecutions(owner)).items.length, 1);
      const completed = (await store.listExecutions(owner)).items[0];
      assert.ok(completed && "state" in completed.content);
      assert.equal(completed.content.state, "completed");
      assert.equal((await store.listExecutions(other)).items.length, 0);
      const audit = await store.listAudit(owner);
      assert.ok(
        audit.items.some(
          (row) => "event" in row.content && row.content.event === "query.completed",
        ),
      );
      assert.doesNotMatch(JSON.stringify(audit), /本机业务信息|SELECT|private/);
      await pool.execute(
        "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
        [workspace, source],
      );
      const interrupted = randomUUID();
      await store.beginExecution(scope, interrupted, connector, instance);
      await store.recoverExecutions(randomUUID());
      const recovered = (await store.listExecutions(owner)).items.find(
        (row) => row.id === interrupted,
      );
      assert.ok(recovered && "state" in recovered.content);
      assert.equal(recovered.content.state, "outcome_unknown");
      const recoveredAudit = (await store.listAudit(owner)).items.filter(
        (row) =>
          "event" in row.content &&
          row.content.event === "query.unknown" &&
          row.content.executionId === interrupted,
      );
      assert.equal(recoveredAudit.length, 1);
      await store.recoverExecutions(randomUUID());
      assert.equal(
        (await store.listAudit(owner)).items.filter(
          (row) =>
            "event" in row.content &&
            row.content.event === "query.unknown" &&
            row.content.executionId === interrupted,
        ).length,
        1,
      );
      const stableEventId = randomUUID();
      const stableEvent = {
        event: "connection.checked" as const,
        outcome: "success" as const,
        connectorId: connector,
      };
      // A committed event can be replayed after a response is lost, including
      // concurrent retries, without duplicating or mutating the audit record.
      await Promise.all([
        store.appendAudit(owner, scope, stableEvent, stableEventId),
        store.appendAudit(owner, scope, stableEvent, stableEventId),
      ]);
      await store.appendAudit(
        owner,
        scope,
        { connectorId: connector, outcome: "success", event: "connection.checked" },
        stableEventId,
      );
      assert.equal(
        (await store.listAudit(owner)).items.filter((row) => row.id === stableEventId).length,
        1,
      );
      await assert.rejects(
        () =>
          store.appendAudit(owner, scope, { ...stableEvent, outcome: "failure" }, stableEventId),
        /CONFLICT/,
      );
      await assert.rejects(
        () => store.appendAudit(other, scope, stableEvent, stableEventId),
        /CONFLICT/,
      );
      await assert.rejects(
        () => store.appendAudit(owner, null, stableEvent, stableEventId),
        /CONFLICT/,
      );
      await assert.rejects(() => store.appendAudit(owner, scope, stableEvent, id), /CONFLICT/);
      await assert.rejects(
        () => store.appendAudit(owner, scope, stableEvent, "invalid"),
        /INVALID/,
      );
      const preservedEvent = (await store.listAudit(owner)).items.find(
        (row) => row.id === stableEventId,
      );
      assert.deepEqual(preservedEvent?.content, stableEvent);
      for (let i = 0; i < 52; i++)
        await store.appendAudit(owner, null, {
          event: "connection.checked",
          outcome: "success",
          connectorId: connector,
        });
      const page = await store.listAudit(owner);
      assert.equal(page.items.length, 50);
      assert.ok(page.nextCursor);
      const next = await store.listAudit(owner, page.nextCursor);
      assert.ok(next.items.length > 0);
      assert.equal(
        page.items.some((item) => next.items.some((otherItem) => otherItem.id === item.id)),
        false,
      );
      await assert.rejects(() => store.listAudit(owner, "1 OR 1=1"), /INVALID/);
    } finally {
      await pool.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});

test("unrecorded history DDL is rejected without deleting local data", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const options = {
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
  };
  const admin = await mysql.createConnection(options),
    name = `stage7_partial_${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    const [identity] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port,@@datadir AS dir",
    );
    if (
      identity[0]?.port !== 13307 ||
      !String(identity[0]?.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw Error("unexpected isolated database");
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    const pool = mysql.createPool({ ...options, database: name });
    try {
      await migrateDatabase(pool);
      await migrateStage3(pool);
      await migrateStage6(pool);
      await pool.query("CREATE TABLE history_entry (fixture INT NOT NULL)");
      await pool.query("INSERT INTO history_entry VALUES (7)");
      await assert.rejects(
        () => verifyDatabaseCurrent(pool, true, true, false),
        /inspect manually/,
      );
      await assert.rejects(() => migrateStage7(pool), /inspect manually/);
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT fixture FROM history_entry");
      assert.equal(rows[0]?.fixture, 7);
    } finally {
      await pool.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
