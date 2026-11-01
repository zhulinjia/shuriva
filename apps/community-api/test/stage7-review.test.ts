import { testSessions, testSessionId } from "./session-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import type { QueryJournal } from "../src/queries/journal.js";
import { ReadService } from "../src/queries/service.js";

const scope = {
  sessionId: testSessionId,
  ownerId: "owner",
  connectorId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
};
const payload = Buffer.from(
  JSON.stringify({
    columns: [{ name: "id", type: "BIGINT" }],
    rows: [[{ null: false, encoding: "text", value: "1" }]],
    timezone: "UTC",
    truncated: false,
  }),
).toString("base64url");
const source = {} as DataSourceStore;
const registry = {} as ConnectorRegistry;

test("review: result cleanup must not replace completed execution with expired while journal is busy", async () => {
  const updates: Array<{ id: string; state: string }> = [];
  let unblock!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let first = true;
  const journal: QueryJournal = {
    begin: async () => ({ created: true, state: "queued" }),
    update: async (_scope, id, state) => {
      if (first) {
        first = false;
        started();
        await blocked;
      }
      updates.push({ id, state });
    },
  };
  const service = new ReadService(source, registry, testSessions, journal);
  try {
    const a = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    await service.trackExecution(scope, a);
    const b = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    await service.trackExecution(scope, b);
    service.jobs.claim(scope.connectorId);
    const flush = service.flushHistory();
    await waiting;
    service.jobs.complete(scope, a, "ok", payload);
    service.jobs.claim(scope.connectorId);
    service.jobs.complete(scope, b, "ok", payload);
    // result() returns after this call when another flush is already in progress.
    await service.flushHistory();
    service.jobs.cancel(scope, b);
    unblock();
    await flush;
    await service.flushHistory();
    assert.equal(updates.find((entry) => entry.id === b)?.state, "completed");
  } finally {
    unblock();
    service.close();
  }
});

test("review: a request retained in the durable journal must not dispatch again after memory expiry", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  let begins = 0;
  const journal: QueryJournal = {
    begin: async () => ({ created: ++begins === 1, state: "running" }),
    update: async () => {
      throw new Error("database temporarily unavailable");
    },
  };
  const service = new ReadService(source, registry, testSessions, journal);
  try {
    const id = randomUUID();
    service.jobs.create(scope, id, "SELECT id FROM items", [], 1);
    await service.trackExecution(scope, id);
    const original = service.jobs.claim(scope.connectorId);
    assert.ok(original?.type === "read");
    now += 361_000;
    service.jobs.prune();
    await service.flushHistory();
    // The same request ID arrives with a fresh transport intent after database recovery.
    service.jobs.create(scope, id, "SELECT id FROM items", [], 1);
    await assert.rejects(() => service.trackExecution(scope, id), /CONFLICT/);
    assert.equal(service.jobs.claim(scope.connectorId), null);
  } finally {
    service.close();
  }
});

test("review: result revocation preserves execution outcome and exposes only immutable safe summaries", () => {
  const service = new ReadService(source, registry, testSessions);
  try {
    const completed = service.jobs.create(scope, randomUUID(), "SELECT private FROM items", [], 1);
    service.jobs.claim(scope.connectorId);
    service.jobs.complete(scope, completed, "ok", payload);
    service.jobs.cancelMatching(scope.ownerId, scope.workspaceId, scope.sourceId);
    assert.deepEqual(service.jobs.status(scope, completed), { state: "cancelled" });
    assert.deepEqual(service.jobs.executionState(scope, completed), {
      state: "completed",
      summary: { rowCount: 1, truncated: false },
    });
    const summary = service.jobs.executionState(scope, completed);
    assert.ok(summary);
    summary.summary.rowCount = 999;
    assert.equal(service.jobs.executionState(scope, completed)?.summary.rowCount, 1);

    const failed = service.jobs.create(scope, randomUUID(), "SELECT private FROM items", [], 1);
    service.jobs.claim(scope.connectorId);
    service.jobs.complete(scope, failed, "failed", "outcome_unknown");
    service.jobs.cancel(scope, failed);
    assert.deepEqual(service.jobs.executionState(scope, failed), {
      state: "outcome_unknown",
      summary: { code: "outcome_unknown" },
    });
    assert.doesNotMatch(
      JSON.stringify(service.jobs.executionState(scope, completed)),
      /SELECT|private|rows|payload/,
    );
  } finally {
    service.close();
  }
});
