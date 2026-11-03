import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { ExternalDriver, ResolverBudget } from "../src/mcp-client/driver.js";
import { ExternalMcpError } from "../src/mcp-client/model.js";
import { MetadataDatabase } from "../src/mcp-client/metadata.js";
import { installProgram } from "../src/mcp-client/programs.js";
import { TerminalUpdates } from "../src/mcp-client/terminals.js";
import { digest } from "../src/mcp-client/tool-policy.js";
import { externalFixture } from "./external-mcp-fixture.js";
import { packageFixture } from "./external-program-fixture.js";

const enabled = process.env.STAGE9_G4_TEST === "1";
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function approved(
  f: Awaited<ReturnType<typeof externalFixture>>,
  config: unknown = f.httpConfig,
) {
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Lifecycle fixture",
    config,
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  if (c.config.kind === "stdio") {
    const p = await f.service.catalog.inspect(c.config.programId);
    await f.service.approveProgram(c, f.identity, p.installationHash);
    c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  }
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(
    c,
    f.identity,
    c.snapshotHash ?? assert.fail("Missing tool snapshot"),
    c.snapshot.map((t) => t.name),
  );
  return f.service.connection(f.identity, f.binding.workspaceId, id);
}
async function settled(
  f: Awaited<ReturnType<typeof externalFixture>>,
  c: Awaited<ReturnType<typeof approved>>,
  id: string,
) {
  for (let i = 0; i < 160; i++) {
    const row = (await f.service.invocations.history(c, f.identity)).find((r) => r.id === id);
    if (row && !["pending_approval", "running", "cancel_requested"].includes(row.state)) return row;
    await pause(50);
  }
  throw Error("fixture call did not settle");
}
test("G4 configured timeout is unknown after dispatch, exact resource query works, another session cannot reuse approval", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const c = await approved(f, {
    ...f.httpConfig,
    resource: `${f.resource}?profile=synthetic`,
    callTimeoutMs: 1000,
  });
  await assert.rejects(
    f.service.invocations.prepare(c, { ...f.identity, sessionId: "another-session" }, "echo", {
      text: "no",
    }),
    /TOOL_NOT_APPROVED/,
  );
  f.delay(3000);
  const q = await f.service.invocations.prepare(c, f.identity, "echo", { text: "late" });
  await f.service.invocations.confirm(c, f.identity, q.id);
  const result = await settled(f, c, q.id);
  assert.equal(result.state, "outcome_unknown");
  assert.equal(result.error, "EXTERNAL_MCP_CALL_TIMEOUT");
  assert.equal(f.stats().calls, 1);
  await pause(2500);
  assert.equal(f.stats().calls, 1);
  assert.equal((await settled(f, c, q.id)).state, "outcome_unknown");
});
test("G4 full stdio service preserves its approved actor and reclaims descendants on disconnect", {
  skip: !enabled || process.platform !== "win32",
  timeout: 45000,
}, async (t) => {
  let failPublication = false;
  const f = await externalFixture(undefined, undefined, (v) => ({
      ...v,
      set: (ref, value) => {
        if (failPublication) throw new ExternalMcpError("EXTERNAL_MCP_VAULT_UNAVAILABLE", 503);
        v.set(ref, value);
      },
    })),
    p = await packageFixture();
  t.after(async () => {
    await f.close();
    await p.close();
  });
  const programId = await installProgram(
    p.source,
    f.service.config.programRoot,
    f.service.config.hostExecutable,
  );
  let c = await f.service
    .create(f.identity, {
      workspaceId: f.binding.workspaceId,
      name: "Process fixture",
      config: { kind: "stdio", programId },
    })
    .then((r) => f.service.connection(f.identity, f.binding.workspaceId, r.id));
  const installed = await f.service.catalog.inspect(programId);
  await f.service.approveProgram(c, f.identity, installed.installationHash);
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await f.service.credentials(c, f.identity, { environment: { MCP_TEST_KEY: "synthetic" } });
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await f.service.approveProgram(c, f.identity, installed.installationHash);
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("Missing tool snapshot"), [
    "process_info",
  ]);
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  const q = await f.service.invocations.prepare(c, f.identity, "process_info", {});
  await f.service.invocations.confirm(c, f.identity, q.id);
  assert.equal((await settled(f, c, q.id)).state, "succeeded");
  const response = await f.request(`${f.base}/${c.id}/calls/${q.id}/result`);
  assert.equal(response.status, 200, await response.clone().text());
  const r = await response.json();
  const info = JSON.parse(r.result.content[0].text);
  assert.equal(info.configured, true);
  assert.equal(info.leaked, false);
  process.kill(info.pid, 0);
  process.kill(info.child, 0);
  await f.service.disconnect(c.id);
  assert.throws(() => process.kill(info.pid, 0));
  assert.throws(() => process.kill(info.child, 0));
  assert.equal(f.service.health().physical, 0);
  failPublication = true;
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await assert.rejects(
    f.service.credentials(c, f.identity, { environment: { MCP_TEST_KEY: "synthetic" } }),
    /VAULT_UNAVAILABLE/,
  );
  c = await f.service.connection(f.identity, f.binding.workspaceId, c.id);
  await assert.rejects(f.service.discover(c, f.identity), /CREDENTIAL_REQUIRED/);
  assert.deepEqual(await readdir(f.service.config.runRoot), []);
});

test("G4 sealing waits for the complete SDK send before DNS failure and cannot transfer it to another operation", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const resource = new URL(f.resource);
  resource.hostname = "mcp-fixture.test";
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Send ownership",
    config: {
      ...f.httpConfig,
      resource: resource.href,
      privateApprovals: [{ origin: resource.origin, addresses: ["127.0.0.1"] }],
    },
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const earliestFault = Error("earliest DNS fault"),
    laterFault = Error("later DNS fault");
  let block = false,
    waiting = 0,
    entered: () => void = () => {},
    releaseSecond: () => void = () => {},
    rejectDns: (e: Error) => void = () => {};
  const arrived = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((_r, reject) => {
      rejectDns = reject;
    }),
    secondGate = new Promise<void>((_resolve, reject) => {
      releaseSecond = () => reject(laterFault);
    });
  void secondGate.catch(() => {});
  t.after(() => releaseSecond());
  class Resolver extends ResolverBudget {
    override async resolve(host: string) {
      if (block) {
        waiting++;
        if (waiting === 2) entered();
        await (waiting === 1 ? secondGate : gate);
      }
      assert.equal(host, "mcp-fixture.test");
      return [{ address: "127.0.0.1", family: 4 }];
    }
  }
  const driver = new ExternalDriver(
    c,
    f.service.config,
    { has: () => true, get: () => ({}), set: () => {}, remove: () => {} },
    f.service.lease,
    new Resolver(),
    f.service.catalog,
  );
  t.after(() => driver.close());
  let settled = false;
  await assert.rejects(
    driver.within(
      { who: f.identity, signal: AbortSignal.timeout(15000), check: () => {} },
      async () => {
        await driver.discover();
        block = true;
        const transport = driver.client.transport;
        assert.ok(transport);
        // Public SDK transport entry queues safe protocol pings; its fetch
        // continues asynchronously after sealing, under this admission only.
        const listing = transport.send({ jsonrpc: "2.0", id: 999, method: "ping" });
        void listing.catch(() => {});
        const second = transport.send({ jsonrpc: "2.0", id: 1000, method: "ping" });
        void second.catch(() => {});
        const seal = driver.seal().finally(() => {
          settled = true;
        });
        const rejected = assert.rejects(seal, /^Error: EXTERNAL_MCP_NETWORK_FAILED$/);
        await Promise.race([
          arrived,
          listing.then(() => {
            throw Error("listing completed without DNS");
          }),
        ]);
        await pause(50);
        assert.equal(settled, false);
        let denied: Promise<void> | undefined;
        assert.doesNotThrow(() => {
          denied = transport.send({ jsonrpc: "2.0", id: 1001, method: "ping" });
        });
        assert.ok(denied);
        await assert.rejects(denied, /NO_ACTIVE_OPERATION/);
        await assert.rejects(
          driver.within(
            { who: f.identity, signal: AbortSignal.timeout(1000), check: () => {} },
            async () => {},
            async () => {},
          ),
          /CONNECTION_BUSY/,
        );
        rejectDns(earliestFault);
        await assert.rejects(second, /^Error: EXTERNAL_MCP_NETWORK_FAILED$/);
        await pause(50);
        assert.equal(settled, false);
        releaseSecond();
        await assert.rejects(listing, /^Error: EXTERNAL_MCP_NETWORK_FAILED$/);
        await rejected;
      },
      async () => {
        await driver.close();
      },
    ),
    /^Error: EXTERNAL_MCP_NETWORK_FAILED$/,
  );
});
test("G4 closing during blocked registration cannot create a late pending call", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  let announce: () => void = () => {};
  const announced = new Promise<void>((r) => {
    announce = r;
  });
  const f = await externalFixture(async (_o, event) => {
    if (event === "call_prepare_requested") announce();
  });
  t.after(() => f.close());
  const c = await approved(f);
  const lock = await f.pool.getConnection();
  await lock.beginTransaction();
  await lock.execute("SELECT ownerId FROM external_mcp_owner WHERE ownerId=? FOR UPDATE", [
    f.identity.ownerId,
  ]);
  const prepared = f.service.invocations.prepare(c, f.identity, "echo", {
    text: "ephemeral-canary",
  });
  const rejected = assert.rejects(prepared, /CLOSED|NOT_FOUND|EXPIRED/);
  await announced;
  await f.service.invocations.close();
  await lock.rollback();
  lock.release();
  await rejected;
  const [rows] = await f.pool.query("SELECT id FROM external_mcp_call");
  assert.deepEqual(rows, []);
  assert.equal(f.stats().calls, 0);
});
test("G4 slow metadata queries time out with an unreclaimed physical slot", {
  skip: !enabled,
  timeout: 20000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const db = new MetadataDatabase(f.pool),
    start = performance.now();
  await assert.rejects(db.query("SELECT SLEEP(7)"), /STORAGE_TIMEOUT/);
  assert.ok(performance.now() - start < 6500);
  assert.equal(db.health().outstanding, 1);
  await pause(2200);
  assert.equal(db.health().outstanding, 1);
  await db.query("SELECT 1");
  assert.equal(db.health().outstanding, 1);
});
test("G4 terminal updates bound physical writers and preserve facts across an older history read", async () => {
  const releases: Array<() => void> = [];
  let writes = 0;
  const queue = new TerminalUpdates(async () => {
    writes++;
    await new Promise<void>((r) => releases.push(r));
  });
  let finishRead: () => void = () => {};
  const reading = queue.read(
    () =>
      new Promise<void>((r) => {
        finishRead = r;
      }),
    () => queue.get("a")?.state,
  );
  queue.enqueue({ id: "a", owner: "owner", state: "outcome_unknown" });
  queue.enqueue({ id: "b", owner: "owner", state: "cancelled" });
  queue.enqueue({ id: "c", owner: "owner", state: "expired" });
  assert.equal(writes, 2);
  assert.equal(queue.health().outstanding, 2);
  releases.shift()?.();
  await pause(1);
  assert.equal(writes, 3);
  assert.equal(queue.get("a")?.state, "outcome_unknown");
  finishRead();
  assert.equal(await reading, "outcome_unknown");
  assert.equal(queue.get("a"), undefined);
  for (const r of releases) r();
  await queue.settle();
  assert.equal(queue.health().pending, 0);
});

test("G4 losing the actual admission transaction aborts physical work before a later action", {
  skip: !enabled,
  timeout: 20000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const c = await approved(f);
  let enter: () => void = () => {};
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  let escaped = false;
  const work = f.service.lease.run(c, f.identity, async (check, signal) => {
    enter();
    await new Promise<void>((r) => {
      signal.addEventListener("abort", () => r(), { once: true });
    });
    check();
    escaped = true;
  });
  const rejected = assert.rejects(work, /AUTH_EXPIRED|AUTH_TIMEOUT/);
  await entered;
  const [rows] = await f.pool.query<import("mysql2/promise").RowDataPacket[]>(
    "SELECT t.trx_mysql_thread_id id FROM information_schema.innodb_trx t JOIN information_schema.processlist p ON p.ID=t.trx_mysql_thread_id WHERE p.DB=?",
    [f.database],
  );
  assert.equal(rows.length, 1);
  const id = Number(rows[0]?.id);
  assert.ok(Number.isSafeInteger(id) && id > 0);
  await f.pool.query(`KILL CONNECTION ${id}`);
  await rejected;
  assert.equal(escaped, false);
  assert.equal(f.service.lease.health().outstanding, 1);
});

test("G4 a concurrent discovery cannot close the discovery that owns the actor", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Concurrent discovery",
    config: f.httpConfig,
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const results = await Promise.allSettled([
    f.service.discover(c, f.identity),
    f.service.discover(c, f.identity),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.ok(failed && failed.status === "rejected");
  assert.match(String(failed.reason), /CONNECTION_BUSY/);
  assert.equal(f.service.health().physical, 1);
});
test("G4 HEADER_MISMATCH after dispatch never refreshes/replays the approved call", {
  skip: !enabled,
  timeout: 20000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const c = await approved(f);
  f.mismatchAfterDispatch();
  const q = await f.service.invocations.prepare(c, f.identity, "echo", { text: "one side effect" });
  await f.service.invocations.confirm(c, f.identity, q.id);
  assert.equal((await settled(f, c, q.id)).state, "outcome_unknown");
  assert.equal(f.stats().calls, 1);
  await pause(300);
  assert.equal(f.stats().calls, 1);
});

test("G4 cancel finishing late cannot disconnect a newer call on the same actor", {
  skip: !enabled,
  timeout: 25000,
}, async (t) => {
  let enter: () => void = () => {},
    release: () => void = () => {};
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const f = await externalFixture(async (_owner, event) => {
    if (event === "call_cancel_requested") {
      enter();
      await gate;
    }
  });
  t.after(() => f.close());
  const c = await approved(f);
  f.delay(150);
  const a = await f.service.invocations.prepare(c, f.identity, "echo", { text: "first" });
  await f.service.invocations.confirm(c, f.identity, a.id);
  const cancel = f.service.invocations.cancel(c, f.identity, a.id);
  await entered;
  assert.equal((await settled(f, c, a.id)).state, "succeeded");
  await f.service.invocations.terminals.settle();
  f.delay(1000);
  const b = await f.service.invocations.prepare(c, f.identity, "echo", { text: "second" });
  await f.service.invocations.confirm(c, f.identity, b.id);
  for (let i = 0; i < 60 && f.stats().calls < 2; i++) await pause(20);
  assert.equal(f.stats().calls, 2);
  release();
  assert.equal((await cancel).state, "succeeded");
  assert.equal((await settled(f, c, b.id)).state, "succeeded");
  assert.equal(f.service.health().physical, 1);
});

test("G4 snapshot persistence checks the live session after remote discovery completes", {
  skip: !enabled,
  timeout: 20000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Revoked discovery",
    config: f.httpConfig,
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const save = f.service.store.discovery.bind(f.service.store);
  f.service.store.discovery = async (...args) => {
    await f.pool.execute("UPDATE session SET expiresAt=UTC_TIMESTAMP(3) WHERE id=?", [
      f.identity.sessionId,
    ]);
    return save(...args);
  };
  await assert.rejects(f.service.discover(c, f.identity), /SESSION_EXPIRED/);
  assert.equal((await f.service.store.connection(f.identity.ownerId, id)).snapshotHash, null);
  assert.equal(f.stats().calls, 0);
});

test("G4 observed tool changes before discovery persistence cannot publish a stale snapshot", {
  skip: !enabled,
  timeout: 25000,
}, async (t) => {
  for (const fault of ["changed", "closed"] as const) {
    await t.test(fault, async () => {
      const f = await externalFixture();
      try {
        const { id } = await f.service.create(f.identity, {
          workspaceId: f.binding.workspaceId,
          name: "Discovery publication",
          config: f.httpConfig,
        });
        const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
        const save = f.service.store.discovery.bind(f.service.store);
        f.service.store.discovery = async (...args) => {
          const observed = { ...c, snapshot: args[3], snapshotHash: digest(args[3]) };
          assert.equal(f.service.summary(observed, f.identity).toolsVerified, true);
          if (fault === "changed") f.notifyToolsChanged();
          else await f.closeSubscriptions();
          for (
            let attempt = 0;
            attempt < 50 && f.service.summary(observed, f.identity).toolsVerified;
            attempt++
          )
            await pause(10);
          assert.equal(f.service.summary(observed, f.identity).toolsVerified, false);
          return save(...args);
        };
        await assert.rejects(
          f.service.discover(c, f.identity),
          /SNAPSHOT_CHANGED|NETWORK_FAILED|CLOSED/,
        );
        assert.equal((await f.service.store.connection(f.identity.ownerId, id)).snapshotHash, null);
        assert.equal(f.stats().calls, 0);
      } finally {
        await f.close();
      }
    });
  }
});

test("G4 tool notifications or subscription loss before local handoff prevent tool calls", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  for (const fault of ["changed", "closed"] as const) {
    await t.test(fault, async () => {
      let onDispatch: () => Promise<void> = async () => {};
      const f = await externalFixture(async (_owner, event) => {
        if (event === "call_dispatch_requested") await onDispatch();
      });
      try {
        const c = await approved(f);
        assert.equal(f.service.summary(c, f.identity).toolsVerified, true);
        onDispatch = async () => {
          if (fault === "changed") f.notifyToolsChanged();
          else await f.closeSubscriptions();
          for (let attempt = 0; attempt < 50; attempt++) {
            if (!f.service.summary(c, f.identity).toolsVerified) return;
            await pause(10);
          }
          assert.fail("subscription invalidation was not observed");
        };
        const q = await f.service.invocations.prepare(c, f.identity, "echo", {
          text: "must not leave",
        });
        await f.service.invocations.confirm(c, f.identity, q.id);
        assert.equal((await settled(f, c, q.id)).state, "failed");
        assert.equal(f.stats().calls, 0);
        assert.equal(f.service.summary(c, f.identity).toolsVerified, false);
      } finally {
        await f.close();
      }
    });
  }
});

test("G4 a tool change after local handoff leaves one unknown outcome without replay", {
  skip: !enabled,
  timeout: 20000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const c = await approved(f);
  f.delay(1000);
  const q = await f.service.invocations.prepare(c, f.identity, "echo", { text: "already handed" });
  await f.service.invocations.confirm(c, f.identity, q.id);
  for (let attempt = 0; attempt < 100 && !f.stats().calls; attempt++) await pause(10);
  assert.equal(f.stats().calls, 1);
  f.notifyToolsChanged();
  assert.equal((await settled(f, c, q.id)).state, "outcome_unknown");
  await pause(1100);
  assert.equal(f.stats().calls, 1);
  assert.equal((await f.request(`${f.base}/${c.id}/calls/${q.id}/result`)).status, 410);
});

test("G4 an observed change after a complete response but before result publication preserves unknown", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  for (const fault of ["changed", "closed"] as const) {
    await t.test(fault, async () => {
      const f = await externalFixture();
      const original = ExternalDriver.prototype.seal;
      let injected = false;
      try {
        const c = await approved(f);
        ExternalDriver.prototype.seal = async function () {
          await original.call(this);
          if (injected || f.stats().calls !== 1) return;
          injected = true;
          if (fault === "changed") f.notifyToolsChanged();
          else await f.closeSubscriptions();
          for (
            let attempt = 0;
            attempt < 50 && f.service.summary(c, f.identity).toolsVerified;
            attempt++
          )
            await pause(10);
          assert.equal(f.service.summary(c, f.identity).toolsVerified, false);
        };
        const call = await f.service.invocations.prepare(c, f.identity, "echo", {
          text: "received but not published",
        });
        await f.service.invocations.confirm(c, f.identity, call.id);
        assert.equal((await settled(f, c, call.id)).state, "outcome_unknown");
        assert.equal(injected, true);
        assert.equal(f.stats().calls, 1);
        assert.equal((await f.request(`${f.base}/${c.id}/calls/${call.id}/result`)).status, 410);
        await assert.rejects(f.service.invocations.confirm(c, f.identity, call.id));
        assert.equal(f.stats().calls, 1);
      } finally {
        ExternalDriver.prototype.seal = original;
        await f.close();
      }
    });
  }
});

test("G4 actual two-minute deadlines erase result access and expire unconfirmed parameters", {
  skip: !enabled,
  timeout: 150000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const pending = await approved(f),
    done = await approved(f);
  const a = await f.service.invocations.prepare(pending, f.identity, "echo", {
      text: "unsent-sensitive",
    }),
    b = await f.service.invocations.prepare(done, f.identity, "echo", { text: "temporary-result" });
  await f.service.invocations.confirm(done, f.identity, b.id);
  assert.equal((await settled(f, done, b.id)).state, "succeeded");
  await pause(121000);
  assert.equal((await settled(f, pending, a.id)).state, "expired");
  assert.equal(f.stats().calls, 1);
  assert.equal((await f.request(`${f.base}/${done.id}/calls/${b.id}/result`)).status, 404);
  await f.service.invocations.terminals.settle();
  assert.equal((await f.service.store.call(f.identity.ownerId, b.id))?.state, "succeeded");
  const [rows] = await f.pool.query("SELECT * FROM external_mcp_call");
  assert.ok(!JSON.stringify(rows).includes("sensitive"));
  assert.ok(!JSON.stringify(rows).includes("temporary-result"));
});
