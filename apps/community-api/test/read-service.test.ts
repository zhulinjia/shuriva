import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import { ScopeCoordinator } from "../src/datasources/scope-coordinator.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import type { ReadResult } from "../src/protocol/read-task.js";
import { ReadService } from "../src/queries/service.js";

const scope = {
  ownerId: "owner",
  connectorId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
};

test("read dispatch rechecks binding and does not deliver a task cancelled during signing", async () => {
  let bound = false;
  let started!: () => void;
  let resume!: () => void;
  const signingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const signingResume = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const store = {
    boundSource: async () => (bound ? { connectorId: scope.connectorId } : null),
  } as unknown as DataSourceStore;
  const registry = {
    issueReadTask: async (task: object) => {
      started();
      await signingResume;
      return { ...task, signature: "fixture" };
    },
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry);
  const first = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
  assert.equal(await service.next(scope.connectorId), null);
  assert.deepEqual(service.jobs.status(scope, first), { state: "failed", payload: "denied" });
  bound = true;
  const second = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
  const pending = service.next(scope.connectorId);
  await signingStarted;
  assert.equal(service.jobs.cancel(scope, second), true);
  resume();
  assert.equal(await pending, null);
  assert.deepEqual(service.jobs.status(scope, second), { state: "cancelled" });
  service.close();
});

test("result is discarded when the source is unbound before publication", async () => {
  const store = { boundSource: async () => null } as unknown as DataSourceStore;
  const registry = {
    preflightReadResult: async () => {},
    verifyReadResult: async (_input: unknown, commit: () => Promise<void>) => commit(),
    readResultAcknowledgement: () => "ack",
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry);
  const id = service.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
  const dispatched = service.jobs.claim(scope.connectorId);
  assert.ok(dispatched?.type === "read");
  const result: ReadResult = {
    taskId: id,
    connectorId: scope.connectorId,
    actorId: scope.ownerId,
    workspaceId: scope.workspaceId,
    sourceId: scope.sourceId,
    taskNonce: dispatched.task.nonce,
    outcome: "failed",
    payload: "error",
    timestamp: 1,
    nonce: "fixture",
    signature: "fixture",
  };
  assert.equal(await service.result(result), "ack");
  assert.deepEqual(service.jobs.status(scope, id), { state: "cancelled" });
  assert.equal(service.jobs.busy(scope.connectorId), false);
  service.close();
});

test("transient binding lookup failure retains the same task for the next heartbeat", async () => {
  let attempts = 0;
  const store = {
    boundSource: async () => {
      if (++attempts === 1) throw new Error("temporary unavailable");
      return { connectorId: scope.connectorId };
    },
  } as unknown as DataSourceStore;
  const registry = {
    issueReadTask: async (task: object) => ({ ...task, signature: "fixture" }),
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry);
  const id = randomUUID();
  try {
    service.jobs.create(scope, id, "SELECT id FROM items", [], 1);
    await assert.rejects(() => service.next(scope.connectorId));
    assert.deepEqual(service.jobs.status(scope, id), { state: "running" });
    const retry = await service.next(scope.connectorId);
    assert.equal(retry?.id, id);
    assert.equal(retry?.operation, "read_query");
    assert.equal((await service.next(scope.connectorId))?.id, id);
  } finally {
    service.close();
  }
});

test("a concurrent unbind cancels a query created after its authorization check began", async () => {
  let bound = true;
  let started!: () => void;
  let resume!: () => void;
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const store = {
    boundSource: async () => {
      const wasBound = bound;
      started();
      await proceed;
      return wasBound ? { connectorId: scope.connectorId } : null;
    },
    unbind: async () => {
      bound = false;
    },
  } as unknown as DataSourceStore;
  const registry = {
    withActiveOwner: async (_owner: string, _id: string, action: () => unknown) => action(),
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry);
  const app = express();
  let removalArrived!: () => void;
  const removalSeen = new Promise<void>((resolve) => {
    removalArrived = resolve;
  });
  app.use((req, _res, next) => {
    if (req.method === "DELETE") removalArrived();
    next();
  });
  const origin = "http://localhost:5173";
  mountDataSourceRoutes(
    app,
    store,
    registry,
    origin,
    async () => scope.ownerId,
    service.coordinator,
    service,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${scope.workspaceId}/${scope.sourceId}`;
    const capability = await fetch(
      `http://127.0.0.1:${address.port}/api/data-sources/query-capability`,
    );
    assert.deepEqual(await capability.json(), { enabled: true });
    const headers = { origin, "content-type": "application/json" };
    const creation = fetch(`${base}/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: randomUUID(),
        ...service.issueScope(scope),
        submittedAt: Date.now(),
        sql: "SELECT id FROM items",
        parameters: [],
        maxRows: 1,
        schemaVersion: null,
      }),
    });
    await checking;
    const removal = fetch(base, { method: "DELETE", headers });
    await removalSeen;
    assert.equal(bound, true, "unbind must wait until the authorization check finishes");
    // A different workspace remains independent while this authorization check waits.
    assert.equal(await service.inWorkspace("other-workspace", async () => "ready"), "ready");
    resume();
    const created = await creation;
    assert.equal(created.status, 202);
    const job = (await created.json()) as { id: string };
    assert.equal((await removal).status, 200);
    assert.deepEqual(service.jobs.status(scope, job.id), { state: "cancelled" });
  } finally {
    resume();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  }
});

test("query capability is authenticated and reports disabled without the read service", async () => {
  const app = express();
  const store = {} as DataSourceStore;
  const registry = {} as ConnectorRegistry;
  mountDataSourceRoutes(
    app,
    store,
    registry,
    "http://localhost:5173",
    async (headers) => (headers["x-test-owner"] === "owner" ? "owner" : undefined),
    new ScopeCoordinator(store, registry),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/data-sources/query-capability`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.deepEqual(
      await (await fetch(endpoint, { headers: { "x-test-owner": "owner" } })).json(),
      { enabled: false },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cancel-before-create and same-ID retry are safe through HTTP routes", async () => {
  const store = {
    boundSource: async () => ({ connectorId: scope.connectorId }),
  } as unknown as DataSourceStore;
  const registry = {
    withActiveOwner: async (_owner: string, _id: string, action: () => unknown) => action(),
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry);
  const app = express();
  const origin = "http://localhost:5173";
  mountDataSourceRoutes(
    app,
    store,
    registry,
    origin,
    async () => scope.ownerId,
    service.coordinator,
    service,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${scope.workspaceId}/${scope.sourceId}/queries`;
    const id = randomUUID();
    const headers = { origin, "content-type": "application/json" };
    const body = JSON.stringify({
      requestId: id,
      ...service.issueScope(scope),
      submittedAt: Date.now(),
      sql: "SELECT id FROM items",
      parameters: [],
      maxRows: 1,
      schemaVersion: null,
    });
    assert.equal((await fetch(`${base}/${id}`, { method: "DELETE", headers })).status, 200);
    const response = await fetch(base, { method: "POST", headers, body });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id });
    assert.deepEqual(await (await fetch(`${base}/${id}`, { headers })).json(), {
      state: "cancelled",
    });
    assert.equal(service.jobs.claim(scope.connectorId), null);
    const other = randomUUID();
    const first = JSON.stringify({
      requestId: other,
      ...service.issueScope(scope),
      submittedAt: Date.now(),
      sql: "SELECT id FROM items",
      parameters: [],
      maxRows: 1,
      schemaVersion: null,
    });
    const changed = JSON.stringify({
      requestId: other,
      ...service.issueScope(scope),
      submittedAt: Date.now(),
      sql: "SELECT name FROM items",
      parameters: [],
      maxRows: 1,
      schemaVersion: null,
    });
    assert.equal((await fetch(base, { method: "POST", headers, body: first })).status, 202);
    assert.equal((await fetch(base, { method: "POST", headers, body: first })).status, 202);
    assert.equal((await fetch(base, { method: "POST", headers, body: changed })).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  }
});
