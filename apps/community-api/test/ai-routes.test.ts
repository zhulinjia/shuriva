import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { ModelStore } from "../src/ai/model-store.js";
import { mountModelRoutes } from "../src/ai/routes.js";

test("model routes require authentication and origin, never return stored credentials", async () => {
  const credentials = new Map<string, string>();
  const store = new ModelStore((owner) => ({
    getPassword: () => credentials.get(owner) ?? null,
    setPassword: (value) => {
      credentials.set(owner, value);
    },
    deletePassword: () => credentials.delete(owner),
  }));
  const app = express();
  mountModelRoutes(
    app,
    async (headers) => (headers.authorization === "Bearer alice" ? "alice" : undefined),
    "http://localhost:5173",
    store,
  );
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  const url = `http://127.0.0.1:${address.port}/api/model/config`;
  const auth = {
    authorization: "Bearer alice",
    origin: "http://localhost:5173",
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    baseUrl: "https://example.com/v1",
    model: "fake",
    apiKey: "test-secret",
  });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { method: "PUT", headers: { ...auth, origin: "http://other" }, body }))
        .status,
      403,
    );
    const saved = await fetch(url, { method: "PUT", headers: auth, body });
    assert.equal(saved.status, 200);
    const response = await saved.text();
    assert.equal(response.includes("test-secret"), false);
    const displayed = JSON.parse(response) as Record<string, unknown>;
    assert.deepEqual(displayed, {
      configured: true,
      baseUrl: "https://example.com/v1",
      model: "fake",
      configVersion: store.versioned("alice")?.configVersion,
    });
    assert.equal((await fetch(url, { method: "DELETE", headers: auth })).status, 200);
    assert.deepEqual(await (await fetch(url, { headers: auth })).json(), { configured: false });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a model check is bound to the displayed configuration, including credential changes", async () => {
  const values = new Map<string, string>();
  const store = new ModelStore((owner) => ({
    getPassword: () => values.get(owner) ?? null,
    setPassword: (value) => {
      values.set(owner, value);
    },
    deletePassword: () => values.delete(owner),
  }));
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (_req, res) => {
    calls++;
    started();
    await providerRelease;
    if (!res.destroyed)
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({ kind: "clarification", question: "请补充问题" }),
              },
            },
          ],
        }),
      );
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === "string")
    throw new Error("test provider unavailable");
  const config = {
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    model: "test",
    apiKey: "fake-A",
  };
  const app = express();
  mountModelRoutes(
    app,
    async (requestHeaders) => (requestHeaders.authorization === "bob" ? "bob" : "alice"),
    "http://localhost:5173",
    store,
  );
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  const base = `http://127.0.0.1:${address.port}/api/model`;
  const headers = { origin: "http://localhost:5173", "content-type": "application/json" };
  const check = (configVersion: string) =>
    fetch(`${base}/check`, { method: "POST", headers, body: JSON.stringify({ configVersion }) });
  try {
    store.set("alice", config);
    const displayed = (await (await fetch(`${base}/config`)).json()) as { configVersion: string };
    assert.match(displayed.configVersion, /^[A-Za-z0-9_-]{43}$/);
    store.set("alice", { ...config, apiKey: "fake-B" });
    const stale = await check(displayed.configVersion);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "STALE" });
    assert.equal(calls, 0);
    const current = store.versioned("alice");
    assert.ok(current);
    const pending = check(current.configVersion);
    await providerStarted;
    store.set("alice", { ...config, apiKey: "fake-C" });
    const changed = await pending;
    assert.equal(changed.status, 409);
    assert.deepEqual(await changed.json(), { error: "STALE" });
    assert.equal(calls, 1);
    release();
    store.set("bob", config);
    const bob = store.versioned("bob");
    assert.ok(bob);
    const success = await fetch(`${base}/check`, {
      method: "POST",
      headers: { ...headers, authorization: "bob" },
      body: JSON.stringify({ configVersion: bob.configVersion }),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { available: true });
    assert.equal(calls, 2);
  } finally {
    release();
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
  }
});
