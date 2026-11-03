import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { authSessionReferenceDeadline } from "../src/auth.js";
import { mysqlMcpGrantObservation } from "../src/mcp/mysql-grant-observation.js";
import { createMcpGrantAuthority } from "../src/mcp/grant-authority.js";
import { mcpFixture } from "./mcp-fixture.js";

test("receipt remains unknown after timeout and holds authorization locks until commit", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const observation = mysqlMcpGrantObservation(f.pool, authSessionReferenceDeadline, 300);
  const commitment = "a".repeat(64),
    bootId = randomUUID();
  const insert = async () => {
    const id = randomUUID();
    await f.pool.execute(
      "INSERT INTO mcp_invocation (id,ownerId,grantId,generation,commitment,bootId,tool,state,approvalSessionId,createdAt,expiresAt) VALUES (?,?,?,1,?,?,'change_propose','handoff_unknown',?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE))",
      [id, f.identity.ownerId, f.grant.id, commitment, bootId, f.identity.sessionId],
    );
    return {
      id,
      ownerId: f.identity.ownerId,
      grantId: f.grant.id,
      generation: 1,
      commitment,
      bootId,
      sessionId: f.identity.sessionId,
    };
  };
  const state = async (id: string) => {
    const [rows] = await f.pool.execute<RowDataPacket[]>(
      "SELECT state FROM mcp_invocation WHERE id=?",
      [id],
    );
    return rows[0]?.state;
  };
  const timedOut = await insert();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const written = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const attempt = observation.observe(tokenHash, async ({ acknowledgeHandoff }) => {
    assert.ok(acknowledgeHandoff);
    assert.equal(await acknowledgeHandoff(timedOut), true);
    reached();
    await gate;
    return true;
  });
  await written;
  await assert.rejects(attempt);
  release();
  for (let n = 0; n < 30; n++) {
    if ((await state(timedOut.id)) === "handoff_unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await state(timedOut.id), "handoff_unknown");
  const second = await insert();
  let unlock!: () => void;
  const hold = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let entered!: () => void;
  const hasLock = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = observation.observe(tokenHash, async ({ acknowledgeHandoff }) => {
    assert.ok(acknowledgeHandoff);
    assert.equal(await acknowledgeHandoff(second), true);
    entered();
    await hold;
    return true;
  });
  await hasLock;
  let revoked = false;
  const revoke = f.runtime.store.revoke(f.identity.ownerId, f.grant.id).then(() => {
    revoked = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(revoked, false);
  unlock();
  assert.equal(await commit, true);
  await revoke;
  assert.equal(await state(second.id), "handoff_unknown");
});

test("authorization expiry while the receipt row is locked leaves durable state unknown", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token();
  const id = randomUUID(),
    bootId = randomUUID(),
    commitment = "b".repeat(64);
  await f.pool.execute(
    "INSERT INTO mcp_invocation (id,ownerId,grantId,generation,commitment,bootId,tool,state,approvalSessionId,createdAt,expiresAt) VALUES (?,?,?,1,?,?,'change_propose','handoff_unknown',?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE))",
    [id, f.identity.ownerId, f.grant.id, commitment, bootId, f.identity.sessionId],
  );
  await f.pool.execute(
    "UPDATE mcp_grant SET expiresAt=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1200000 MICROSECOND) WHERE id=?",
    [f.grant.id],
  );
  const held = await f.pool.getConnection();
  await held.beginTransaction();
  await held.execute("SELECT id FROM mcp_invocation WHERE id=? FOR UPDATE", [id]);
  const observation = mysqlMcpGrantObservation(f.pool, authSessionReferenceDeadline, 3000);
  const issuer = `${f.origin}/api/auth`;
  const authority = createMcpGrantAuthority(observation, issuer, f.resource);
  const claims = {
    ownerId: f.identity.ownerId,
    clientId: f.client.clientId,
    issuer,
    audience: [f.resource],
    scopes: ["change:propose"],
    expiresAt: Date.now() + 60000,
  };
  let began!: () => void;
  const waiting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const attempt = authority(
    token,
    claims,
    async () => claims,
    async (_grant, check, signal, receipt) => {
      assert.ok(receipt);
      began();
      const matched = await receipt({
        ownerId: f.identity.ownerId,
        id,
        grantId: f.grant.id,
        generation: 1,
        commitment,
        bootId,
        sessionId: f.identity.sessionId,
      });
      assert.equal(matched, true);
      signal.throwIfAborted();
      check();
    },
  );
  const rejected = assert.rejects(attempt);
  await waiting;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await held.commit();
  held.release();
  await rejected;
  const [rows] = await f.pool.execute<RowDataPacket[]>(
    "SELECT state FROM mcp_invocation WHERE id=?",
    [id],
  );
  assert.equal(rows[0]?.state, "handoff_unknown");
});
