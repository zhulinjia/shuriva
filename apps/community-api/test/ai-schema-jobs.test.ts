import { testSessions, testSessionId } from "./session-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { ReadJobs } from "../src/queries/jobs.js";
import { ReadService } from "../src/queries/service.js";

const scope = {
  sessionId: testSessionId,
  ownerId: "owner",
  connectorId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
};
const schema = {
  database: "demo",
  tables: [
    {
      name: "items",
      columns: [{ name: "id", type: "int" }],
      version: "a".repeat(64),
      structureHash: "b".repeat(64),
    },
  ],
};
const id = "44444444-4444-4444-8444-444444444444";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("model schema work uses a scoped, nonce-bound task and rejects schema with extra data", () => {
  const jobs = new ReadJobs();
  try {
    assert.equal(jobs.createModelSchema(scope, id), id);
    assert.equal(jobs.createModelSchema(scope, id), id);
    assert.throws(() => jobs.create(scope, id, "SELECT id FROM items", [], 10), /CONFLICT/);
    const first = jobs.claim(scope.connectorId);
    assert.equal(first?.type, "read");
    if (first?.type !== "read") throw new Error("missing job");
    assert.equal(first.task.operation, "model_schema");
    assert.equal(Buffer.from(first.task.payload, "base64url").toString(), "{}");
    assert.equal(jobs.matchesResultNonce(scope, id, first.task.nonce), true);
    assert.equal(jobs.matchesResultNonce(scope, id, "stale"), false);
    assert.throws(() => jobs.complete(scope, id, "ok", encode({ ...schema, password: "secret" })));
    assert.equal(jobs.complete(scope, id, "ok", encode(schema)), true);
    assert.equal(
      jobs.status({ ...scope, workspaceId: "55555555-5555-4555-8555-555555555555" }, id),
      null,
    );
    assert.equal(jobs.status(scope, id)?.state, "completed");
  } finally {
    jobs.close();
  }
});

test("authorization results bind the lease to the signed task and strip internal versions", () => {
  let now = Date.now();
  const jobs = new ReadJobs(() => now);
  try {
    jobs.createModelAuthorization(scope, id);
    const task = jobs.claim(scope.connectorId);
    if (task?.type !== "read") throw new Error("missing task");
    assert.equal(task.task.operation, "model_authorize");
    assert.equal(task.task.expiresAt - task.task.issuedAt, 30);
    assert.throws(() =>
      jobs.complete(
        scope,
        id,
        "ok",
        encode({ ...schema, leaseExpiresAt: task.task.expiresAt + 1 }),
      ),
    );
    assert.equal(
      jobs.complete(scope, id, "ok", encode({ ...schema, leaseExpiresAt: task.task.expiresAt })),
      true,
    );
    const result = jobs.modelAuthorization(scope, id);
    assert.equal(result?.leaseExpiresAt, task.task.expiresAt);
    assert.equal(result?.versions.get("items"), "a".repeat(64));
    assert.deepEqual(result?.schema, {
      database: "demo",
      tables: [{ name: "items", columns: [{ name: "id", type: "int" }] }],
    });
    now = task.task.expiresAt * 1000;
    assert.equal(jobs.modelAuthorization(scope, id), null);
  } finally {
    jobs.close();
  }
});

test("binding, workspace and Connector invalidation abort in-flight model requests", () => {
  const service = new ReadService({} as DataSourceStore, {} as ConnectorRegistry, testSessions);
  try {
    service.issueScope(scope);
    const first = service.watchBinding(scope);
    assert.throws(() => service.watchBinding(scope), /CAPACITY/);
    service.invalidateWorkspace(scope.ownerId, scope.workspaceId);
    assert.equal(first.signal.aborted, true);
    first.dispose();
    service.issueScope(scope);
    const second = service.watchBinding(scope);
    service.invalidateConnector(scope.ownerId, scope.connectorId);
    assert.equal(second.signal.aborted, true);
    second.dispose();
    service.issueScope(scope);
    const third = service.watchBinding(scope);
    service.invalidateBinding(scope.ownerId, scope.workspaceId, scope.sourceId);
    assert.equal(third.signal.aborted, true);
    third.dispose();
  } finally {
    service.close();
  }
});

test("semantic edits invalidate only matching model contexts while reads and results survive", () => {
  const service = new ReadService({} as DataSourceStore, {} as ConnectorRegistry, testSessions);
  try {
    const grant = service.issueScope(scope);
    const other = { ...scope, sourceId: randomUUID() };
    const watcher = service.watchBinding(scope);
    const otherWatcher = service.watchBinding(other);
    const completedRead = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    service.jobs.claim(scope.connectorId);
    const result = encode({
      columns: [{ name: "id", type: "INT" }],
      rows: [[{ null: false, encoding: "text", value: "1" }]],
      timezone: "UTC",
      truncated: false,
    });
    service.jobs.complete(scope, completedRead, "ok", result);
    const preview = service.jobs.createModelSchema(scope, randomUUID());
    service.jobs.claim(scope.connectorId);
    service.jobs.complete(scope, preview, "ok", encode(schema));
    const runningRead = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    service.jobs.claim(scope.connectorId);
    const queuedRead = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    const authorization = service.jobs.createModelAuthorization(scope, randomUUID());
    const otherPreview = service.jobs.createModelSchema(other, randomUUID());

    service.invalidateModelContext(scope.ownerId, scope.workspaceId, scope.sourceId);

    assert.equal(watcher.signal.aborted, true);
    assert.equal(otherWatcher.signal.aborted, false);
    assert.equal(service.validScope(scope, grant.instanceId, grant.scopeToken, Date.now()), true);
    assert.deepEqual(service.jobs.status(scope, completedRead), {
      state: "completed",
      payload: result,
    });
    assert.deepEqual(service.jobs.status(scope, runningRead), { state: "running" });
    assert.deepEqual(service.jobs.status(scope, queuedRead), { state: "queued" });
    assert.equal(service.jobs.modelSchema(scope, preview), null);
    assert.deepEqual(service.jobs.status(scope, authorization), { state: "cancelled" });
    assert.deepEqual(service.jobs.status(other, otherPreview), { state: "queued" });
    assert.equal(service.jobs.complete(scope, runningRead, "ok", result), true);
    watcher.dispose();
    otherWatcher.dispose();
  } finally {
    service.close();
  }
});
