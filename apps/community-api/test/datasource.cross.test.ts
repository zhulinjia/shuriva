import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import express from "express";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import { ScopeCoordinator } from "../src/datasources/scope-coordinator.js";
import { scanHooks } from "../src/datasources/scan.js";
import { DataSourceStore } from "../src/datasources/store.js";
import { apiPackageRoot } from "../src/package-path.js";
import { createIsolatedDataSourceFixture } from "./isolated-datasource-fixture.js";

test("isolated Go connector executes an authorized signed metadata scan", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
  timeout: 90_000,
}, async () => {
  const fixture = await createIsolatedDataSourceFixture("cross");
  const { pool } = fixture;
  const dir = await mkdtemp(join(tmpdir(), "stage3-cross-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "registry.json"),
    randomBytes(32).toString("hex"),
  );
  const owner = randomUUID();
  const workspace = randomUUID();
  const source = randomUUID();
  const store = new DataSourceStore(pool);
  const app = express();
  const origin = "http://127.0.0.1:5173";
  const auth = async (headers: import("node:http").IncomingHttpHeaders) =>
    headers["x-test-owner"] === owner ? owner : undefined;
  mountConnectorRoutes(app, registry, origin, auth, scanHooks(store, registry));
  mountDataSourceRoutes(app, store, registry, origin, auth, new ScopeCoordinator(store, registry));
  const server = app.listen(0, "127.0.0.1");
  try {
    const metadataSource = await fixture.createMetadataSource();
    await pool.execute(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'fixture', ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [owner, `${owner}@example.invalid`],
    );
    await pool.execute(
      "INSERT INTO workspace (id, name, createdByAccountId, createdAt, updatedAt) VALUES (?, 'fixture', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [workspace, owner],
    );
    await new Promise<void>((resolve, reject) => {
      if (server.listening) resolve();
      else {
        server.once("listening", resolve);
        server.once("error", reject);
      }
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const offerResponse = await fetch(`${base}/api/connectors/pairings`, {
      method: "POST",
      headers: { origin, "x-test-owner": owner },
    });
    assert.equal(offerResponse.status, 201);
    const offer = (await offerResponse.json()) as {
      pairingId: string;
      secret: string;
      platformPublicKey: string;
    };
    const cwd = resolve(apiPackageRoot(), "../../connector/go");
    const result = await new Promise<{ status: number | null; output: string; error: string }>(
      (resolve, reject) => {
        const child = spawn("go", ["run", "./testdata/stage3probe"], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60_000,
        });
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, output, error }));
        child.stdin.end(
          JSON.stringify({
            server: base,
            code: `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`,
            owner,
            workspace,
            source,
            sourceDatabase: metadataSource.database,
            sourceUsername: metadataSource.username,
            sourcePassword: metadataSource.password,
          }),
        );
      },
    );
    assert.equal(result.status, 0, result.error);
    const scan = await store.scanStatus(owner, workspace, source);
    assert.equal(
      scan?.status,
      "completed",
      `metadata scan ended with ${scan?.errorCode ?? "no result"}`,
    );
    const snapshotResponse = await fetch(
      `${base}/api/data-sources/workspaces/${workspace}/${source}/snapshot`,
      {
        headers: { "x-test-owner": owner },
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const data = (await snapshotResponse.json()) as {
      snapshot: { content: { tables: unknown[]; columns: unknown[]; relations: unknown[] } };
    };
    const content = data.snapshot.content;
    assert.equal(content.tables.length, 3);
    assert.equal(content.columns.length, 6);
    assert.equal(content.relations.length, 1);
    const history = await store.history(owner, workspace, source);
    assert.equal(
      history.snapshots.length,
      2,
      "replacement connector preserves and extends history",
    );
    assert.equal((await store.scanStatus(owner, workspace, source))?.status, "completed");
    assert.equal((await fetch(`${base}/api/data-sources`)).status, 401);
    const connectorId = (JSON.parse(result.output) as { connectorId: string }).connectorId;
    const sourceBase = `${base}/api/data-sources/workspaces/${workspace}/${source}`;
    assert.equal(
      (
        await fetch(`${sourceBase}/scan`, {
          method: "POST",
          headers: { origin: "http://evil.example", "x-test-owner": owner },
        })
      ).status,
      403,
    );
    const request = await fetch(`${sourceBase}/scan`, {
      method: "POST",
      headers: { origin, "x-test-owner": owner },
    });
    assert.equal(request.status, 202);
    const task = (await request.json()) as { id: string };
    const forged = {
      connectorId,
      taskId: task.id,
      workspaceId: workspace,
      sourceId: source,
      outcome: "ok",
      payload: "e30",
      agentVersion: "test",
      protocol: 2,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: randomBytes(64).toString("base64url"),
    };
    assert.equal(
      (
        await fetch(`${base}/api/connector-agent/scan-result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(forged),
        })
      ).status,
      403,
    );
    assert.equal((await store.scanStatus(owner, workspace, source))?.status, "pending");
    assert.equal(
      (await fetch(sourceBase, { method: "DELETE", headers: { origin, "x-test-owner": owner } }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(`${sourceBase}/snapshot`, { headers: { "x-test-owner": owner } })).status,
      404,
    );
  } catch (error) {
    console.error("Isolated stage 3 cross test failed:", error);
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    await rm(dir, { recursive: true, force: true });
    await fixture.close();
  }
});
