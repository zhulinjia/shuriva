import { testSessions, testSessionId } from "./session-fixture.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { ReadJobs } from "../src/queries/jobs.js";
import type { ReadResult } from "../src/protocol/read-task.js";
import { ReadService } from "../src/queries/service.js";

test("an old result cannot clear cancellation of a new same-ID task after unbinding", async () => {
  const scope = {
    sessionId: testSessionId,
    ownerId: "owner",
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const store = { boundSource: async () => null } as unknown as DataSourceStore;
  const registry = {
    preflightReadResult: async () => {},
    verifyReadResult: async (_input: unknown, commit: () => Promise<void>) => commit(),
    readResultAcknowledgement: () => "ack",
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry, testSessions);
  try {
    const id = randomUUID();
    service.jobs.create(scope, id, "SELECT id FROM items", [], 1);
    const current = service.jobs.claim(scope.connectorId);
    assert.ok(current?.type === "read");
    assert.equal(service.jobs.cancel(scope, id), true);
    assert.equal(service.jobs.busy(scope.connectorId), true);
    const stale: ReadResult = {
      taskId: id,
      connectorId: scope.connectorId,
      actorId: scope.ownerId,
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      taskNonce: randomBytes(32).toString("base64url"),
      outcome: "failed",
      payload: "cancelled",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "fixture",
    };
    assert.notEqual(stale.taskNonce, current.task.nonce);
    await service.result(stale);
    assert.equal(
      service.jobs.busy(scope.connectorId),
      true,
      "stale result must not acknowledge the new cancellation",
    );
  } finally {
    service.close();
  }
});

test("a process restart rejects stale instance tokens and stale results with a reused ID", async () => {
  const scope = {
    sessionId: testSessionId,
    ownerId: "owner",
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const store = {
    boundSource: async () => ({ connectorId: scope.connectorId }),
  } as unknown as DataSourceStore;
  const registry = {
    preflightReadResult: async () => {},
    verifyReadResult: async (_input: unknown, commit: () => Promise<void>) => commit(),
    readResultAcknowledgement: () => "ack",
  } as unknown as ConnectorRegistry;
  const old = new ReadService(store, registry, testSessions);
  const current = new ReadService(store, registry, testSessions);
  try {
    const oldScope = old.issueScope(scope);
    assert.equal(old.validScope(scope, oldScope.instanceId, oldScope.scopeToken, Date.now()), true);
    assert.equal(
      current.validScope(scope, oldScope.instanceId, oldScope.scopeToken, Date.now()),
      false,
    );
    const newScope = current.issueScope(scope);
    assert.equal(
      current.validScope(scope, newScope.instanceId, newScope.scopeToken, Date.now()),
      true,
    );
    const id = randomUUID();
    old.jobs.create(scope, id, "SELECT id FROM a", [], 1);
    const first = old.jobs.claim(scope.connectorId);
    current.jobs.create(scope, id, "SELECT id FROM b", [], 1);
    const second = current.jobs.claim(scope.connectorId);
    assert.ok(first?.type === "read" && second?.type === "read");
    assert.notEqual(first.task.nonce, second.task.nonce);
    const stale: ReadResult = {
      taskId: id,
      connectorId: scope.connectorId,
      actorId: scope.ownerId,
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      taskNonce: first.task.nonce,
      outcome: "failed",
      payload: "denied",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "fixture",
    };
    await current.result(stale);
    assert.deepEqual(current.jobs.status(scope, id), { state: "running" });
  } finally {
    old.close();
    current.close();
  }
});

test("unbind and rebind invalidate a previously acquired scope token", () => {
  const scope = {
    sessionId: testSessionId,
    ownerId: "owner",
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const service = new ReadService({} as DataSourceStore, {} as ConnectorRegistry, testSessions);
  try {
    const old = service.issueScope(scope);
    service.invalidateBinding(scope.ownerId, scope.workspaceId, scope.sourceId);
    const rebound = service.issueScope(scope);
    assert.notEqual(old.scopeToken, rebound.scopeToken);
    assert.equal(
      service.validScope(scope, old.instanceId, old.scopeToken, Date.now() + 20_000),
      false,
    );
    assert.equal(
      service.validScope(scope, rebound.instanceId, rebound.scopeToken, Date.now()),
      true,
    );
    assert.equal(
      service.validScope(scope, rebound.instanceId, rebound.scopeToken, Date.now() - 121_000),
      false,
    );
  } finally {
    service.close();
  }
});

test("unread results remain available under capacity pressure until explicitly released", () => {
  const scope = {
    sessionId: testSessionId,
    ownerId: "owner",
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const jobs = new ReadJobs(() => 1_000_000);
  try {
    const ids: string[] = [];
    const body = Buffer.from(
      JSON.stringify({
        columns: [{ name: "id", type: "INT" }],
        rows: [],
        timezone: "UTC",
        truncated: false,
      }),
    ).toString("base64url");
    for (let i = 0; i < 32; i++) {
      const id = randomUUID();
      ids.push(id);
      jobs.create(scope, id, "SELECT id FROM items", [], 1);
      const task = jobs.claim(scope.connectorId);
      assert.ok(task?.type === "read");
      assert.equal(task.task.id, id);
      assert.equal(jobs.complete(scope, id, "ok", body), true);
    }
    const first = ids[0];
    assert.ok(first);
    assert.throws(
      () => jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1),
      /RESULT_CAPACITY/,
    );
    for (const id of ids)
      assert.deepEqual(jobs.status(scope, id), { state: "completed", payload: body });
    assert.equal(jobs.cancel(scope, first), true);
    assert.doesNotThrow(() => jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1));
    assert.deepEqual(jobs.status(scope, first), { state: "expired" });
  } finally {
    jobs.close();
  }
});

test("HTTP late POST cannot cross an unbind/rebind boundary", async () => {
  const scope = {
    sessionId: testSessionId,
    ownerId: "owner",
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  let bound = true;
  const store = {
    boundSource: async () => (bound ? { connectorId: scope.connectorId } : null),
    unbind: async () => {
      bound = false;
    },
    bind: async () => {
      bound = true;
    },
  } as unknown as DataSourceStore;
  const registry = {
    withActiveOwner: async (_owner: string, _id: string, action: () => unknown) => action(),
  } as unknown as ConnectorRegistry;
  const service = new ReadService(store, registry, testSessions);
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
    const base = `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${scope.workspaceId}/${scope.sourceId}`;
    const headers = { origin, "content-type": "application/json" };
    const previous = (await (await fetch(`${base}/queries/scope`, { headers })).json()) as {
      instanceId: string;
      scopeToken: string;
    };
    assert.equal((await fetch(base, { method: "DELETE", headers })).status, 200);
    assert.equal((await fetch(base, { method: "PUT", headers })).status, 201);
    const later = (await (await fetch(`${base}/queries/scope`, { headers })).json()) as {
      instanceId: string;
      scopeToken: string;
    };
    assert.notEqual(previous.scopeToken, later.scopeToken);
    const id = randomUUID();
    const query = {
      requestId: id,
      sql: "SELECT id FROM items",
      parameters: [],
      maxRows: 1,
      submittedAt: Date.now() + 20_000,
      schemaVersion: null,
    };
    const stale = await fetch(`${base}/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...query, ...previous }),
    });
    assert.equal(stale.status, 409);
    assert.equal(service.jobs.status(scope, id), null);
    const fresh = await fetch(`${base}/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...query, ...later }),
    });
    assert.equal(fresh.status, 202);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  }
});
