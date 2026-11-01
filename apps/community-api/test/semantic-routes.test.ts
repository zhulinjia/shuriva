import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import type { ReadService } from "../src/queries/service.js";
import { mountSemanticRoutes } from "../src/semantic/routes.js";
import type { SemanticStore } from "../src/semantic/store.js";

test("semantic routes require owner and origin and invalidate previews after a successful save", async () => {
  let saves = 0,
    invalidations = 0;
  const store = {
    get: async () => ({ revision: 0 }),
    save: async () => {
      saves++;
      return { revision: 1 };
    },
  } as unknown as SemanticStore;
  const read = {
    inWorkspace: async (_id: string, action: () => unknown) => action(),
    invalidateModelContext: () => {
      invalidations++;
    },
  } as unknown as ReadService;
  const app = express();
  mountSemanticRoutes(
    app,
    async (headers) => (headers.authorization === "owner" ? "owner" : undefined),
    "http://localhost:5173",
    store,
    read,
  );
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}/api/semantics/workspace/source`;
  const body = JSON.stringify({ revision: 0, snapshotId: "fixture", document: {} });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: {
            authorization: "owner",
            origin: "http://evil.example",
            "content-type": "application/json",
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: {
            authorization: "owner",
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body: JSON.stringify({ revision: 0, extra: true }),
        })
      ).status,
      400,
    );
    assert.equal(saves, 0);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: {
            authorization: "owner",
            origin: "http://localhost:5173",
            "content-type": "application/json",
          },
          body,
        })
      ).status,
      200,
    );
    assert.equal(saves, 1);
    assert.equal(invalidations, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
