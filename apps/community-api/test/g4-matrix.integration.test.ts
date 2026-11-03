import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { authSessionReferenceActive } from "../src/auth.js";
import { HistoryStore } from "../src/history/store.js";
import { migrateStage6, migrateStage7, migrateStage8 } from "../src/migrations.js";
import { mutationTables } from "../src/mutations/migration.js";
import { MutationStore } from "../src/mutations/store.js";
import { mutationFixture } from "./mutation-fixture.js";

test("G4 recovery pagination retains every execution while terminal states change", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 90_000,
}, async () => {
  const f = await mutationFixture();
  try {
    const expected = new Set<string>();
    for (let i = 0; i < 103; i++) {
      const preview = f.preview();
      await f.store.savePreview(f.binding, preview);
      const registered = await f.store.confirm(f.binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: preview.previewId,
        commitment: preview.commitment,
        revision: preview.revision,
      });
      expected.add(registered.execution.executionId);
    }
    const first = await f.store.recovery(f.binding);
    assert.equal(first.items.length, 100);
    assert.ok(first.nextCursor);
    // Terminal transitions do not remove records or change their sequence.
    await Promise.all(
      [...expected].map((id) => f.store.update(f.binding, id, "rejected", "claim_failed")),
    );
    const second = await f.store.list(f.binding, first.nextCursor);
    const actual = [...first.items, ...second.items].map((item) => item.executionId);
    assert.equal(second.nextCursor, null);
    assert.equal(actual.length, 103);
    assert.deepEqual(new Set(actual), expected);
    assert.ok(second.items.every((item) => item.state === "rejected"));
  } finally {
    await f.close();
  }
});

test("G4 actual audit SQL outage survives store restart and replays once with its stable event ID", {
  skip: process.env.STAGE8_G3_TEST !== "1",
}, async () => {
  const f = await mutationFixture();
  try {
    for (const table of mutationTables) {
      const [rows] = await f.pool.query<RowDataPacket[]>(`SELECT COUNT(*) total FROM \`${table}\``);
      assert.equal(rows[0]?.total, 0);
      await f.pool.query(`DROP TABLE \`${table}\``);
    }
    await migrateStage6(f.pool);
    await migrateStage7(f.pool);
    await migrateStage8(f.pool);
    const preview = f.preview();
    await f.store.savePreview(f.binding, preview);
    await f.store.confirm(f.binding, f.sessionId, {
      confirmationId: randomUUID(),
      previewId: preview.previewId,
      commitment: preview.commitment,
      revision: preview.revision,
    });
    const history = new HistoryStore(f.pool, f.sources);
    const sink = {
      append: (
        scope: typeof f.binding,
        id: string,
        event:
          | "mutation.confirmed"
          | "mutation.cancelled"
          | "mutation.state_changed"
          | "mutation.target_frozen",
        executionId: string,
      ) =>
        history.appendAudit(scope.ownerId, scope, { event, outcome: "success", executionId }, id),
    };
    await f.pool.query("RENAME TABLE history_entry TO g4_unavailable_history");
    await assert.rejects(f.store.flushAudit(sink));
    const [pending] = await f.pool.query<RowDataPacket[]>(
      "SELECT id,delivered FROM mutation_outbox",
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.delivered, 0);
    await f.pool.query("RENAME TABLE g4_unavailable_history TO history_entry");
    const restarted = new MutationStore(
      f.pool,
      f.sources,
      "a".repeat(64),
      authSessionReferenceActive,
      true,
    );
    await restarted.flushAudit(sink);
    await restarted.flushAudit(sink);
    const [delivered] = await f.pool.query<RowDataPacket[]>(
      "SELECT id,delivered FROM mutation_outbox",
    );
    assert.equal(delivered[0]?.id, pending[0]?.id);
    assert.equal(delivered[0]?.delivered, 1);
    const [events] = await f.pool.query<RowDataPacket[]>(
      "SELECT id FROM history_entry WHERE kind='audit'",
    );
    assert.deepEqual(
      events.map((row) => row.id),
      [pending[0]?.id],
    );
  } finally {
    await f.close();
  }
});
