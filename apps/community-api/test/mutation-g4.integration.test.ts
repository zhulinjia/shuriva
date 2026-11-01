import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { mutationFixture } from "./mutation-fixture.js";

const isolated = { skip: process.env.STAGE8_G3_TEST !== "1", timeout: 45_000 };

test(
  "G4 concurrent close and late confirmation preserve one original identity or a durable seal",
  isolated,
  async () => {
    const f = await mutationFixture();
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        const p = f.preview();
        await f.store.savePreview(f.binding, p);
        const input = {
          confirmationId: randomUUID(),
          previewId: p.previewId,
          commitment: p.commitment,
          revision: 1,
        };
        const outcomes = await Promise.allSettled([
          f.store.confirm(f.binding, f.sessionId, input),
          f.store.closeConfirmation(f.binding, input),
        ]);
        assert.equal(outcomes[1].status, "fulfilled");
        const state = await f.store.confirmation(f.binding, input.confirmationId);
        const [rows] = await f.pool.query<RowDataPacket[]>(
          "SELECT id AS executionId FROM mutation_execution WHERE previewId=?",
          [p.previewId],
        );
        assert.ok(rows.length <= 1);
        if (state.state === "closed") {
          assert.equal(rows.length, 0);
          assert.equal(outcomes[0].status, "rejected");
          await assert.rejects(() => f.store.confirm(f.binding, f.sessionId, input));
        } else {
          assert.equal(state.state, "registered");
          assert.equal(rows.length, 1);
          assert.equal(state.execution?.executionId, rows[0].executionId);
          const repeated = await f.store.confirm(f.binding, f.sessionId, input);
          assert.equal(repeated.created, false);
          assert.equal(repeated.execution.executionId, rows[0].executionId);
        }
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "G4 recovery barrier racing confirmation never hides a registered execution or permits a late one",
  isolated,
  async () => {
    const f = await mutationFixture();
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        const p = f.preview();
        await f.store.savePreview(f.binding, p);
        const input = {
          confirmationId: randomUUID(),
          previewId: p.previewId,
          commitment: p.commitment,
          revision: 1,
        };
        const [confirmation, recovery] = await Promise.allSettled([
          f.store.confirm(f.binding, f.sessionId, input),
          f.store.recovery(f.binding),
        ]);
        assert.equal(recovery.status, "fulfilled");
        if (recovery.status !== "fulfilled") throw Error("recovery failed");
        if (confirmation.status === "fulfilled") {
          const id = confirmation.value.execution.executionId;
          assert.ok(recovery.value.items.some((item) => item.executionId === id));
          assert.equal((await f.store.get(f.binding, id)).executionId, id);
        } else {
          await assert.rejects(() => f.store.confirm(f.binding, f.sessionId, input));
          const [rows] = await f.pool.query<RowDataPacket[]>(
            "SELECT id AS executionId FROM mutation_execution WHERE previewId=?",
            [p.previewId],
          );
          assert.equal(rows.length, 0);
        }
      }
    } finally {
      await f.close();
    }
  },
);
