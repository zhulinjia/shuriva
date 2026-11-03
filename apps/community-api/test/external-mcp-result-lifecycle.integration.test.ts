import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { installHttpResponseLease } from "../src/http-response-lease.js";
import type { Connection } from "../src/mcp-client/model.js";
import { externalFixture } from "./external-mcp-fixture.js";

const enabled = process.env.STAGE9_G4_TEST === "1";
type Fixture = Awaited<ReturnType<typeof externalFixture>>;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function approved(f: Fixture) {
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Retained result",
    config: f.httpConfig,
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("snapshot"), ["echo"]);
  return f.service.connection(f.identity, f.binding.workspaceId, id);
}
async function state(f: Fixture, c: Connection, id: string, expected: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = (await f.service.invocations.history(c, f.identity)).find((v) => v.id === id);
    if (row?.state === expected) return row;
    await pause(20);
  }
  assert.fail(`call did not reach ${expected}`);
}
async function complete(f: Fixture, c: Connection) {
  const call = await f.service.invocations.prepare(c, f.identity, "echo", {
    text: "synthetic retained result",
  });
  await f.service.invocations.confirm(c, f.identity, call.id);
  const row = await state(f, c, call.id, "succeeded");
  assert.equal(row.resultAvailable, true);
  await f.service.invocations.terminals.settle();
  return call;
}
async function invalidate(f: Fixture, c: Connection, fault: "changed" | "closed") {
  if (fault === "changed") f.notifyToolsChanged();
  else await f.closeSubscriptions();
  for (let attempt = 0; attempt < 100 && f.service.summary(c, f.identity).toolsVerified; attempt++)
    await pause(10);
  assert.equal(f.service.summary(c, f.identity).toolsVerified, false);
}

test("G4 cached but undisclosed results become unknown and cannot release unknown admission", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  for (const fault of ["changed", "closed"] as const)
    await t.test(fault, async () => {
      const f = await externalFixture();
      try {
        const c = await approved(f),
          call = await complete(f, c);
        const [before] = await f.pool.query<import("mysql2/promise").RowDataPacket[]>(
          "SELECT state,slot FROM external_mcp_call WHERE id=?",
          [call.id],
        );
        assert.equal(before[0]?.state, "result_retained");
        assert.equal(before[0]?.slot, null);
        await invalidate(f, c, fault);
        const row = await state(f, c, call.id, "outcome_unknown");
        assert.equal(row.resultAvailable, false);
        assert.equal((await f.request(`${f.base}/${c.id}/calls/${call.id}/result`)).status, 410);
        await assert.rejects(f.service.invocations.confirm(c, f.identity, call.id));
        await assert.rejects(
          f.service.invocations.prepare(c, f.identity, "echo", { text: "blocked" }),
          /UNKNOWN_CALL_PENDING/,
        );
        await f.service.invocations.terminals.settle();
        const persisted = await f.service.store.call(f.identity.ownerId, call.id);
        assert.ok(persisted);
        assert.equal(persisted.state, "outcome_unknown");
        assert.equal(persisted.acknowledged, false);
        const next = { ...persisted, id: randomUUID() };
        await assert.rejects(
          f.service.store.prepareCall(next, () => {}),
          /UNKNOWN_CALL_PENDING/,
        );
        await f.service.invocations.acknowledge(c, f.identity, call.id);
        await f.service.store.prepareCall(next, () => {});
        await f.service.store.terminal(f.identity.ownerId, next.id, "expired");
        assert.equal(f.stats().calls, 1);
      } finally {
        await f.close();
      }
    });
});

test("G4 a change while result sending waits prevents actual HTTP bytes", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  for (const fault of ["changed", "closed"] as const)
    await t.test(fault, async () => {
      const f = await externalFixture();
      let release: () => void = () => {};
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let entered: () => void = () => {};
      const ready = new Promise<void>((done) => {
        entered = done;
      });
      let sending: Promise<void> | undefined;
      let socket: import("node:net").Socket | null = null;
      const c = await approved(f),
        call = await complete(f, c);
      const server = createServer((_request, response) => {
        socket = response.socket;
        sending = f.service.invocations.result(
          c,
          f.identity,
          call.id,
          async (body, check, signal) => {
            const remove = installHttpResponseLease(response, check, signal);
            try {
              check();
              entered();
              await gate;
              // Only the real HTTP write boundary can authorize this delayed end.
              response.end(JSON.stringify(body));
            } finally {
              remove();
            }
          },
        );
        void sending.catch(() => {});
      });
      try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const delivery = fetch(`http://127.0.0.1:${address.port}/synthetic-result`).then((r) =>
          r.text(),
        );
        const rejected = assert.rejects(delivery);
        void rejected.catch(() => {});
        await ready;
        await invalidate(f, c, fault);
        await rejected;
        release();
        assert.ok(sending);
        await assert.rejects(sending, /RESULT_EXPIRED|AUTH_EXPIRED/);
        assert.equal((socket as import("node:net").Socket | null)?.bytesWritten, 0);
        const row = await state(f, c, call.id, "outcome_unknown");
        assert.equal(row.resultAvailable, false);
        await f.service.invocations.terminals.settle();
        assert.equal(
          (await f.service.store.call(f.identity.ownerId, call.id))?.state,
          "outcome_unknown",
        );
        assert.equal(f.stats().calls, 1);
      } finally {
        release();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await f.close();
      }
    });
});

test("G4 already published success stays historical while its cached bytes expire on change", {
  skip: !enabled,
  timeout: 15000,
}, async () => {
  const f = await externalFixture();
  try {
    const c = await approved(f),
      call = await complete(f, c);
    assert.equal((await f.request(`${f.base}/${c.id}/calls/${call.id}/result`)).status, 200);
    await invalidate(f, c, "changed");
    const row = await state(f, c, call.id, "succeeded");
    assert.equal(row.resultAvailable, false);
    assert.equal((await f.request(`${f.base}/${c.id}/calls/${call.id}/result`)).status, 410);
    assert.equal(f.stats().calls, 1);
  } finally {
    await f.close();
  }
});

test("G4 durable retained results recover unknown even after their active slot was released", {
  skip: !enabled,
  timeout: 15000,
}, async () => {
  const f = await externalFixture();
  try {
    const c = await approved(f),
      call = await complete(f, c);
    assert.equal(
      (await f.service.store.call(f.identity.ownerId, call.id))?.state,
      "result_retained",
    );
    await f.service.store.recover(randomUUID());
    const recovered = await f.service.store.call(f.identity.ownerId, call.id);
    assert.ok(recovered);
    assert.equal(recovered.state, "outcome_unknown");
    const next = { ...recovered, id: randomUUID() };
    await assert.rejects(
      f.service.store.prepareCall(next, () => {}),
      /UNKNOWN_CALL_PENDING/,
    );
    await f.service.store.acknowledge(f.identity.ownerId, call.id);
    await f.service.store.prepareCall(next, () => {});
    await f.service.store.terminal(f.identity.ownerId, next.id, "expired");
    assert.equal(f.stats().calls, 1);
  } finally {
    await f.close();
  }
});

test("G4 pending or failed real-driver close blocks all replacement actors", {
  skip: !enabled,
  timeout: 30000,
}, async (t) => {
  for (const failure of [false, true])
    await t.test(failure ? "uncertain" : "pending", async () => {
      const f = await externalFixture();
      let release: () => void = () => {};
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let closeCalls = 0;
      try {
        const c = await approved(f);
        const actors = Reflect.get(f.service, "drivers") as Map<
          string,
          { driver: import("../src/mcp-client/driver.js").ExternalDriver }
        >;
        const driver = actors.get(c.id)?.driver ?? assert.fail("real actor");
        const close = driver.close.bind(driver);
        driver.close = async () => {
          closeCalls++;
          await gate;
          await close();
          if (failure) throw Error("synthetic close acknowledgment lost");
        };
        const first = f.service.disconnectForUser(c.id),
          second = f.service.disconnectForUser(c.id);
        const finished = Promise.allSettled([first, second]);
        await Promise.resolve();
        assert.equal(f.service.summary(c, f.identity).lifecycle, "closing");
        const attempts = () =>
          Promise.all([
            assert.rejects(f.service.discover(c, f.identity), /CONNECTION_BUSY|CLEANUP_UNKNOWN/),
            assert.rejects(
              f.service.approve(c, f.identity, c.snapshotHash ?? "", ["echo"]),
              /CONNECTION_BUSY|CLEANUP_UNKNOWN/,
            ),
            assert.rejects(
              f.service.invocations.prepare(c, f.identity, "echo", {}),
              /CONNECTION_BUSY|CLEANUP_UNKNOWN/,
            ),
          ]);
        await attempts();
        await attempts();
        assert.equal(f.service.health().connections, 0);
        assert.equal(f.service.health().physical, 1);
        assert.equal(closeCalls, 1);
        assert.equal(f.stats().calls, 0);
        release();
        const results = await finished;
        assert.equal(
          results.every((r) => r.status === (failure ? "rejected" : "fulfilled")),
          true,
        );
        if (failure) {
          assert.equal(f.service.summary(c, f.identity).lifecycle, "cleanup_unknown");
          await attempts();
          await assert.rejects(f.service.disconnectForUser(c.id), /CLEANUP_UNKNOWN/);
          assert.equal(f.service.health().physical, 1);
        } else {
          assert.equal(f.service.health().physical, 0);
          await f.service.discover(c, f.identity);
          assert.equal(f.service.health().connections, 1);
        }
        assert.equal(closeCalls, 1);
        assert.equal(f.stats().calls, 0);
      } finally {
        release();
        if (failure) await assert.rejects(f.close(), /CLEANUP_UNKNOWN/);
        else await f.close();
      }
    });
});
