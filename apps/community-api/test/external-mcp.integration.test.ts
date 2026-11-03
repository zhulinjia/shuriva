import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { externalFixture } from "./external-mcp-fixture.js";
import type { ExternalMcpService } from "../src/mcp-client/service.js";
const enabled = process.env.STAGE9_G4_TEST === "1";
test("revocation uses a live owner and session without relying on historical snapshot", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const events: string[] = [];
  const f = await externalFixture(async (_owner, event) => {
    events.push(event);
  });
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Revocation",
    config: f.httpConfig,
  });
  const approvals = [{ name: "historical", hash: "a".repeat(64), sessionId: f.identity.sessionId }];
  await f.pool.execute("UPDATE external_mcp_connection SET approvedTools=? WHERE id=?", [
    JSON.stringify(approvals),
    id,
  ]);
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(c.snapshotHash, null);
  await assert.rejects(
    f.service.approve(c, { ...f.identity, sessionId: randomUUID() }, "", []),
    /SESSION_EXPIRED/,
  );
  assert.equal(
    (await f.service.connection(f.identity, f.binding.workspaceId, id)).approvedTools.length,
    1,
  );
  await assert.rejects(
    f.service.store.revokeTools(randomUUID(), id, c.version, f.identity),
    /NOT_FOUND/,
  );
  await f.service.approve(c, f.identity, "untrusted historical hash", []);
  const updated = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.deepEqual(updated.approvedTools, []);
  assert.equal(updated.snapshotHash, null);
  assert.ok(events.includes("tool_approval_revocation_requested"));
  assert.equal(f.stats().calls, 0);
});
test("G5 unavailable tools cannot be approved or invoked and their changes invalidate other approvals", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture(undefined, undefined, undefined, true);
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Mixed schemas",
    config: f.httpConfig,
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const unsupported = c.snapshot.find((tool) => tool.name === "unsupported_uri");
  assert.ok(unsupported);
  assert.equal(unsupported?.status, "unsupported");
  assert.equal(c.snapshot.find((tool) => tool.name === "echo")?.status, "available");
  const hash = c.snapshotHash ?? assert.fail("Missing snapshot");
  await assert.rejects(
    f.service.approve(c, f.identity, hash, ["unsupported_uri"]),
    /SNAPSHOT_CHANGED/,
  );
  await assert.rejects(
    f.service.invocations.prepare(
      {
        ...c,
        approvedTools: [
          { name: "unsupported_uri", hash: unsupported.hash, sessionId: f.identity.sessionId },
        ],
      },
      f.identity,
      "unsupported_uri",
      {},
    ),
    /TOOL_NOT_APPROVED/,
  );
  await f.service.approve(c, f.identity, hash, ["echo"]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const prepared = await f.service.invocations.prepare(c, f.identity, "echo", { text: "stale" });
  f.changeUnsupported();
  await f.service.invocations.confirm(c, f.identity, prepared.id);
  const rejected = await terminal(f.service, c, f.identity, prepared.id);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.error, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
  assert.equal(f.stats().calls, 0);
  const updated = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.notEqual(updated.snapshotHash, hash);
  assert.deepEqual(updated.approvedTools, []);
});
async function terminal(
  service: ExternalMcpService,
  c: Parameters<ExternalMcpService["invocations"]["history"]>[0],
  who: Parameters<ExternalMcpService["invocations"]["history"]>[1],
  id: string,
) {
  for (let i = 0; i < 120; i++) {
    const row = (await service.invocations.history(c, who)).find((r) => r.id === id);
    if (row && !["pending_approval", "running", "cancel_requested"].includes(row.state)) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("call did not settle");
}
test("G4 real HTTP: discovering/approving never calls; exact call approval, result isolation, one-shot and no sensitive persistence", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const saved = await f.request(f.base, { name: "Synthetic external", config: f.httpConfig });
  assert.equal(saved.status, 201, await saved.clone().text());
  const { id } = await saved.json();
  const path = `${f.base}/${id}`;
  assert.equal(f.stats().calls, 0);
  const d = await f.request(`${path}/discover`, {});
  assert.equal(d.status, 200, await d.clone().text());
  assert.equal(f.stats().calls, 0);
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(c.snapshot[0]?.name, "echo");
  await assert.rejects(
    f.service.invocations.prepare(c, f.identity, "echo", { text: "synthetic-private" }),
    /TOOL_NOT_APPROVED/,
  );
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("Missing tool snapshot"), [
    "echo",
  ]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const prepared = await f.request(`${path}/calls`, {
    tool: "echo",
    arguments: { text: '<img src="https://unapproved.invalid">' },
  });
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const call = await prepared.json();
  assert.equal(f.stats().calls, 0);
  const review = await f.request(`${path}/calls/${call.id}/review`);
  assert.equal(review.status, 200, await review.clone().text());
  assert.equal((await review.json()).arguments.text, '<img src="https://unapproved.invalid">');
  const other = { ...f.identity, sessionId: randomUUID() };
  await assert.rejects(f.service.invocations.confirm(c, other, call.id), /NOT_FOUND/);
  const confirmations = await Promise.all([
    f.request(`${path}/calls/${call.id}/confirm`, {}),
    f.request(`${path}/calls/${call.id}/confirm`, {}),
  ]);
  assert.deepEqual(confirmations.map((r) => r.status).sort(), [202, 409]);
  const settled = await terminal(f.service, c, f.identity, call.id);
  assert.equal(settled.state, "succeeded", JSON.stringify(settled));
  assert.equal(f.stats().calls, 1);
  const result = await f.request(`${path}/calls/${call.id}/result`);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).untrusted, true);
  const [rows] = await f.pool.query("SELECT * FROM external_mcp_call");
  assert.equal(JSON.stringify(rows).includes("unapproved.invalid"), false);
  await f.service.approve(
    c,
    f.identity,
    c.snapshotHash ?? assert.fail("Missing tool snapshot"),
    [],
  );
  const denied = await f.request(`${path}/calls/${call.id}/result`);
  assert.equal(denied.status, 410);
});
test("G4 snapshot mutation, workspace/CSRF/session rejection, cancellation and unknown acknowledgment never replay", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "External",
    config: f.httpConfig,
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("Missing tool snapshot"), [
    "echo",
  ]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const q = await f.service.invocations.prepare(c, f.identity, "echo", { text: "changed" });
  f.change();
  await f.service.invocations.confirm(c, f.identity, q.id);
  const changed = await terminal(f.service, c, f.identity, q.id);
  assert.equal(changed.state, "failed");
  assert.equal(changed.error, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
  assert.equal(f.stats().calls, 0);
  await assert.rejects(f.service.connection(f.identity, randomUUID(), id), /NOT_FOUND/);
  assert.equal(
    (await f.request(`${f.base}/${id}/discover`, {}, { origin: "https://unapproved.invalid" }))
      .status,
    403,
  );
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("Missing tool snapshot"), [
    "echo",
  ]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  f.delay(3000);
  const slow = await f.service.invocations.prepare(c, f.identity, "echo", { text: "slow" });
  await f.service.invocations.confirm(c, f.identity, slow.id);
  for (let i = 0; i < 60 && f.stats().calls === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.stats().calls, 1);
  await f.service.invocations.cancel(c, f.identity, slow.id);
  assert.equal((await terminal(f.service, c, f.identity, slow.id)).state, "outcome_unknown");
  await assert.rejects(f.service.invocations.prepare(c, f.identity, "echo", { text: "duplicate" }));
  await f.service.invocations.acknowledge(c, f.identity, slow.id);
  assert.equal(f.stats().calls, 1);
  // Recovery still observes the normal 10/minute, burst-two discovery limit.
  await new Promise((resolve) => setTimeout(resolve, 6100));
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const next = await f.service.invocations.prepare(c, f.identity, "echo", { text: "later" });
  await f.service.invocations.cancel(c, f.identity, next.id);
  assert.equal(f.stats().calls, 1);
  await f.pool.execute("UPDATE session SET expiresAt=UTC_TIMESTAMP(3) WHERE id=?", [
    f.identity.sessionId,
  ]);
  await assert.rejects(
    f.service.connection(f.identity, f.binding.workspaceId, id),
    /SESSION_EXPIRED/,
  );
});
