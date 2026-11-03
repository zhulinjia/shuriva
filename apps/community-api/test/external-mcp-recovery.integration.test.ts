import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { test } from "node:test";
import { externalFixture } from "./external-mcp-fixture.js";
import { RuntimeOwnership } from "../src/mcp-client/ownership.js";
import { ExternalMcpError } from "../src/mcp-client/model.js";
const enabled = process.env.STAGE9_G4_TEST === "1";
test("G4 expired or removed credential staging cannot create a successful connection", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const seed = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Staging fixture",
    config: f.httpConfig,
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, seed.id);
  for (const mode of ["expired", "removed"]) {
    const ref = randomUUID(),
      id = randomUUID();
    await f.service.store.stageCredential(c.ownerId, ref, c.executionHostId);
    if (mode === "expired")
      await f.pool.execute(
        "UPDATE external_mcp_secret_gc SET notBefore=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE ref=?",
        [ref],
      );
    else await f.pool.execute("DELETE FROM external_mcp_secret_gc WHERE ref=?", [ref]);
    await assert.rejects(
      f.service.store.create(
        c.ownerId,
        c.workspaceId,
        "Must reject",
        c.config,
        c.executionHostId,
        id,
        ref,
      ),
      /CREDENTIAL_STAGE_EXPIRED/,
    );
    await assert.rejects(f.service.store.connection(c.ownerId, id), /NOT_FOUND/);
  }
});
test("G4 credential GC removes proven-empty retired refs and isolates one vault error", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const bad = randomUUID();
  const has = (ref: string) => {
    if (ref === bad) throw new ExternalMcpError("EXTERNAL_MCP_VAULT_UNAVAILABLE", 503);
    return false;
  };
  const f = await externalFixture(undefined, undefined, (v) => ({ ...v, has }));
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Cleanup isolation",
    config: f.httpConfig,
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const refs = [bad, randomUUID(), randomUUID()];
  for (const ref of refs)
    await f.pool.execute(
      "INSERT INTO external_mcp_secret_gc(ref,ownerId,executionHostId,connectionId,notBefore) VALUES(?,?,?,?,UTC_TIMESTAMP(3))",
      [ref, c.ownerId, c.executionHostId, c.id],
    );
  await assert.rejects(
    f.service.store.cleanupCredentials(
      c.executionHostId,
      () => assert.fail("absent records need no deletion"),
      has,
    ),
    /VAULT_UNAVAILABLE/,
  );
  const [rows] = await f.pool.query("SELECT ref FROM external_mcp_secret_gc");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ ref: bad }]);
});
test("G4 failed credential publication preserves the previous credential without falling back", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  let fail = false;
  const f = await externalFixture(undefined, undefined, (v) => ({
    ...v,
    set: (ref, value) => {
      if (fail) throw new ExternalMcpError("EXTERNAL_MCP_VAULT_UNAVAILABLE", 503);
      v.set(ref, value);
    },
  }));
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Publication failure",
    config: { ...f.httpConfig, authentication: "bearer" },
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.credentials(c, f.identity, { bearer: "synthetic-retained" });
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const previous = c.credentialRef;
  fail = true;
  await assert.rejects(
    f.service.credentials(c, f.identity, { bearer: "synthetic-failed" }),
    /VAULT_UNAVAILABLE/,
  );
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(f.hasCredential(c.credentialRef), false);
  const deleted: string[] = [];
  await f.service.store.cleanupCredentials(
    c.executionHostId,
    (r) => deleted.push(r),
    f.hasCredential,
  );
  assert.equal(deleted.includes(previous), false);
  assert.equal(f.hasCredential(previous), true);
  await assert.rejects(f.service.discover(c, f.identity), /CREDENTIAL_REQUIRED/);
  assert.equal(f.stats().calls, 0);
  fail = false;
  await f.service.credentials(c, f.identity, { bearer: "synthetic-published" });
  await f.pool.execute("UPDATE external_mcp_secret_gc SET notBefore=UTC_TIMESTAMP(3)");
  await f.service.store.cleanupCredentials(
    c.executionHostId,
    (r) => deleted.push(r),
    f.hasCredential,
  );
  assert.ok(deleted.includes(previous));
});
test("G4 recovery expires unsent requests, freezes previously running requests and refuses a second runtime", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  await assert.rejects(RuntimeOwnership.claim(f.pool), /ALREADY_ACTIVE/);
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Recovery",
    config: f.httpConfig,
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const row = {
    id: randomUUID(),
    ownerId: f.identity.ownerId,
    connectionId: id,
    version: c.version,
    tool: "echo",
    toolHash: "a".repeat(64),
    sessionId: f.identity.sessionId,
    bootId: randomUUID(),
    commitment: "b".repeat(64),
  };
  await f.service.store.prepareCall(row, () => {});
  await f.service.store.recover(randomUUID());
  assert.equal((await f.service.store.call(f.identity.ownerId, row.id))?.state, "expired");
  const second = { ...row, id: randomUUID() };
  await f.service.store.prepareCall(second, () => {});
  assert.equal(await f.service.store.start(f.identity.ownerId, second.id, c.version), true);
  await f.service.store.recover(randomUUID());
  assert.equal(
    (await f.service.store.call(f.identity.ownerId, second.id))?.state,
    "outcome_unknown",
  );
  await assert.rejects(f.service.store.prepareCall({ ...row, id: randomUUID() }, () => {}));
  await f.service.invocations.acknowledge(c, f.identity, second.id);
  await f.service.store.prepareCall({ ...row, id: randomUUID() }, () => {});
  assert.equal(f.stats().calls, 0);
});
test("G4 credential rotation is versioned, write-only, and durable cleanup never deletes an active reference", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Credentials",
    config: { ...f.httpConfig, authentication: "bearer" },
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.credentials(c, f.identity, { bearer: "synthetic-first-key" });
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(c.version, 2);
  const ref = c.credentialRef;
  await f.service.credentials(c, f.identity, { bearer: "synthetic-second-key" });
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(c.version, 3);
  assert.notEqual(c.credentialRef, ref);
  assert.equal(
    JSON.stringify(await f.service.list(f.identity, f.binding.workspaceId)).includes(
      "synthetic-second-key",
    ),
    false,
  );
  const [rows] = await f.pool.query("SELECT * FROM external_mcp_connection");
  assert.equal(JSON.stringify(rows).includes("synthetic-first-key"), false);
  await f.service.discover(c, f.identity);
  assert.equal(f.stats().authorization, "Bearer synthetic-second-key");
  await f.pool.execute(
    "INSERT INTO external_mcp_secret_gc(ref,ownerId,executionHostId,notBefore) VALUES(?,?,?,UTC_TIMESTAMP(3))",
    [c.credentialRef, c.ownerId, c.executionHostId],
  );
  const deleted: string[] = [];
  await f.service.store.cleanupCredentials(
    c.executionHostId,
    (r) => deleted.push(r),
    f.hasCredential,
  );
  assert.equal(deleted.includes(c.credentialRef), false);
  await f.pool.execute("UPDATE external_mcp_connection SET executionHostId=? WHERE id=?", [
    randomBytes(32).toString("hex"),
    id,
  ]);
  await assert.rejects(f.service.connection(f.identity, f.binding.workspaceId, id), /HOST_CHANGED/);
  const view = await f.service.list(f.identity, f.binding.workspaceId);
  assert.ok(view[0]?.config);
  assert.equal(view[0].executionHostChanged, true);
  await f.service.disable(
    await f.service.managementConnection(f.identity, f.binding.workspaceId, id),
    f.identity,
  );
});
test("G4 audit admission failure prevents actual external tool invocation", {
  skip: !enabled,
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture(async (_o, event) => {
    if (event === "call_dispatch_requested") throw Error("synthetic audit unavailable");
  });
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Audit",
    config: f.httpConfig,
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("Missing tool snapshot"), [
    "echo",
  ]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const call = await f.service.invocations.prepare(c, f.identity, "echo", {
    text: "should not leave",
  });
  await f.service.invocations.confirm(c, f.identity, call.id);
  for (let i = 0; i < 80; i++) {
    const row = (await f.service.invocations.history(c, f.identity)).find((v) => v.id === call.id);
    if (row?.state === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(f.stats().calls, 0);
  assert.equal((await f.service.invocations.history(c, f.identity))[0]?.state, "failed");
});
