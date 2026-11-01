import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { mountHistoryRoutes } from "../src/history/routes.js";
import type { HistoryStore } from "../src/history/store.js";
import { DataSourceError } from "../src/datasources/public.js";
import { ReadService } from "../src/queries/service.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";

test("history HTTP boundary authenticates, rejects cross-origin writes and forwards only authenticated scope", async () => {
  const actor = randomUUID(),
    workspace = randomUUID(),
    source = randomUUID(),
    id = randomUUID(),
    origin = "http://localhost:5177";
  const calls: unknown[] = [];
  const store = {
    save: async (
      scope: object,
      kind: string,
      item: string,
      revision: unknown,
      content: unknown,
    ) => {
      calls.push({ scope, kind, item, revision, content });
      return { id: item, revision: 1 };
    },
    recordExport: async (scope: object) => {
      calls.push(scope);
    },
    listAudit: async () => {
      throw new DataSourceError("INVALID");
    },
  } as unknown as HistoryStore;
  const app = express();
  mountHistoryRoutes(
    app,
    async (headers) => (headers.authorization === "fixture" ? actor : undefined),
    origin,
    store,
    {
      withCurrentReadScope: async (_scope: object, operation: () => Promise<void>) => operation(),
    } as unknown as ReadService,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/history`;
    assert.equal((await fetch(`${base}/capability`)).status, 401);
    const headers = { authorization: "fixture", origin, "content-type": "application/json" };
    assert.deepEqual(await (await fetch(`${base}/capability`, { headers })).json(), {
      enabled: true,
    });
    const url = `${base}/${workspace}/${source}/conversation/${id}`;
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers, origin: "https://untrusted.invalid" },
          body: '{"revision":0,"content":{}}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ revision: 0, content: { title: "fixture" }, ownerId: "attacker" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url.replace("conversation", "execution"), {
          method: "PUT",
          headers,
          body: '{"revision":0,"content":{}}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ revision: 0, content: { title: "fixture" } }),
        })
      ).status,
      200,
    );
    assert.deepEqual(calls[0], {
      scope: { ownerId: actor, workspaceId: workspace, sourceId: source },
      kind: "conversation",
      item: id,
      revision: 0,
      content: { title: "fixture" },
    });
    assert.equal(
      (
        await fetch(`${base}/${workspace}/${source}/export`, {
          method: "POST",
          headers,
          body: '{"rows":[]}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/${workspace}/${source}/export`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(calls.length, 2);
    assert.equal((await fetch(`${base}/audit?after=invalid`, { headers })).status, 400);
    assert.equal((await fetch(url, { method: "PUT", headers, body: "{" })).status, 400);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ revision: 0, content: "x".repeat(280 * 1024) }),
        })
      ).status,
      413,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("disabled history never exposes write or history endpoints", async () => {
  const app = express();
  mountHistoryRoutes(app, async () => "owner", "http://localhost:5177", undefined, undefined);
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/history`;
    assert.deepEqual(await (await fetch(`${base}/capability`)).json(), { enabled: false });
    assert.equal((await fetch(`${base}/executions`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("export rechecks current Connector revocation and binding before authorizing a cached result", async () => {
  const scope = { ownerId: randomUUID(), workspaceId: randomUUID(), sourceId: randomUUID() },
    connectorId = randomUUID(),
    origin = "http://localhost:5177";
  let active = false,
    bound = true,
    exports = 0;
  const sources = {
    boundSource: async () => (bound ? { connectorId } : null),
  } as unknown as DataSourceStore;
  const registry = {
    withActiveOwner: async (_owner: string, _id: string, operation: () => Promise<unknown>) =>
      active ? operation() : undefined,
  } as unknown as ConnectorRegistry;
  const read = new ReadService(sources, registry);
  const store = {
    recordExport: async () => {
      exports++;
    },
  } as unknown as HistoryStore;
  const app = express();
  mountHistoryRoutes(app, async () => scope.ownerId, origin, store, read);
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/history/${scope.workspaceId}/${scope.sourceId}/export`;
    const request = () =>
      fetch(endpoint, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await request()).status, 404);
    assert.equal(exports, 0);
    active = true;
    assert.equal((await request()).status, 200);
    assert.equal(exports, 1);
    bound = false;
    assert.equal((await request()).status, 404);
    assert.equal(exports, 1);
  } finally {
    read.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
