import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AuthorizationWork } from "../dist/authorization-work.js";
import { httpFixture } from "../dist/http-fixture.js";

test("late authorization keeps its own quota, observes cancellation and recovers only after settlement", async () => {
  const work = new AuthorizationWork(40, 1);
  let release,
    cancelled = false;
  const blocked = work.run(
    (signal) =>
      new Promise((resolve) => {
        release = resolve;
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
          },
          { once: true },
        );
      }),
  );
  await assert.rejects(() => blocked, /MCP_AUTH_TIMEOUT/);
  assert.equal(cancelled, true);
  assert.equal(work.outstanding, 1);
  await assert.rejects(() => work.run(async () => true), /MCP_AUTH_CAPACITY/);
  release(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(work.outstanding, 0);
  assert.equal(await work.run(async () => true), true);
});

test("real HTTP auth stalls return on deadline without consuming all request slots permanently", async (t) => {
  let stall = true;
  const releases = [];
  const grant = {
    id: randomUUID(),
    clientId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: randomUUID(),
    familyId: randomUUID(),
    recipient: "synthetic-domain",
    generation: 1,
    token: randomUUID(),
    scopes: [],
  };
  const fixture = await httpFixture(
    async () => {
      if (stall) return new Promise((resolve) => releases.push(() => resolve(grant)));
      return grant;
    },
    { timeoutMs: 100 },
  );
  t.after(async () => {
    for (const release of releases) release();
    await fixture.close();
  });
  for (let index = 0; index < 8; index++)
    assert.equal((await fetch(fixture.url, { method: "POST", body: "{}" })).status, 408);
  assert.equal(fixture.outstandingAuthorization(), 8);
  assert.equal((await fetch(fixture.url, { method: "POST", body: "{}" })).status, 503);
  stall = false;
  for (const release of releases) release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.outstandingAuthorization(), 0);
  assert.notEqual((await fetch(fixture.url, { method: "POST", body: "{}" })).status, 503);
});
