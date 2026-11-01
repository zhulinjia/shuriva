import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { inspectStage3 } from "../src/datasources/stage3-schema.js";
import { DataSourceError, DataSourceStore } from "../src/datasources/store.js";
import { WorkspaceStore } from "../src/workspaces.js";
import { createIsolatedDataSourceFixture } from "./isolated-datasource-fixture.js";

function content(name: string) {
  return {
    database: "fixture",
    serverVersion: "test",
    tables: name ? [{ name, kind: "BASE TABLE" }] : [],
    columns: [],
    relations: [],
    externalRelationsOmitted: 0,
  };
}

test("data source binding, default and snapshot authorization on isolated MySQL", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
}, async () => {
  const fixture = await createIsolatedDataSourceFixture("binding");
  const { pool } = fixture;
  const owner = randomUUID();
  const other = randomUUID();
  const workspace = randomUUID();
  const source = randomUUID();
  const connector = randomUUID();
  const store = new DataSourceStore(pool);
  try {
    const inspectConnection = await pool.getConnection();
    try {
      await inspectStage3(inspectConnection);
    } finally {
      inspectConnection.release();
    }
    for (const id of [owner, other]) {
      await pool.execute(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'fixture', ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [id, `${id}@example.invalid`],
      );
    }
    await pool.execute(
      "INSERT INTO workspace (id, name, createdByAccountId, createdAt, updatedAt) VALUES (?, 'fixture', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [workspace, owner],
    );
    await store.create(owner, source, connector, "测试数据源");
    await assert.rejects(() => store.bind(other, workspace, source), DataSourceError);
    await assert.rejects(() => store.bindings(other, workspace), DataSourceError);
    await assert.rejects(() => store.setDefault(owner, workspace, source), DataSourceError);
    await store.bind(owner, workspace, source);
    await assert.rejects(() => store.archive(owner, source), DataSourceError);
    await assert.rejects(() => store.reassign(owner, source, randomUUID()), DataSourceError);
    await store.rename(owner, source, "重命名");
    assert.equal(
      (await store.list(owner)).sources.find((item) => item.id === source)?.name,
      "重命名",
    );
    await store.setDefault(owner, workspace, source);
    assert.equal(Number((await store.bindings(owner, workspace))[0]?.isDefault), 1);
    const scan = await store.beginScan(owner, workspace, source);
    assert.ok(await store.authorizedScan(scan.id, connector));
    assert.equal(await store.authorizedScan(scan.id, randomUUID()), null);
    await assert.rejects(
      () => store.completeScan(scan.id, connector, { tables: [{ name: "invalid" }] }),
      DataSourceError,
    );
    await store.completeScan(scan.id, connector, content("fixture"));
    const original = await store.latest(owner, workspace, source);
    assert.ok(original);
    assert.equal(await store.latest(other, workspace, source), null);
    const updatedScan = await store.beginScan(owner, workspace, source);
    await store.completeScan(updatedScan.id, connector, content("changed"));
    const updated = await store.latest(owner, workspace, source);
    assert.ok(updated);
    assert.ok(BigInt(updated.version) > BigInt(original.version));
    const history = await store.history(owner, workspace, source);
    assert.deepEqual(
      history.snapshots.map((item) => item.id),
      [updated.id, original.id],
    );
    assert.equal((await store.snapshot(owner, workspace, source, original.id))?.id, original.id);
    assert.equal(await store.snapshot(other, workspace, source, original.id), null);
    const failed = await store.beginScan(owner, workspace, source);
    await store.failScan(failed.id, connector, "permissions");
    assert.equal((await store.scanStatus(owner, workspace, source))?.status, "failed");
    assert.equal((await store.latest(owner, workspace, source))?.id, updated.id);
    const queued = await store.beginScan(owner, workspace, source);
    await store.unbind(owner, workspace, source);
    await store.archive(owner, source);
    assert.equal(
      (await store.list(owner)).sources.some((item) => item.id === source),
      false,
    );
    assert.equal(
      (await store.list(owner, true)).sources.some((item) => item.id === source),
      true,
    );
    await assert.rejects(() => store.bind(owner, workspace, source), DataSourceError);
    await store.restore(owner, source);
    const replacementConnector = randomUUID();
    await store.reassign(owner, source, replacementConnector);
    assert.equal(
      (await store.list(owner)).sources.find((item) => item.id === source)?.connectorId,
      replacementConnector,
    );
    await store.reassign(owner, source, connector);
    assert.equal(await store.authorizedScan(queued.id, connector), null);
    await assert.rejects(
      () => store.completeScan(queued.id, connector, content("")),
      DataSourceError,
    );
    assert.equal(await store.latest(owner, workspace, source), null);
    assert.equal((await store.history(owner, workspace, source)).snapshots.length, 0);
    await store.bind(owner, workspace, source);
    assert.equal(Number((await store.bindings(owner, workspace))[0]?.isDefault), 0);
    assert.equal(await store.authorizedScan(queued.id, connector), null);
    assert.equal((await store.latest(owner, workspace, source))?.id, updated.id);
    const beforeArchive = await store.beginScan(owner, workspace, source);
    const workspaces = new WorkspaceStore(pool, (connection, id) =>
      store.cancelWorkspaceScans(connection, id),
    );
    assert.equal(await workspaces.setArchived(owner, workspace, true), true);
    assert.equal(await store.latest(owner, workspace, source), null);
    await assert.rejects(() => store.beginScan(owner, workspace, source), DataSourceError);
    assert.equal(await workspaces.setArchived(owner, workspace, false), true);
    assert.equal(await store.authorizedScan(beforeArchive.id, connector), null);
    const racing = await store.beginScan(owner, workspace, source);
    const lock = await pool.getConnection();
    let committed = false;
    try {
      await lock.beginTransaction();
      await lock.execute("UPDATE workspace SET archivedAt = UTC_TIMESTAMP(3) WHERE id = ?", [
        workspace,
      ]);
      await lock.execute("UPDATE schema_scan SET status = 'cancelled' WHERE id = ?", [racing.id]);
      const completion = store.completeScan(racing.id, connector, content("")).then(
        () => true,
        () => false,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await lock.commit();
      committed = true;
      assert.equal(await completion, false);
    } finally {
      if (!committed) await lock.rollback();
      lock.release();
    }
    assert.equal(await workspaces.setArchived(owner, workspace, false), true);
    assert.equal((await store.latest(owner, workspace, source))?.id, updated.id);
    for (let index = 0; index < 101; index++) {
      await store.create(owner, randomUUID(), connector, `分页测试 ${index}`);
    }
    const firstPage = await store.list(owner);
    assert.equal(firstPage.sources.length, 100);
    assert.ok(firstPage.nextCursor);
    const secondPage = await store.list(owner, false, firstPage.nextCursor);
    assert.equal(secondPage.sources.length, 2);
    assert.equal(
      new Set([...firstPage.sources, ...secondPage.sources].map((item) => item.id)).size,
      102,
    );
  } finally {
    await fixture.close();
  }
});
