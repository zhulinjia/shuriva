import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DataSourceStore } from "../src/datasources/store.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { ReadService } from "../src/queries/service.js";
import type { QueryJournal, ExecutionSummary, ExecutionState } from "../src/queries/journal.js";

const scope = {
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  sourceId: randomUUID(),
  connectorId: randomUUID(),
};
const source = {
  boundSource: async () => ({ connectorId: scope.connectorId }),
} as unknown as DataSourceStore;
const registry = {
  issueReadTask: async (task: object) => ({ ...task, signature: "fixture" }),
} as unknown as ConnectorRegistry;

test("journal creation failures and persisted terminal IDs cannot dispatch a new execution", async () => {
  for (const begin of [
    async () => {
      throw Error("unavailable");
    },
    async () => ({ created: false, state: "completed" }),
  ]) {
    const service = new ReadService(source, registry, { begin, update: async () => {} });
    try {
      const id = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
      await assert.rejects(() => service.trackExecution(scope, id));
      assert.equal(service.jobs.status(scope, id)?.state, "cancelled");
      const next = await service.next(scope.connectorId);
      assert.equal(next?.operation === "read_query", false);
    } finally {
      service.close();
    }
  }
});

test("execution summary retries a failed write without SQL, parameters, or result cells", async () => {
  let failed = false;
  const writes: Array<{ state: ExecutionState; summary: ExecutionSummary }> = [];
  const journal: QueryJournal = {
    begin: async () => ({ created: true, state: "queued" }),
    update: async (_scope, _id, state, summary) => {
      if (state === "completed" && !failed) {
        failed = true;
        throw Error("fixture outage");
      }
      writes.push({ state, summary });
    },
  };
  const service = new ReadService(source, registry, journal);
  try {
    const id = service.jobs.create(
      scope,
      randomUUID(),
      "SELECT private_name FROM items WHERE id=?",
      [{ kind: "integer", value: "42" }],
      1,
    );
    await service.trackExecution(scope, id);
    await service.next(scope.connectorId);
    const payload = Buffer.from(
      JSON.stringify({
        columns: [{ name: "private_name", type: "VARCHAR" }],
        rows: [[{ null: false, encoding: "text", value: "private result" }]],
        timezone: "UTC",
        truncated: false,
      }),
    ).toString("base64url");
    service.jobs.complete(scope, id, "ok", payload);
    await service.flushHistory();
    await service.flushHistory();
    await service.flushHistory();
    assert.deepEqual(
      writes.map((item) => item.state),
      ["running", "completed"],
    );
    assert.equal(writes[1]?.summary.rowCount, 1);
    assert.equal(writes[1]?.summary.truncated, false);
    assert.equal(typeof writes[1]?.summary.durationMs, "number");
    const serialized = JSON.stringify(writes);
    for (const secret of [
      "SELECT",
      "private_name",
      "42",
      "private result",
      "payload",
      "parameters",
    ])
      assert.equal(serialized.includes(secret), false);
  } finally {
    service.close();
  }
});

test("uncertain connector outcomes remain unknown and cancelled executions do not become success", async () => {
  const states: ExecutionState[] = [];
  const service = new ReadService(source, registry, {
    begin: async () => ({ created: true, state: "queued" }),
    update: async (_s, _id, state) => {
      states.push(state);
    },
  });
  try {
    const id = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    await service.trackExecution(scope, id);
    await service.next(scope.connectorId);
    service.jobs.complete(scope, id, "failed", "outcome_unknown");
    await service.flushHistory();
    assert.equal(states.at(-1), "outcome_unknown");
    const cancelled = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    await service.trackExecution(scope, cancelled);
    service.jobs.cancel(scope, cancelled);
    await service.flushHistory();
    assert.equal(states.at(-1), "cancelled");
  } finally {
    service.close();
  }
});
