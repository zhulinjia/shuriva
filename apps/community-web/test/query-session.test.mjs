import assert from "node:assert/strict";
import { test } from "node:test";
import { QuerySession } from "../src/queries/query-session.ts";
import { ApiError } from "../src/api.ts";

const id = "11111111-1111-4111-8111-111111111111";
const scope = async () => ({ instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeToken: "fixture-scope-token" });
const request = { sql: "SELECT id FROM items", parameters: [], maxRows: 5 };
const payload = Buffer.from(
  JSON.stringify({
    columns: [{ name: "id", type: "INT" }],
    rows: [[{ null: false, encoding: "text", value: "1" }]],
    timezone: "UTC",
    truncated: false,
  }),
).toString("base64url");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function clock() {
  let next;
  let now = 0;
  return {
    schedule: (fn) => {
      next = fn;
      return 1;
    },
    clear: () => {
      next = undefined;
    },
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    run: () => {
      const fn = next;
      next = undefined;
      fn?.();
    },
  };
}

test("manual and generated queries preserve the explicit schema binding", async () => {
  const submissions = [];
  for (const version of [null, "a".repeat(64)]) {
    const session = new QuerySession(
      { scope, create: async (value) => { submissions.push(value); return { id }; }, status: async () => ({ state: "completed", payload }), cancel: async () => {} },
      () => {}, clock(), () => id,
    );
    await session.prepare();
    await session.start({ ...request, schemaVersion: version });
    await tick();
    session.close();
  }
  assert.deepEqual(submissions.map((value) => value.schemaVersion), [null, "a".repeat(64)]);
});

test("a lost status request reconnects without creating another query", async () => {
  let created = 0,
    checks = 0,
    latest;
  const timer = clock();
  const session = new QuerySession(
    {
      scope,
      create: async () => {
        created++;
        return { id };
      },
      status: async () => {
        if (++checks === 1) throw new Error("offline");
        return { state: "completed", payload };
      },
      cancel: async () => {},
    },
    (view) => {
      latest = view;
    },
    timer,
    () => id,
  );
  await session.prepare(); await session.start(request);
  await tick();
  assert.equal(latest.phase, "reconnecting");
  assert.equal(created, 1);
  timer.run();
  await tick();
  assert.equal(latest.phase, "completed");
  assert.equal(latest.result.rows[0][0].value, "1");
  assert.equal(created, 1);
  session.close();
});

test("late query results cannot reappear after cancellation", async () => {
  const pending = deferred();
  let latest;
  const cancelled = [];
  const session = new QuerySession(
    {
      scope,
      create: async () => ({ id }),
      status: () => pending.promise,
      cancel: async (value) => {
        cancelled.push(value);
      },
    },
    (view) => {
      latest = view;
    },
    clock(),
    () => id,
  );
  await session.prepare(); await session.start(request);
  await session.cancel();
  pending.resolve({ state: "completed", payload });
  await tick();
  assert.equal(latest.phase, "cancelled");
  assert.equal(latest.result, null);
  assert.deepEqual(cancelled, [id]);
  session.close();
});

test("closing during submission cancels a task even if its id arrives late", async () => {
  const pending = deferred();
  const cancelled = [];
  const updates = [];
  const session = new QuerySession(
    {
      scope,
      create: () => pending.promise,
      status: async () => {
        throw new Error("unexpected");
      },
      cancel: async (value) => {
        cancelled.push(value);
      },
    },
    (view) => updates.push(view),
    clock(),
    () => id,
  );
  await session.prepare();
  updates.length = 0;
  const starting = session.start(request);
  await tick();
  session.close();
  pending.resolve({ id });
  await starting;
  await tick();
  assert.deepEqual(cancelled, [id, id]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].phase, "submitting");
});

test("extended network failure permits checking the same task or cancelling it", async () => {
  let checks = 0,
    latest;
  const timer = clock();
  const session = new QuerySession(
    {
      scope,
      create: async () => ({ id }),
      status: async () => {
        if (++checks < 3) throw new Error("offline");
        return { state: "completed", payload };
      },
      cancel: async () => {},
    },
    (view) => {
      latest = view;
    },
    timer,
    () => id,
  );
  await session.prepare(); await session.start(request);
  await tick();
  timer.advance(91_000);
  timer.run();
  await tick();
  assert.equal(latest.phase, "unknown");
  assert.equal(latest.canCancel, true);
  session.resume();
  await tick();
  assert.equal(latest.phase, "completed");
  session.close();
});

test("a lost cancellation retains the task id so cancellation can be retried without resubmitting", async () => {
  let latest,
    attempts = 0,
    created = 0;
  const pending = deferred();
  const session = new QuerySession(
    {
      scope,
      create: async () => {
        created++;
        return { id };
      },
      status: () => pending.promise,
      cancel: async () => {
        if (++attempts === 1) throw new Error("offline");
      },
    },
    (view) => {
      latest = view;
    },
    clock(),
    () => id,
  );
  await session.prepare(); await session.start(request);
  await session.cancel();
  assert.equal(latest.phase, "unknown");
  assert.equal(latest.canCancel, true);
  await session.prepare(); await session.start(request);
  assert.equal(created, 1);
  await session.cancel();
  assert.equal(attempts, 2);
  assert.equal(latest.phase, "cancelled");
  pending.resolve({ state: "completed", payload });
  await tick();
  assert.equal(latest.result, null);
  session.close();
});

test("lost creation acknowledgement retries the same request without creating another task", async () => {
  const timer = clock();
  const seen = [];
  let latest;
  const session = new QuerySession({
    scope,
    create: async (item) => {
      seen.push(structuredClone(item));
      if (seen.length === 1) throw new Error("response lost after commit");
      return { id: item.requestId };
    },
    status: async () => ({ state: "completed", payload }),
    cancel: async () => {},
  }, (view) => { latest = view; }, timer, () => id);
  await session.prepare(); await session.start(request);
  assert.equal(latest.phase, "reconnecting");
  await session.prepare(); await session.start(request);
  assert.equal(seen.length, 1);
  timer.run();
  await tick();
  assert.equal(latest.phase, "completed");
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[0].requestId, id);
  session.close();
});

test("long creation outage retains request ID and resumes the same submission", async () => {
  const timer = clock();
  let latest, attempts = 0;
  const ids = [];
  const session = new QuerySession({
    scope,
    create: async (item) => { ids.push(item.requestId); if (++attempts < 3) throw new Error("offline"); return { id: item.requestId }; },
    status: async () => ({ state: "completed", payload }),
    cancel: async () => {},
  }, (view) => { latest = view; }, timer, () => id);
  await session.prepare(); await session.start(request);
  timer.advance(91_000); timer.run(); await tick();
  assert.equal(latest.phase, "unknown");
  await session.prepare(); await session.start(request);
  assert.equal(attempts, 2);
  session.resume(); await tick();
  assert.equal(latest.phase, "completed");
  assert.deepEqual(ids, [id, id, id]);
  session.close();
});

test("creation retries stop after two minutes even after repeated manual recovery", async () => {
  const timer = clock();
  let latest, attempts = 0;
  const session = new QuerySession({
    scope,
    create: async () => { attempts++; throw new Error("offline"); },
    status: async () => { throw new Error("unexpected"); },
    cancel: async () => {},
  }, (view) => { latest = view; }, timer, () => id);
  await session.prepare(); await session.start(request);
  timer.advance(91_000); timer.run(); await tick();
  assert.equal(latest.phase, "unknown");
  timer.advance(20_000); session.resume(); await tick();
  assert.equal(latest.phase, "unknown");
  assert.equal(attempts, 3);
  timer.advance(10_000); session.resume(); await tick();
  assert.equal(latest.phase, "failed");
  assert.match(latest.message, /可能已经执行/);
  assert.equal(attempts, 3);
  session.close();
});

test("authorization is acquired before submission and never refreshed after intent", async () => {
  const timer = clock();
  const times = [];
  let created;
  const session = new QuerySession({
    scope: async () => { times.push("scope"); if (times.length === 1) throw new Error("offline"); return scope(); },
    create: async (item) => { created = item; return { id: item.requestId }; },
    status: async () => ({ state: "completed", payload }),
    cancel: async () => {},
  }, () => {}, timer, () => id);
  await session.prepare();
  await session.start(request);
  assert.equal(created, undefined);
  await session.prepare();
  timer.advance(1000);
  await session.start(request);
  assert.deepEqual(times, ["scope", "scope"]);
  assert.equal(created.submittedAt, 1000);
  assert.equal(created.requestId, id);
  assert.equal(created.scopeToken, "fixture-scope-token");
  session.close();
});

test("a late authorization response cannot submit after leaving the page", async () => {
  const pending = deferred();
  let created = 0;
  const session = new QuerySession({
    scope: () => pending.promise,
    create: async () => { created++; return { id }; },
    status: async () => ({ state: "running" }),
    cancel: async () => {},
  }, () => {}, clock(), () => id);
  const preparing = session.prepare();
  session.close();
  pending.resolve(await scope());
  await preparing;
  await session.start(request);
  assert.equal(created, 0);
});

test("explicit capacity rejection stops retrying and gives an actionable reason", async () => {
  for (const code of ["CAPACITY", "RESULT_CAPACITY"]) {
    const timer = clock();
    let latest, attempts = 0;
    const session = new QuerySession({
      scope,
      create: async () => { attempts++; throw new ApiError(503, "fixture", code); },
      status: async () => { throw new Error("unexpected"); },
      cancel: async () => {},
    }, (view) => { latest = view; }, timer, () => id);
    await session.prepare(); await session.start(request);
    assert.equal(latest.phase, "failed");
    assert.match(latest.message, code === "CAPACITY" ? /等待已有任务/ : /清除不再需要的结果/);
    timer.run(); session.resume(); await tick();
    assert.equal(attempts, 1);
    session.close();
  }
});

test("generic 503 still retries the same request identity", async () => {
  const timer = clock();
  let latest;
  const attempts = [];
  const session = new QuerySession({
    scope,
    create: async (item) => { attempts.push(structuredClone(item)); if (attempts.length === 1) throw new ApiError(503, "unavailable"); return { id: item.requestId }; },
    status: async () => ({ state: "completed", payload }),
    cancel: async () => {},
  }, (view) => { latest = view; }, timer, () => id);
  await session.prepare(); await session.start(request);
  assert.equal(latest.phase, "reconnecting");
  timer.run(); await tick();
  assert.equal(latest.phase, "completed");
  assert.deepEqual(attempts[0], attempts[1]);
  session.close();
});

test("an oversized request fails promptly without retrying", async () => {
  const timer = clock();
  let latest, attempts = 0;
  const session = new QuerySession({
    scope,
    create: async () => { attempts++; throw new ApiError(413, "too large"); },
    status: async () => { throw new Error("unexpected"); },
    cancel: async () => {},
  }, (view) => { latest = view; }, timer, () => id);
  await session.prepare(); await session.start(request);
  assert.equal(latest.phase, "failed");
  assert.match(latest.message, /SQL 和参数内容过大/);
  timer.run(); session.resume(); await tick();
  assert.equal(attempts, 1);
  session.close();
});

test("scope or instance change rejects an old intent without an automatic new query", async () => {
  let latest, attempts = 0;
  const session = new QuerySession({
    scope,
    create: async () => { attempts++; throw new ApiError(409, "stale"); },
    status: async () => { throw new Error("unexpected"); },
    cancel: async () => {},
  }, (view) => { latest = view; }, clock(), () => id);
  await session.prepare(); await session.start(request); await tick();
  assert.equal(latest.phase, "failed");
  assert.match(latest.message, /刷新页面/);
  session.resume(); await tick();
  assert.equal(attempts, 1);
  session.close();
});

test("clearing a displayed result releases server storage and reports failure", async () => {
  let latest;
  const released = [];
  const session = new QuerySession({
    scope,
    create: async (item) => ({ id: item.requestId }),
    status: async () => ({ state: "completed", payload }),
    cancel: async (value) => { released.push(value); throw new Error("offline"); },
  }, (view) => { latest = view; }, clock(), () => id);
  await session.prepare(); await session.start(request); await tick();
  assert.equal(latest.phase, "completed");
  session.clear(); await tick();
  assert.equal(latest.result, null);
  assert.match(latest.notice, /暂未清除/);
  assert.deepEqual(released, [id]);
  session.close();
});

test("starting another query or leaving releases the previous result", async () => {
  let latest;
  const ids = [id, "22222222-2222-4222-8222-222222222222"];
  const released = [];
  const session = new QuerySession({
    scope,
    create: async (item) => ({ id: item.requestId }),
    status: async () => ({ state: "completed", payload }),
    cancel: async (value) => { released.push(value); },
  }, (view) => { latest = view; }, clock(), () => ids.shift());
  await session.prepare(); await session.start(request); await tick();
  assert.equal(latest.phase, "completed");
  await session.prepare(); await session.start(request); await tick();
  assert.equal(latest.phase, "completed");
  session.close(); await tick();
  assert.deepEqual(released, [id, "22222222-2222-4222-8222-222222222222"]);
});
