import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ReadJobs } from "../src/queries/jobs.js";

const scope = {
  ownerId: "owner",
  connectorId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333",
};
const parameters = [{ kind: "integer", value: "1" }];

test("read jobs bind scope, suppress sensitive input, and reject late results after cancellation", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = jobs.create(
    scope,
    randomUUID(),
    "SELECT id FROM customers WHERE id = ?",
    parameters,
    10,
  );
  assert.deepEqual(jobs.status(scope, id), { state: "queued" });
  assert.equal(jobs.status({ ...scope, ownerId: "other" }, id), null);
  assert.equal(jobs.claim("44444444-4444-4444-8444-444444444444"), null);
  const work = jobs.claim(scope.connectorId);
  assert.ok(work && work.type === "read");
  assert.equal(work.task.id, id);
  assert.deepEqual(jobs.status(scope, id), { state: "running" });
  assert.equal(
    jobs.cancel({ ...scope, workspaceId: "44444444-4444-4444-8444-444444444444" }, id),
    false,
  );
  assert.equal(jobs.cancel(scope, id), true);
  const cancel = jobs.claim(scope.connectorId);
  assert.ok(cancel && cancel.type === "cancel");
  assert.equal(cancel.task.taskId, id);
  assert.equal(jobs.complete(scope, id, "failed", "error"), false);
  assert.equal(jobs.claim(scope.connectorId), null);
  assert.deepEqual(jobs.status(scope, id), { state: "cancelled" });
});

test("only bounded well-formed result data can be published", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  jobs.claim(scope.connectorId);
  const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url");
  const valid = {
    columns: [{ name: "id", type: "INT" }],
    rows: [[{ null: false, encoding: "text", value: "1" }]],
    timezone: "UTC",
    truncated: false,
  };
  assert.throws(() =>
    jobs.complete(scope, id, "ok", encode({ ...valid, rows: [...valid.rows, ...valid.rows] })),
  );
  assert.throws(() =>
    jobs.complete(
      scope,
      id,
      "ok",
      encode({ ...valid, rows: [[{ null: false, encoding: "base64", value: "%%%" }]] }),
    ),
  );
  assert.throws(() => jobs.complete(scope, id, "failed", "raw error with secrets"));
  assert.equal(jobs.complete(scope, id, "ok", encode(valid)), true);
  assert.equal(jobs.complete(scope, id, "ok", encode(valid)), false);
  assert.equal(jobs.status(scope, id)?.state, "completed");
  assert.equal(
    jobs.status({ ...scope, sourceId: "44444444-4444-4444-8444-444444444444" }, id),
    null,
  );
});

test("expired and queued cancelled jobs release sensitive payload and enforce capacity", () => {
  let now = 1_000_000;
  const jobs = new ReadJobs(() => now);
  const first = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  assert.equal(jobs.cancel(scope, first), true);
  assert.equal(jobs.claim(scope.connectorId), null);
  const next = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  now += 61_000;
  assert.equal(jobs.status(scope, next)?.state, "expired");
  assert.equal(jobs.claim(scope.connectorId), null);
  now += 300_000;
  jobs.prune();
  assert.equal(jobs.status(scope, next), null);
  const ids: string[] = [];
  for (let i = 0; i < 16; i++)
    ids.push(jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1));
  assert.throws(
    () => jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1),
    /CAPACITY/,
  );
  assert.ok(ids[0]);
  assert.equal(jobs.cancel(scope, ids[0]), true);
  assert.doesNotThrow(() => jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1));
});

test("revoking a scope discards completed results and cancels only matching work", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const completed = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  jobs.claim(scope.connectorId);
  const result = Buffer.from(
    JSON.stringify({
      columns: [{ name: "id", type: "INT" }],
      rows: [],
      timezone: "UTC",
      truncated: false,
    }),
  ).toString("base64url");
  assert.equal(jobs.complete(scope, completed, "ok", result), true);
  const pending = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  const other = { ...scope, sourceId: "44444444-4444-4444-8444-444444444444" };
  const unaffected = jobs.create(other, randomUUID(), "SELECT id FROM customers", [], 1);
  jobs.cancelMatching(scope.ownerId, scope.workspaceId, scope.sourceId);
  assert.deepEqual(jobs.status(scope, completed), { state: "cancelled" });
  assert.deepEqual(jobs.status(scope, pending), { state: "cancelled" });
  assert.deepEqual(jobs.status(other, unaffected), { state: "queued" });
  jobs.close();
});

test("revoking a connector clears pending cancellation and discards late results", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1);
  jobs.claim(scope.connectorId);
  assert.equal(jobs.busy(scope.connectorId), true);
  jobs.revokeConnector(scope.ownerId, scope.connectorId);
  assert.equal(jobs.busy(scope.connectorId), false);
  assert.deepEqual(jobs.status(scope, id), { state: "cancelled" });
  assert.equal(jobs.complete(scope, id, "failed", "error"), false);
  jobs.close();
});

test("request IDs are scoped, idempotent and reject changed content", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = randomUUID();
  assert.equal(jobs.create(scope, id, "SELECT id FROM customers", [], 1), id);
  assert.equal(jobs.create(scope, id, "SELECT id FROM customers", [], 1), id);
  assert.throws(() => jobs.create(scope, id, "SELECT name FROM customers", [], 1), /CONFLICT/);
  assert.throws(
    () => jobs.create({ ...scope, ownerId: "other" }, id, "SELECT id FROM customers", [], 1),
    /CONFLICT/,
  );
  const work = jobs.claim(scope.connectorId);
  assert.ok(work?.type === "read");
  assert.equal(work.task.id, id);
  assert.equal(jobs.complete(scope, id, "failed", "error"), true);
  assert.equal(jobs.create(scope, id, "SELECT id FROM customers", [], 1), id);
  assert.deepEqual(jobs.status(scope, id), { state: "failed", payload: "error" });
  assert.equal(jobs.claim(scope.connectorId), null);
  jobs.close();
});

test("cancellation arriving before creation prevents late POST from executing", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = randomUUID();
  assert.equal(jobs.cancel(scope, id), true);
  assert.equal(jobs.cancel(scope, id), true);
  assert.equal(jobs.create(scope, id, "SELECT id FROM customers", [], 1), id);
  assert.deepEqual(jobs.status(scope, id), { state: "cancelled" });
  assert.equal(jobs.claim(scope.connectorId), null);
  assert.throws(
    () => jobs.create({ ...scope, ownerId: "other" }, id, "SELECT id FROM customers", [], 1),
    /CONFLICT/,
  );
  jobs.close();
});

test("finished work releases active slots while result retention remains bounded", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const ids: string[] = [];
  const result = Buffer.from(
    JSON.stringify({
      columns: [{ name: "id", type: "INT" }],
      rows: [],
      timezone: "UTC",
      truncated: false,
    }),
  ).toString("base64url");
  for (let i = 0; i < 32; i++) {
    const id = randomUUID();
    ids.push(id);
    jobs.create(scope, id, "SELECT id FROM customers", [], 1);
    const work = jobs.claim(scope.connectorId);
    assert.ok(work?.type === "read");
    assert.equal(work.task.id, id);
    assert.equal(jobs.complete(scope, id, "ok", result), true);
  }
  const first = ids[0],
    last = ids[31];
  assert.ok(first && last);
  assert.deepEqual(jobs.status(scope, first), { state: "completed", payload: result });
  assert.deepEqual(jobs.status(scope, last), { state: "completed", payload: result });
  assert.equal(jobs.create(scope, first, "SELECT id FROM customers", [], 1), first);
  assert.throws(
    () => jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1),
    /RESULT_CAPACITY/,
  );
  assert.equal(jobs.cancel(scope, first), true);
  assert.deepEqual(jobs.status(scope, first), { state: "expired" });
  assert.doesNotThrow(() => jobs.create(scope, randomUUID(), "SELECT id FROM customers", [], 1));
  // The released ID remains reserved and never creates another execution.
  assert.equal(jobs.create(scope, first, "SELECT id FROM customers", [], 1), first);
  jobs.close();
});

test("an unconfirmed heartbeat reissues exactly the same task until completion", () => {
  const jobs = new ReadJobs(() => 1_000_000);
  const id = randomUUID();
  jobs.create(scope, id, "SELECT id FROM customers", [], 1);
  const first = jobs.claim(scope.connectorId);
  const retry = jobs.claim(scope.connectorId);
  assert.deepEqual(retry, first);
  assert.equal(jobs.complete(scope, id, "failed", "error"), true);
  assert.equal(jobs.claim(scope.connectorId), null);
  jobs.close();
});
