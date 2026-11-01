import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { RowDataPacket } from "mysql2/promise";
import { AuditTrail } from "../src/history/audit.js";
import { HistoryStore } from "../src/history/store.js";
import { stage7MigrationFile, inspectStage7 } from "../src/history/migration.js";
import { declareRequestAudit } from "../src/history/public.js";
import { mountSemanticRoutes } from "../src/semantic/routes.js";
import { SemanticStore } from "../src/semantic/store.js";
import { emptySemanticDocument } from "../src/semantic/model.js";
import { mutationFixture } from "./mutation-fixture.js";

test("unverified semantic targets cannot poison durable audit replay or later writes", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 20000,
}, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  const connection = await f.pool.getConnection();
  try {
    const { sql } = await stage7MigrationFile();
    await connection.query(sql.trim().replace(/;\s*$/, ""));
    await inspectStage7(connection);
  } finally {
    connection.release();
  }
  const directory = await mkdtemp(join(tmpdir(), "stackoryn-audit-attempts-"));
  const file = join(directory, "outbox.json");
  t.after(async () => {
    await unlink(file);
    await rmdir(directory);
  });
  const store = new HistoryStore(f.pool, f.sources);
  let unavailable = true;
  const delivery = new Proxy(store, {
    get(target, key, receiver) {
      if (key === "appendAudit")
        return (...args: Parameters<HistoryStore["appendAudit"]>) => {
          if (unavailable) return Promise.reject(new Error("synthetic delivery outage"));
          return target.appendAudit(...args);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  let trail = new AuditTrail(delivery, file);
  t.after(() => trail.close());
  const app = express();
  app.use((req, res, next) => trail.middleware(async () => f.binding.ownerId)(req, res, next));
  mountSemanticRoutes(
    app,
    async () => f.binding.ownerId,
    "http://localhost:5173",
    new SemanticStore(f.sources),
    {
      inWorkspace: async (_workspace, operation) => operation(),
      invalidateModelContext: () => {},
    },
  );
  app.post("/api/model/check", (_req, res) => {
    declareRequestAudit(res, "model.checked");
    res.json({ available: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const unknownWorkspace = randomUUID(),
    unknownSource = randomUUID();
  const cases = [
    {
      workspace: unknownWorkspace,
      source: unknownSource,
      origin: "http://localhost:5173",
      status: 404,
    },
    {
      workspace: unknownWorkspace,
      source: unknownSource,
      origin: "https://wrong.invalid",
      status: 403,
    },
    {
      workspace: unknownWorkspace.toUpperCase(),
      source: unknownSource,
      origin: "https://wrong.invalid",
      status: 403,
    },
    {
      workspace: `${unknownWorkspace.slice(0, 14)}7${unknownWorkspace.slice(15)}`,
      source: unknownSource,
      origin: "https://wrong.invalid",
      status: 403,
    },
  ];
  for (const item of cases) {
    const response = await fetch(`${base}/api/semantics/${item.workspace}/${item.source}`, {
      method: "PUT",
      headers: { origin: item.origin, "content-type": "application/json" },
      body: JSON.stringify({
        revision: 0,
        snapshotId: randomUUID(),
        document: emptySemanticDocument(),
      }),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, item.status);
    await response.arrayBuffer();
  }
  await trail.flush();
  assert.equal(trail.health().pending, 4);
  trail.close();
  unavailable = false;
  trail = new AuditTrail(store, file);
  await trail.flush();
  assert.equal(trail.health().available, true);
  assert.equal(trail.health().pending, 0);
  const response = await fetch(`${base}/api/model/check`, { method: "POST" });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await trail.flush();
  const [rows] = await f.pool.query<RowDataPacket[]>(
    "SELECT workspaceId,sourceId,content FROM history_entry WHERE kind='audit' ORDER BY sequence",
  );
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.workspaceId, null);
    assert.equal(row.sourceId, null);
  }
  const contents = rows.map((row) =>
    typeof row.content === "string" ? JSON.parse(row.content) : row.content,
  );
  assert.equal(contents[0].attemptedWorkspaceId, unknownWorkspace);
  assert.equal(contents[1].attemptedSourceId, unknownSource);
  assert.equal(contents[2].attemptedWorkspaceId, undefined);
  assert.equal(contents[3].attemptedWorkspaceId, undefined);
  assert.equal(contents[4].event, "model.checked");
});
