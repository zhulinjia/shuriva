import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { ReadService } from "../src/queries/service.js";

test("full cancellation tombstones invalidate the scope before a late creation", async () => {
  const originalNow = Date.now;
  const base = originalNow();
  let now = base - 350_000;
  Date.now = () => now;
  const scope = {
    ownerId: "owner",
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const store = {
    boundSource: async () => ({ connectorId: scope.connectorId }),
  } as unknown as DataSourceStore;
  const registry = {
    withActiveOwner: async (_owner: string, _connector: string, action: () => unknown) => action(),
  } as unknown as ConnectorRegistry;
  const read = new ReadService(store, registry);
  const app = express();
  const origin = "http://127.0.0.1:5173";
  mountDataSourceRoutes(
    app,
    store,
    registry,
    origin,
    async () => scope.ownerId,
    read.coordinator,
    read,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    const existing = randomUUID();
    now = base;
    read.jobs.create(scope, existing, "SELECT id FROM customers", [], 1);
    now = base - 350_000;
    for (let i = 0; i < 2047; i++) assert.equal(read.jobs.cancel(scope, randomUUID()), true);
    now = base;
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${scope.workspaceId}/${scope.sourceId}/queries`;
    const oldScope = (await (await fetch(`${endpoint}/scope`)).json()) as {
      instanceId: string;
      scopeToken: string;
    };
    const lostId = randomUUID();
    const headers = { origin, "content-type": "application/json" };
    assert.equal((await fetch(`${endpoint}/${lostId}`, { method: "DELETE", headers })).status, 200);
    // Invalidating an unrecordable cancellation must not cancel accepted tasks.
    assert.equal(read.jobs.status(scope, existing)?.state, "queued");
    assert.equal(
      (await fetch(`${endpoint}/${existing}`, { method: "DELETE", headers })).status,
      200,
    );
    assert.equal(read.jobs.status(scope, existing)?.state, "cancelled");
    now = base + 11_000;
    read.jobs.prune();
    const body = {
      requestId: lostId,
      instanceId: oldScope.instanceId,
      scopeToken: oldScope.scopeToken,
      submittedAt: base,
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 1,
      schemaVersion: null,
    };
    const late = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(late.status, 409);
    assert.equal(read.jobs.status(scope, lostId), null);
    const freshScope = (await (await fetch(`${endpoint}/scope`)).json()) as {
      instanceId: string;
      scopeToken: string;
    };
    const fresh = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, ...freshScope, requestId: randomUUID() }),
    });
    assert.equal(fresh.status, 202);
  } finally {
    Date.now = originalNow;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    read.close();
  }
});
