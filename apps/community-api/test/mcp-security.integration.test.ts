import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { mcpFixture } from "./mcp-fixture.js";
import { authMutationIdentity } from "../src/auth.js";
import { verifyMcpSchema } from "../src/mcp/migration.js";
import { grantInput } from "../src/mcp/model.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const enabled = process.env.STAGE9_G3_TEST === "1";
async function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}

test("final publication locks grant revocation and the distinct query approval session", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers);
  const signed = await f.auth.api.signInUsername({
    body: { username: f.username, password: f.password },
    returnHeaders: true,
  });
  const cookie = signed.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
    approver = await authMutationIdentity(f.auth)({ cookie });
  assert.ok(approver);
  const id = randomUUID();
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const review = await f.runtime.invocations.review(approver, id);
  await f.runtime.invocations.approve(approver, id, String(review.commitment), true);
  const entered = await barrier(),
    finish = await barrier();
  const publication = f.runtime.invocations.publish(
    subject,
    headers,
    "operation:read",
    id,
    async () => {
      entered.release();
      await finish.wait;
    },
    "operation_status",
  );
  await entered.wait;
  let revoked = false,
    loggedOut = false;
  const revoke = f.runtime.store.revoke(f.identity.ownerId, f.grant.id).then(() => {
    revoked = true;
  });
  const logout = f.auth.api.signOut({ headers: new Headers({ cookie }) }).then(() => {
    loggedOut = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(revoked, false);
  assert.equal(loggedOut, false);
  finish.release();
  await publication;
  await Promise.all([revoke, logout]);
  await assert.rejects(() =>
    f.runtime.invocations.publish(
      subject,
      headers,
      "operation:read",
      id,
      async () => assert.fail("revoked publication"),
      "operation_status",
    ),
  );
});

test("failed source requests cannot disable an otherwise valid bearer", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token();
  for (let i = 0; i < 40; i++)
    await fetch(f.resource, {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: "{}",
    });
  const client = new Client(
    { name: "valid-after-failures", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  assert.ok((await client.listTools()).tools.some((t) => t.name === "query_prepare"));
});
const answer = Buffer.from(
  JSON.stringify({
    columns: [{ name: "id", type: "int" }],
    rows: [[{ null: false, encoding: "text", value: "1" }]],
    timezone: "UTC",
    truncated: false,
  }),
).toString("base64url");
test("external request UUID cannot read or cancel an ordinary job, before or after approval", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  f.reads.jobs.create(
    { ...f.binding, sessionId: f.identity.sessionId },
    id,
    "SELECT id FROM customers",
    [],
    10,
  );
  const ordinary = f.reads.jobs.claim(f.binding.connectorId);
  assert.ok(ordinary?.type === "read");
  f.reads.jobs.complete(f.binding, id, "ok", answer);
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const status = await f.runtime.invocations.status(subject, id);
  assert.equal(status.resultAvailable, false);
  assert.equal("result" in status, false);
  await f.runtime.invocations.cancel(subject, id);
  assert.equal(f.reads.jobs.status(f.binding, id)?.state, "completed");
});
test("result disclosure rechecks individual query approval session and preserves its reference", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  const signed = await f.auth.api.signInUsername({
    body: { username: f.username, password: f.password },
    returnHeaders: true,
  });
  const cookie = signed.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  const approving = await authMutationIdentity(f.auth)({ cookie });
  assert.ok(approving);
  assert.notEqual(approving.sessionId, f.identity.sessionId);
  await f.runtime.invocations.prepare(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  });
  const review = await f.runtime.invocations.review(approving, id);
  await f.runtime.invocations.approve(approving, id, String(review.commitment), true);
  const row = await f.runtime.store.invocation(f.identity.ownerId, id);
  assert.ok(row?.taskId);
  assert.notEqual(row.taskId, id);
  const task = f.reads.jobs.claim(f.binding.connectorId);
  assert.ok(task?.type === "read");
  f.reads.jobs.complete(f.binding, String(row.taskId), "ok", answer);
  assert.equal((await f.runtime.invocations.status(subject, id)).resultAvailable, true);
  assert.equal(
    (await f.runtime.store.invocation(f.identity.ownerId, id))?.approvalSessionId,
    approving.sessionId,
  );
  await f.auth.api.signOut({ headers: new Headers({ cookie }) });
  assert.ok(await f.runtime.oauth.verify(headers));
  // Preparation may report an already-known terminal fact without retaining
  // result data. Actual disclosure must still reject the deleted approver.
  const hidden = await f.runtime.invocations.status(subject, id);
  assert.equal(hidden.resultAvailable, false);
  assert.equal("result" in hidden, false);
  let sent = false;
  await assert.rejects(() =>
    f.runtime.invocations.publish(
      subject,
      headers,
      "operation:read",
      id,
      async () => {
        sent = true;
      },
      "operation_status",
      randomUUID(),
      hidden,
    ),
  );
  assert.equal(sent, false);
});
test("late cancellation preserves completion, unknown stays unknown, payload limits reject before approval", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` },
    subject = await f.runtime.oauth.verify(headers);
  const query = {
    requestId: randomUUID(),
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    sql: "SELECT id FROM customers",
    parameters: [],
    maxRows: 10,
    schemaVersion: null,
  };
  await assert.rejects(() =>
    f.runtime.invocations.prepare(subject, headers, {
      ...query,
      requestId: "019a4130-0000-7000-8000-000000000000",
    }),
  );
  await assert.rejects(
    () =>
      f.runtime.invocations.prepare(subject, headers, {
        ...query,
        parameters: [{ kind: "string", value: "数".repeat(4096) }],
      }),
    /MCP_PLAN_INVALID/,
  );
  for (const outcome of ["ok", "failed"] as const) {
    const id = randomUUID();
    await f.runtime.invocations.prepare(subject, headers, { ...query, requestId: id });
    const review = await f.runtime.invocations.review(f.identity, id);
    await f.runtime.invocations.approve(f.identity, id, String(review.commitment), true);
    const row = await f.runtime.store.invocation(f.identity.ownerId, id);
    assert.ok(row);
    f.reads.jobs.claim(f.binding.connectorId);
    f.reads.jobs.complete(
      f.binding,
      String(row.taskId),
      outcome,
      outcome === "ok" ? answer : "outcome_unknown",
    );
    if (outcome === "ok")
      assert.equal((await f.runtime.invocations.cancel(subject, id)).state, "completed");
    else assert.equal((await f.runtime.invocations.status(subject, id)).state, "outcome_unknown");
  }
});
test("MCP migration rejects foreign-key drift and local-domain registration is atomic", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  await f.pool.query("ALTER TABLE mcp_grant_token DROP FOREIGN KEY mcp_grant_token_grant");
  await assert.rejects(() => verifyMcpSchema(f.pool), /MCP_SCHEMA_NOT_CURRENT/);
  const candidates = [1, 2].map(() =>
    f.runtime.store.registerClient(f.identity.ownerId, {
      clientId: randomBytes(16).toString("hex"),
      name: "synthetic local",
      redirectUri: "http://127.0.0.1:19492/callback",
      mode: "local_domain",
    }),
  );
  const results = await Promise.allSettled(candidates);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const [rows] = await f.pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM mcp_local_domain",
  );
  assert.equal(Number(rows[0]?.count), 1);
});
test("revoked/expired metadata does not permanently consume new grant admission", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  for (let i = 0; i < 101; i++)
    await f.runtime.store.createGrant(
      f.identity.ownerId,
      f.identity.sessionId,
      grantInput.parse({ ...f.scope, tables: [["customers", ["id"]]], durationMinutes: 5 }),
      f.binding.connectorId,
      f.resource,
    );
  assert.ok((await f.runtime.store.grants(f.identity.ownerId)).some((g) => !g.revoked));
});
