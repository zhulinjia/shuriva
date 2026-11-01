import { testSessions, testSessionId } from "./session-fixture.js";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { ConnectorError } from "../src/connectors/public.js";
import {
  ConnectorRegistry,
  canonicalPair,
  canonicalPairProof,
  canonicalSigned,
  type HeartbeatInput,
  type PairInput,
  type RotateInput,
} from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import { scanHooks } from "../src/datasources/scan.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { type ReadResult, readResultFields } from "../src/protocol/read-task.js";
import { ReadService } from "../src/queries/service.js";

function key() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(-32).toString("base64url") };
}
function signature(privateKey: KeyObject, fields: string[]) {
  return sign(null, Buffer.from(fields.join("\n")), privateKey).toString("base64url");
}
function pairInput(pairingId: string, secret: string, identity: ReturnType<typeof key>): PairInput {
  const input: PairInput = {
    pairingId,
    proof: "",
    connectorId: randomUUID(),
    name: "fixture",
    publicKey: identity.publicKey,
    agentVersion: "test",
    protocol: 2,
    signature: "",
  };
  input.proof = createHmac("sha256", createHash("sha256").update(secret).digest())
    .update(canonicalPairProof(input).join("\n"))
    .digest("base64url");
  input.signature = signature(identity.privateKey, canonicalPair(input));
  return input;
}
function heartbeat(connectorId: string, identity: ReturnType<typeof key>): HeartbeatInput {
  const input: HeartbeatInput = {
    connectorId,
    agentVersion: "test",
    protocol: 1,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(32).toString("base64url"),
    signature: "",
  };
  input.signature = signature(identity.privateKey, [
    "connector-v1",
    "heartbeat",
    connectorId,
    input.agentVersion,
    "1",
    String(input.timestamp),
    input.nonce,
  ]);
  return input;
}
function rotation(
  connectorId: string,
  old: ReturnType<typeof key>,
  next: ReturnType<typeof key>,
): RotateInput {
  const input: RotateInput = {
    connectorId,
    newPublicKey: next.publicKey,
    agentVersion: "test",
    protocol: 1,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(32).toString("base64url"),
    signature: "",
  };
  input.signature = signature(old.privateKey, [
    "connector-v1",
    "rotate",
    connectorId,
    next.publicKey,
    input.agentVersion,
    "1",
    String(input.timestamp),
    input.nonce,
  ]);
  return input;
}
test("pairing is single use and ownership, signatures, replay, rotation and revocation survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-registry-"));
  const path = join(dir, "state.json");
  const secret = randomBytes(32).toString("hex");
  let registry = await ConnectorRegistry.open(path, secret);
  try {
    const offer = await registry.createPairing("owner");
    const identity = key();
    const input = pairInput(offer.pairingId, offer.secret, identity);
    await assert.rejects(() => registry.pair({ ...input, name: "tampered" }), ConnectorError);
    const otherIdentity = key();
    const stolenProof = { ...input, connectorId: randomUUID(), publicKey: otherIdentity.publicKey };
    stolenProof.signature = signature(otherIdentity.privateKey, canonicalPair(stolenProof));
    await assert.rejects(() => registry.pair(stolenProof), ConnectorError);
    const results = await Promise.allSettled([registry.pair(input), registry.pair(input)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await registry.list("owner")).length, 1);
    assert.equal((await registry.list("other")).length, 0);
    const check = heartbeat(input.connectorId, identity);
    check.signature = signature(identity.privateKey, canonicalSigned("probe", check));
    await registry.probe(check);
    assert.equal((await registry.list("owner"))[0]?.status, "offline");
    await assert.rejects(() => registry.probe(check), ConnectorError);
    const saved = await readFile(path, "utf8");
    assert.ok(!saved.includes(offer.secret));
    const beat = heartbeat(input.connectorId, identity);
    await registry.heartbeat(beat);
    await assert.rejects(() => registry.heartbeat(beat), ConnectorError);
    await assert.rejects(
      () => registry.heartbeat({ ...heartbeat(input.connectorId, identity), timestamp: 1 }),
      ConnectorError,
    );
    const forged = { ...heartbeat(input.connectorId, identity), protocol: 2 };
    await assert.rejects(() => registry.heartbeat(forged), ConnectorError);
    assert.equal((await registry.list("owner"))[0]?.status, "online");
    const incompatible = heartbeat(input.connectorId, identity);
    incompatible.protocol = 2;
    incompatible.signature = signature(identity.privateKey, [
      "connector-v1",
      "heartbeat",
      incompatible.connectorId,
      incompatible.agentVersion,
      "2",
      String(incompatible.timestamp),
      incompatible.nonce,
    ]);
    await assert.rejects(
      () => registry.heartbeat(incompatible),
      (e: unknown) => e instanceof ConnectorError && e.code === "INCOMPATIBLE",
    );
    assert.equal((await registry.list("owner"))[0]?.status, "incompatible");
    await registry.heartbeat(heartbeat(input.connectorId, identity));
    assert.equal((await registry.list("owner"))[0]?.status, "online");
    await assert.rejects(
      () => registry.createDiagnostic("other", input.connectorId),
      ConnectorError,
    );
    await registry.createDiagnostic("owner", input.connectorId);
    const task = await registry.heartbeat(heartbeat(input.connectorId, identity));
    assert.ok(task);
    const result = {
      connectorId: input.connectorId,
      taskId: task.id,
      outcome: "ok" as const,
      agentVersion: "test",
      protocol: 1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    result.signature = signature(identity.privateKey, [
      "connector-v1",
      "result",
      result.connectorId,
      result.taskId,
      result.outcome,
      result.agentVersion,
      "1",
      String(result.timestamp),
      result.nonce,
    ]);
    await registry.completeDiagnostic(result);
    assert.equal((await registry.list("owner"))[0]?.diagnosticStatus, "completed");
    await assert.rejects(() => registry.completeDiagnostic(result), ConnectorError);
    await assert.rejects(
      () => registry.completeDiagnostic({ ...result, taskId: randomUUID() }),
      ConnectorError,
    );
    const next = key();
    const change = rotation(input.connectorId, identity, next);
    await registry.rotate(change);
    await assert.rejects(
      () => registry.heartbeat(heartbeat(input.connectorId, identity)),
      ConnectorError,
    );
    const afterRotation = heartbeat(input.connectorId, next);
    await registry.heartbeat(afterRotation);
    await registry.close();
    registry = await ConnectorRegistry.open(path, secret);
    await assert.rejects(() => registry.heartbeat(afterRotation), ConnectorError);
    await assert.rejects(() => registry.revoke("other", input.connectorId), ConnectorError);
    await registry.revoke("owner", input.connectorId);
    assert.equal((await registry.list("owner"))[0]?.status, "revoked");
    await assert.rejects(
      () => registry.createDiagnostic("owner", input.connectorId),
      ConnectorError,
    );
    await assert.rejects(() => registry.completeDiagnostic(result), ConnectorError);
    await assert.rejects(
      () => registry.heartbeat(heartbeat(input.connectorId, next)),
      ConnectorError,
    );
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("state corruption and an active lock fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-integrity-"));
  const path = join(dir, "state.json");
  const secret = randomBytes(32).toString("hex");
  const registry = await ConnectorRegistry.open(path, secret);
  try {
    await assert.rejects(() => ConnectorRegistry.open(path, secret), /already in use/);
  } finally {
    await registry.close();
  }
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.state.version = 9;
    const tamperedContent = JSON.stringify(saved);
    await writeFile(path, tamperedContent);
    await assert.rejects(() => ConnectorRegistry.open(path, secret), /integrity/);
    assert.equal(await readFile(path, "utf8"), tamperedContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("expired pairing codes are rejected and heartbeat status becomes offline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const dir = await mkdtemp(join(tmpdir(), "connector-expiry-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  try {
    const stale = await registry.createPairing("owner");
    const identity = key();
    t.mock.timers.tick(300_001);
    await assert.rejects(
      () => registry.pair(pairInput(stale.pairingId, stale.secret, identity)),
      ConnectorError,
    );
    const valid = await registry.createPairing("owner");
    const item = pairInput(valid.pairingId, valid.secret, identity);
    await registry.pair(item);
    assert.equal((await registry.list("owner"))[0]?.status, "offline");
    assert.equal((await registry.list("owner"))[0]?.lastSeenAt, null);
    const next = key();
    await registry.rotate(rotation(item.connectorId, identity, next));
    assert.equal((await registry.list("owner"))[0]?.status, "offline");
    await registry.heartbeat(heartbeat(item.connectorId, next));
    assert.equal((await registry.list("owner"))[0]?.status, "online");
    t.mock.timers.tick(44_000);
    const rotated = key();
    await registry.rotate(rotation(item.connectorId, next, rotated));
    t.mock.timers.tick(1_001);
    assert.equal((await registry.list("owner"))[0]?.status, "offline");
    await registry.heartbeat(heartbeat(item.connectorId, rotated));
    assert.equal((await registry.list("owner"))[0]?.status, "online");
    await registry.createDiagnostic("owner", item.connectorId);
    t.mock.timers.tick(60_001);
    assert.equal((await registry.list("owner"))[0]?.diagnosticStatus, "expired");
    assert.equal(await registry.heartbeat(heartbeat(item.connectorId, rotated)), null);
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("pairing verification keys are encrypted and tampering fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-pairing-encryption-"));
  const path = join(dir, "state.json");
  const secret = randomBytes(32).toString("hex");
  let registry = await ConnectorRegistry.open(path, secret);
  try {
    const offer = await registry.createPairing("owner");
    const hash = createHash("sha256").update(offer.secret).digest("hex");
    const saved = await readFile(path, "utf8");
    assert.ok(!saved.includes(offer.secret) && !saved.includes(hash));
    await registry.close();
    registry = await ConnectorRegistry.open(path, secret);
    const input = pairInput(offer.pairingId, offer.secret, key());
    await registry.pair(input);
    const next = await registry.createPairing("owner");
    await registry.close();
    const corrupt = JSON.parse(await readFile(path, "utf8"));
    const encrypted = Buffer.from(corrupt.state.pairings[0].encryptedKey, "base64url");
    encrypted[encrypted.length - 1] ^= 1;
    corrupt.state.pairings[0].encryptedKey = encrypted.toString("base64url");
    const macKey = createHmac("sha256", secret).update("connector-registry-v1").digest();
    corrupt.mac = createHmac("sha256", macKey).update(JSON.stringify(corrupt.state)).digest("hex");
    const damaged = JSON.stringify(corrupt);
    await writeFile(path, damaged);
    await assert.rejects(() => ConnectorRegistry.open(path, secret), /integrity/);
    assert.equal(await readFile(path, "utf8"), damaged);
    assert.ok(next.pairingId);
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("credential vault failure does not leave a registry lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-vault-error-"));
  const path = join(dir, "state.json");
  try {
    await assert.rejects(
      () =>
        ConnectorRegistry.open(path, () => {
          throw new Error("vault unavailable");
        }),
      /vault unavailable/,
    );
    const registry = await ConnectorRegistry.open(path, randomBytes(32).toString("hex"));
    await registry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one slow scan serializes its own revocation without blocking other connectors", {
  timeout: 10_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-scan-order-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const identities = [key(), key()];
    const inputs: PairInput[] = [];
    for (const identity of identities) {
      const offer = await registry.createPairing("owner");
      const input = pairInput(offer.pairingId, offer.secret, identity);
      await registry.pair(input);
      inputs.push(input);
    }
    const first = inputs[0];
    const second = inputs[1];
    const firstIdentity = identities[0];
    const secondIdentity = identities[1];
    assert.ok(first && second && firstIdentity && secondIdentity);
    const result = {
      connectorId: first.connectorId,
      taskId: randomUUID(),
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
      outcome: "failed" as const,
      payload: "scope",
      agentVersion: "test",
      protocol: 2,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    result.signature = signature(firstIdentity.privateKey, [
      "connector-v2",
      "scan-result",
      result.connectorId,
      result.taskId,
      result.workspaceId,
      result.sourceId,
      result.outcome,
      createHash("sha256").update(result.payload).digest("hex"),
      result.agentVersion,
      "2",
      String(result.timestamp),
      result.nonce,
    ]);
    const publication = registry.verifySchemaResult(result, async () => {
      started();
      await gate;
    });
    await entered;
    const forged = { ...result, signature: randomBytes(64).toString("base64url") };
    await Promise.race([
      assert.rejects(() => registry.verifySchemaResult(forged, async () => {}), ConnectorError),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("forged request entered connector queue")),
          2_000,
        ).unref(),
      ),
    ]);
    let revoked = false;
    const revocation = registry.revoke("owner", first.connectorId).then(() => {
      revoked = true;
    });
    await Promise.race([
      registry.heartbeat(heartbeat(second.connectorId, secondIdentity)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("unrelated heartbeat blocked")), 2_000).unref(),
      ),
    ]);
    assert.equal(revoked, false, "revocation must wait for this connector's publication");
    release();
    await publication;
    await revocation;
    await assert.rejects(() => registry.verifySchemaResult(result, async () => {}), ConnectorError);
  } finally {
    release();
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled scan returns 409 only after authenticating the connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-task-gone-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  const app = express();
  const store = { authorizedScan: async () => null } as unknown as DataSourceStore;
  mountConnectorRoutes(
    app,
    registry,
    "http://localhost:5173",
    async () => undefined,
    scanHooks(store, registry),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    const identity = key();
    const offer = await registry.createPairing("owner");
    const input = pairInput(offer.pairingId, offer.secret, identity);
    await registry.pair(input);
    const result = {
      connectorId: input.connectorId,
      taskId: randomUUID(),
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
      outcome: "failed" as const,
      payload: "scope",
      agentVersion: "test",
      protocol: 2,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    result.signature = signature(identity.privateKey, [
      "connector-v2",
      "scan-result",
      result.connectorId,
      result.taskId,
      result.workspaceId,
      result.sourceId,
      result.outcome,
      createHash("sha256").update(result.payload).digest("hex"),
      result.agentVersion,
      "2",
      String(result.timestamp),
      result.nonce,
    ]);
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/connector-agent/scan-result`;
    const send = (body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await send({ ...result, signature: randomBytes(64).toString("base64url") })).status,
      403,
    );
    assert.equal((await send(result)).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("read task and result require matching active owner, signatures and fresh nonce", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-read-contract-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  try {
    const identity = key();
    const offer = await registry.createPairing("owner");
    const input = pairInput(offer.pairingId, offer.secret, identity);
    await registry.pair(input);
    const now = Math.floor(Date.now() / 1000);
    const task = {
      id: randomUUID(),
      connectorId: input.connectorId,
      actorId: "owner",
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
      operation: "read_query" as const,
      payload: Buffer.from('{"sql":"SELECT id FROM t","parameters":[],"maxRows":1}').toString(
        "base64url",
      ),
      issuedAt: now,
      expiresAt: now + 60,
      nonce: randomBytes(32).toString("base64url"),
      protocol: 1 as const,
    };
    const signed = await registry.issueReadTask(task);
    assert.ok(signed.signature);
    await assert.rejects(
      () => registry.issueReadTask({ ...task, actorId: "other" }),
      ConnectorError,
    );
    const result: ReadResult = {
      taskId: task.id,
      connectorId: task.connectorId,
      actorId: task.actorId,
      workspaceId: task.workspaceId,
      sourceId: task.sourceId,
      taskNonce: task.nonce,
      outcome: "failed",
      payload: "denied",
      timestamp: now,
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    result.signature = signature(identity.privateKey, readResultFields(result));
    let committed = 0;
    await registry.verifyReadResult(result, async () => {
      committed++;
    });
    assert.equal(committed, 1);
    await assert.rejects(
      () =>
        registry.verifyReadResult(result, async () => {
          committed++;
        }),
      ConnectorError,
    );
    const changed = {
      ...result,
      nonce: randomBytes(32).toString("base64url"),
      sourceId: randomUUID(),
    };
    await assert.rejects(
      () =>
        registry.verifyReadResult(changed, async () => {
          committed++;
        }),
      ConnectorError,
    );
    assert.equal(committed, 1);
    await registry.revoke("owner", input.connectorId);
    await assert.rejects(() => registry.issueReadTask(task), ConnectorError);
  } finally {
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("connector revocation is serialized with access to read results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-read-revoke-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  let release = () => {};
  try {
    const identity = key();
    const offer = await registry.createPairing("owner");
    const input = pairInput(offer.pairingId, offer.secret, identity);
    await registry.pair(input);
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access = registry.withActiveOwner("owner", input.connectorId, async () => {
      ready();
      await proceed;
      return "read";
    });
    await entered;
    let revoked = false;
    const revocation = registry.revoke("owner", input.connectorId).then(() => {
      revoked = true;
    });
    await Promise.resolve();
    assert.equal(revoked, false);
    release();
    assert.equal(await access, "read");
    await revocation;
    assert.equal(
      await registry.withActiveOwner("owner", input.connectorId, () => "leak"),
      undefined,
    );
  } finally {
    release();
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a signed result retry is acknowledged once without replacing the original result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-read-retry-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "state.json"),
    randomBytes(32).toString("hex"),
  );
  let service: ReadService | undefined;
  try {
    const identity = key();
    const offer = await registry.createPairing("owner");
    const input = pairInput(offer.pairingId, offer.secret, identity);
    await registry.pair(input);
    const scope = {
      sessionId: testSessionId,
      ownerId: "owner",
      connectorId: input.connectorId,
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
    };
    const store = {
      boundSource: async () => ({ connectorId: scope.connectorId }),
    } as unknown as DataSourceStore;
    service = new ReadService(store, registry, testSessions);
    const reader = service;
    const id = reader.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    const dispatched = reader.jobs.claim(scope.connectorId);
    assert.ok(dispatched?.type === "read");
    const result: ReadResult = {
      taskId: id,
      connectorId: scope.connectorId,
      actorId: scope.ownerId,
      workspaceId: scope.workspaceId,
      sourceId: scope.sourceId,
      taskNonce: dispatched.task.nonce,
      outcome: "failed",
      payload: "denied",
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
      signature: "",
    };
    result.signature = signature(identity.privateKey, readResultFields(result));
    assert.ok(await reader.result(result));
    await assert.rejects(() => reader.result(result), ConnectorError);
    const retry = {
      ...result,
      nonce: randomBytes(32).toString("base64url"),
      payload: "error",
      signature: "",
    };
    retry.signature = signature(identity.privateKey, readResultFields(retry));
    assert.ok(await reader.result(retry));
    assert.deepEqual(reader.jobs.status(scope, id), { state: "failed", payload: "denied" });
    await registry.revoke("owner", scope.connectorId);
    const revoked = { ...retry, nonce: randomBytes(32).toString("base64url"), signature: "" };
    revoked.signature = signature(identity.privateKey, readResultFields(revoked));
    await assert.rejects(() => reader.result(revoked), ConnectorError);
  } finally {
    service?.close();
    await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
