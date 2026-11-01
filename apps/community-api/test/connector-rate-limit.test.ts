import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import {
  ConnectorRegistry,
  canonicalPair,
  canonicalPairProof,
  type PairInput,
} from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";

test("invalid requests and full duplicate cache cannot block a valid connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-rate-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  const app = express();
  mountConnectorRoutes(app, registry, "http://127.0.0.1:5173", async () => undefined);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/connector-agent/heartbeat`;
    const offer = await registry.createPairing("owner");
    const identity = generateKeyPairSync("ed25519");
    const pair: PairInput = {
      pairingId: offer.pairingId,
      proof: "",
      connectorId: randomUUID(),
      name: "test",
      publicKey: identity.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64url"),
      agentVersion: "test",
      protocol: 2,
      signature: "",
    };
    pair.proof = createHmac("sha256", createHash("sha256").update(offer.secret).digest())
      .update(canonicalPairProof(pair).join("\n"))
      .digest("base64url");
    pair.signature = sign(
      null,
      Buffer.from(canonicalPair(pair).join("\n")),
      identity.privateKey,
    ).toString("base64url");
    await registry.pair(pair);
    const message = {
      connectorId: pair.connectorId,
      agentVersion: "test",
      protocol: 1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    const post = (body: typeof message) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const duplicate = { ...message, signature: randomBytes(64).toString("base64url") };
    for (let i = 0; i < 30; i++) assert.equal((await post(duplicate)).status, 403);
    assert.equal((await post(duplicate)).status, 429);
    // Fill and exceed the limiter's capacity with forged messages for the same ID.
    for (let batch = 0; batch < 41; batch++) {
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          post({ ...message, signature: randomBytes(64).toString("base64url") }),
        ),
      );
      assert.ok(results.every((response) => response.status === 403));
    }
    message.timestamp = Math.floor(Date.now() / 1000);
    message.signature = sign(
      null,
      Buffer.from(
        [
          "connector-v1",
          "heartbeat",
          message.connectorId,
          message.agentVersion,
          "1",
          String(message.timestamp),
          message.nonce,
        ].join("\n"),
      ),
      identity.privateKey,
    ).toString("base64url");
    assert.equal((await post(message)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
