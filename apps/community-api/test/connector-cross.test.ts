import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";

test("Go connector pairs, heartbeats and rotates against actual TypeScript routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-cross-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  const app = express();
  const origin = "http://127.0.0.1:5173";
  mountConnectorRoutes(app, registry, origin, async (headers) =>
    headers["x-test-owner"] === "owner" ? "owner" : undefined,
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/connectors`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/connectors/pairings`, {
          method: "POST",
          headers: { origin: "http://evil.example", "x-test-owner": "owner" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/connector-agent/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocol: 1, unexpected: true }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/connector-agent/execute`, { method: "POST" })).status,
      404,
    );
    assert.equal((await fetch(`${base}/api/connector-agent/pair`, { method: "POST" })).status, 400);
    const offerResponse = await fetch(`${base}/api/connectors/pairings`, {
      method: "POST",
      headers: { origin, "x-test-owner": "owner" },
    });
    assert.equal(offerResponse.status, 201);
    const offer = (await offerResponse.json()) as {
      pairingId: string;
      secret: string;
      platformPublicKey: string;
    };
    const workingDirectory = fileURLToPath(new URL("../../../../connector/go/", import.meta.url));
    const result = await new Promise<{ status: number | null; output: string; error: string }>(
      (resolve, reject) => {
        const child = spawn("go", ["run", "./testdata/probe"], {
          cwd: workingDirectory,
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
          }),
        );
      },
    );
    assert.equal(result.status, 0, result.error);
    const probe = JSON.parse(result.output) as { id: string };
    const listed = await fetch(`${base}/api/connectors`, { headers: { "x-test-owner": "owner" } });
    const data = (await listed.json()) as {
      connectors: Array<{ id: string; status: string; diagnosticStatus: string }>;
    };
    assert.equal(data.connectors.length, 1);
    assert.equal(data.connectors[0]?.id, probe.id);
    assert.equal(data.connectors[0]?.status, "online");
    assert.equal(data.connectors[0]?.diagnosticStatus, "completed");
    assert.equal(
      (
        await fetch(`${base}/api/connectors/${probe.id}/revoke`, {
          method: "POST",
          headers: { origin, "x-test-owner": "owner" },
        })
      ).status,
      200,
    );
    assert.equal((await registry.list("owner"))[0]?.status, "revoked");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
