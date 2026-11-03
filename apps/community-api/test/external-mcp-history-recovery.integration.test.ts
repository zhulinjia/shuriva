import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { externalFixture } from "./external-mcp-fixture.js";

test("G4 every null-slot recovery blocker remains visible beyond fifty acknowledged newer calls", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 30000,
}, async () => {
  const f = await externalFixture();
  try {
    const { id } = await f.service.create(f.identity, {
      workspaceId: f.binding.workspaceId,
      name: "Recovery visibility",
      config: f.httpConfig,
    });
    const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
    const row = {
      ownerId: f.identity.ownerId,
      connectionId: id,
      version: c.version,
      tool: "echo",
      toolHash: "a".repeat(64),
      sessionId: f.identity.sessionId,
      bootId: randomUUID(),
      commitment: "b".repeat(64),
    };
    const retained: string[] = [];
    for (let i = 0; i < 51; i++) {
      const record = { ...row, id: randomUUID() };
      await f.service.store.prepareCall(record, () => {});
      assert.equal(await f.service.store.start(f.identity.ownerId, record.id, c.version), true);
      await f.service.store.terminal(f.identity.ownerId, record.id, "result_retained");
      await f.pool.execute("UPDATE external_mcp_call SET createdAt=? WHERE id=?", [
        new Date(Date.UTC(2020, 0, 1, 0, 0, i)),
        record.id,
      ]);
      retained.push(record.id);
    }
    // Newer acknowledged history must not crowd older, unresolved recovery rows.
    for (let i = 0; i < 55; i++) {
      const record = { ...row, id: randomUUID() };
      await f.service.store.prepareCall(record, () => {});
      assert.equal(await f.service.store.start(f.identity.ownerId, record.id, c.version), true);
      await f.service.store.terminal(f.identity.ownerId, record.id, "outcome_unknown");
      await f.service.store.acknowledge(f.identity.ownerId, record.id);
      await f.pool.execute("UPDATE external_mcp_call SET createdAt=? WHERE id=?", [
        new Date(Date.UTC(2021, 0, 1, 0, 0, i)),
        record.id,
      ]);
    }
    await f.service.store.recover(randomUUID());
    const [counts] = await f.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT COUNT(*) total,SUM(slot IS NULL) nullSlots FROM external_mcp_call WHERE connectionId=? AND state='outcome_unknown' AND acknowledged=0",
      [id],
    );
    assert.equal(Number(counts[0]?.total), 51);
    assert.equal(Number(counts[0]?.nullSlots), 51);
    const next = { ...row, id: randomUUID() };
    await assert.rejects(
      f.service.store.prepareCall(next, () => {}),
      /UNKNOWN_CALL_PENDING/,
    );
    const first = await f.service.invocations.history(c, f.identity);
    assert.equal(first.length, 50);
    assert.equal(
      first.every((call) => call.state === "outcome_unknown" && !call.acknowledged),
      true,
    );
    assert.equal(
      first.some((call) => call.id === retained[0]),
      false,
    );
    for (const call of first) await f.service.invocations.acknowledge(c, f.identity, call.id);
    const second = await f.service.invocations.history(c, f.identity);
    assert.equal(second.length, 50);
    assert.equal(second[0]?.id, retained[0]);
    assert.equal(second[0]?.acknowledged, false);
    assert.equal(
      second.filter((call) => call.state === "outcome_unknown" && !call.acknowledged).length,
      1,
    );
    await assert.rejects(
      f.service.store.prepareCall(next, () => {}),
      /UNKNOWN_CALL_PENDING/,
    );
    await f.service.invocations.acknowledge(
      c,
      f.identity,
      retained[0] ?? assert.fail("oldest retained result"),
    );
    assert.equal(
      (await f.service.invocations.history(c, f.identity)).every((call) => call.acknowledged),
      true,
    );
    await f.service.store.prepareCall(next, () => {});
    await f.service.store.terminal(f.identity.ownerId, next.id, "expired");
    assert.equal(f.stats().calls, 0);
  } finally {
    await f.close();
  }
});
