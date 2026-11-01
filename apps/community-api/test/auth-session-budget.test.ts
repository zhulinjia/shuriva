import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Pool, PoolConnection } from "mysql2/promise";
import { authSessionAccess, type Auth } from "../src/auth.js";

const timeout = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_TIMEOUT";

test("session acquisition has a whole-operation deadline and bounds late pool waiters including retries", {
  timeout: 10000,
}, async () => {
  const acquisitions: Array<(connection: PoolConnection) => void> = [];
  let queries = 0,
    released = 0;
  const returned = new Set<symbol>();
  const connection = () => {
    const id = Symbol();
    return {
      execute: async () => {
        queries++;
        return [[{ id: "active" }], []];
      },
      release: () => {
        assert.equal(returned.has(id), false);
        returned.add(id);
        released++;
      },
      destroy: () => {},
    } as unknown as PoolConnection;
  };
  const pool = {
    getConnection: () =>
      new Promise<PoolConnection>((resolve) => {
        acquisitions.push(resolve);
      }),
  } as unknown as Pool;
  const sessions = authSessionAccess({} as Auth, pool);
  const identities = Array.from({ length: 33 }, () => ({
    ownerId: "owner",
    sessionId: randomUUID(),
  }));
  const checks = identities.map((identity) => sessions.active(identity));
  const outcomes = Promise.allSettled(checks);
  const first = identities[0];
  assert.ok(first);
  await assert.rejects(
    sessions.active(first),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_CAPACITY",
  );
  assert.equal(acquisitions.length, 32);
  const results = await outcomes;
  assert.ok(
    results.slice(0, 32).every((result) => result.status === "rejected" && timeout(result.reason)),
  );
  const overflow = results[32];
  assert.ok(
    overflow?.status === "rejected" &&
      overflow.reason instanceof Error &&
      "code" in overflow.reason &&
      overflow.reason.code === "AUTH_SESSION_CHECK_CAPACITY",
  );
  await assert.rejects(
    sessions.active(first),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_CAPACITY",
  );
  assert.equal(acquisitions.length, 32, "timed-out retries must not append pool waiters");
  for (const resolve of acquisitions) resolve(connection());
  await setImmediate();
  assert.equal(queries, 0, "late acquisition must be released without issuing authorization SQL");
  assert.equal(released, 32);
  const fresh = sessions.active(first);
  assert.equal(acquisitions.length, 33);
  const latest = acquisitions[32];
  assert.ok(latest);
  latest(connection());
  assert.equal(await fresh, true);
  assert.equal(queries, 1);
  assert.equal(released, 33);
});

test("a concurrent check of the same session never inherits an earlier query's authorization result", async () => {
  const acquisitions: Array<(connection: PoolConnection) => void> = [];
  const sessions = authSessionAccess(
    {} as Auth,
    {
      getConnection: () =>
        new Promise<PoolConnection>((resolve) => {
          acquisitions.push(resolve);
        }),
    } as unknown as Pool,
  );
  const identity = { ownerId: "owner", sessionId: randomUUID() };
  const before = sessions.active(identity),
    after = sessions.active(identity);
  assert.notEqual(before, after);
  assert.equal(acquisitions.length, 2);
  const first = acquisitions[0],
    second = acquisitions[1];
  assert.equal(typeof first, "function");
  assert.equal(typeof second, "function");
  first({
    execute: async () => [[{ id: "active" }], []],
    release() {},
    destroy() {},
  } as unknown as PoolConnection);
  assert.equal(await before, true);
  second({
    execute: async () => [[], []],
    release() {},
    destroy() {},
  } as unknown as PoolConnection);
  assert.equal(await after, false);
});

test("a stalled prepare/execute is denied by the outer deadline and destroys its owned connection", {
  timeout: 10000,
}, async () => {
  let destroyed = 0,
    released = 0;
  const connection = {
    execute: () => new Promise(() => {}),
    destroy: () => {
      destroyed++;
    },
    release: () => {
      released++;
    },
  } as unknown as PoolConnection;
  const sessions = authSessionAccess(
    {} as Auth,
    { getConnection: async () => connection } as unknown as Pool,
  );
  await assert.rejects(sessions.active({ ownerId: "owner", sessionId: randomUUID() }), timeout);
  assert.equal(destroyed, 1);
  assert.equal(released, 0, "a destroyed connection must never be returned to the pool");
});

test("timed-out acquired commands keep their quota until their work actually terminates", {
  timeout: 10000,
}, async () => {
  const completions: Array<() => void> = [];
  let acquired = 0;
  const sessions = authSessionAccess(
    {} as Auth,
    {
      getConnection: async () => {
        acquired++;
        return {
          execute: () =>
            new Promise((resolve) => {
              completions.push(() => resolve([[], []]));
            }),
          destroy() {},
          release() {},
        } as unknown as PoolConnection;
      },
    } as unknown as Pool,
  );
  const identity = { ownerId: "owner", sessionId: randomUUID() };
  await Promise.all(
    Array.from({ length: 32 }, () => assert.rejects(sessions.active(identity), timeout)),
  );
  await assert.rejects(
    sessions.active(identity),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_CAPACITY",
  );
  assert.equal(acquired, 32);
  for (const complete of completions) complete();
  await setImmediate();
  const fresh = sessions.active(identity);
  await setImmediate();
  assert.equal(acquired, 33);
  completions[32]?.();
  assert.equal(await fresh, false);
});

test("a driver sequence timeout never returns a still-busy connection to the pool", async () => {
  let destroyed = 0,
    released = 0;
  const sessions = authSessionAccess(
    {} as Auth,
    {
      getConnection: async () => ({
        execute: async () => {
          throw Object.assign(new Error("synthetic driver timeout"), {
            code: "PROTOCOL_SEQUENCE_TIMEOUT",
          });
        },
        destroy() {
          destroyed++;
        },
        release() {
          released++;
        },
      }),
    } as unknown as Pool,
  );
  await assert.rejects(sessions.active({ ownerId: "owner", sessionId: randomUUID() }));
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
});
