import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import { ScopeCoordinator } from "../src/datasources/scope-coordinator.js";
import { mutationFixture } from "./mutation-fixture.js";

test("batched binding status only returns requested authorized bound sources", {
  skip: process.env.STAGE8_G3_TEST !== "1",
}, async () => {
  const fixture = await mutationFixture();
  const origin = "http://127.0.0.1:5199";
  const app = express();
  const registry = {} as ConnectorRegistry;
  mountDataSourceRoutes(
    app,
    fixture.sources,
    registry,
    origin,
    async (headers) => (headers.cookie === "isolated" ? fixture.binding.ownerId : undefined),
    new ScopeCoordinator(fixture.sources, registry),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${fixture.binding.workspaceId}`;
  const headers = { origin, cookie: "isolated", "content-type": "application/json" };
  const unbound = randomUUID(),
    unknown = randomUUID(),
    foreignOwner = randomUUID(),
    foreignWorkspace = randomUUID(),
    foreignSource = randomUUID();
  try {
    await fixture.pool.execute(
      "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'unbound',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [unbound, fixture.binding.ownerId, fixture.binding.connectorId],
    );
    await fixture.pool.execute(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'foreign',?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [foreignOwner, `${foreignOwner}@example.invalid`],
    );
    await fixture.pool.execute(
      "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'foreign',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [foreignWorkspace, foreignOwner],
    );
    await fixture.pool.execute(
      "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'foreign',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [foreignSource, foreignOwner, randomUUID()],
    );
    await fixture.pool.execute(
      "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
      [foreignWorkspace, foreignSource],
    );
    const response = await fetch(`${base}/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceIds: [fixture.binding.sourceId, unbound, unknown, foreignSource],
      }),
    });
    assert.equal(response.status, 200);
    const actual = (await response.json()) as {
      sources: {
        id: string;
        isDefault: number;
        scanStatus: string | null;
        errorCode: string | null;
      }[];
    };
    assert.equal(actual.sources.length, 1);
    assert.equal(actual.sources[0]?.id, fixture.binding.sourceId);
    const listed = (await (await fetch(base, { headers })).json()) as {
      sources: typeof actual.sources;
    };
    assert.deepEqual(actual.sources, listed.sources);
    const empty = await fetch(`${base}/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceIds: [] }),
    });
    assert.deepEqual(await empty.json(), { sources: [] });
    for (const body of [
      { sourceIds: [unknown, unknown] },
      { sourceIds: ["not-uuid"] },
      { sourceIds: Array.from({ length: 101 }, () => randomUUID()) },
      { sourceIds: [], extra: true },
    ]) {
      assert.equal(
        (await fetch(`${base}/status`, { method: "POST", headers, body: JSON.stringify(body) }))
          .status,
        400,
      );
    }
    assert.equal(
      (
        await fetch(`${base}/status`, {
          method: "POST",
          headers: { ...headers, origin: "http://invalid.example" },
          body: JSON.stringify({ sourceIds: [] }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/status`, {
          method: "POST",
          headers: { ...headers, cookie: "unknown" },
          body: JSON.stringify({ sourceIds: [] }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${address.port}/api/data-sources/workspaces/${foreignWorkspace}/status`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ sourceIds: [fixture.binding.sourceId] }),
          },
        )
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
});
