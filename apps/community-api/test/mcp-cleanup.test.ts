import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InvocationCleanup, type InvocationCleanupIntent } from "../src/mcp/invocation-cleanup.js";
test("cleanup retries retain only the original metadata intent and bound physical IO separately", async () => {
  let healthy = false,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const sent: InvocationCleanupIntent[] = [];
  const q = new InvocationCleanup(async (i) => {
    calls++;
    if (calls <= 2) await gate;
    if (!healthy) throw Error("synthetic storage failure");
    sent.push(i);
  });
  const ids = Array.from({ length: 9 }, () => randomUUID());
  for (const id of ids)
    q.enqueue({
      ownerId: "owner",
      id,
      grantId: randomUUID(),
      generation: 1,
      bootId: randomUUID(),
      commitment: "a".repeat(64),
      pending: "cancelled",
      running: "outcome_unknown",
      approvalSessionId: null,
    });
  assert.deepEqual(q.health(), {
    pending: 9,
    outstanding: 2,
    capacity: 2,
    readers: 0,
    projections: 0,
  });
  assert.equal(calls, 2);
  const first = ids[0];
  assert.ok(first);
  q.enqueue({
    ownerId: "owner",
    id: first,
    grantId: "other",
    generation: 2,
    bootId: "other",
    commitment: "other",
    pending: "failed",
    running: "failed",
    approvalSessionId: null,
  });
  assert.equal(q.project("owner", first, "running"), "outcome_unknown");
  assert.equal(q.project("different", first, "running"), "running");
  healthy = true;
  release();
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(q.size, 0);
  assert.equal(sent.length, 9);
  assert.ok(sent.every((i) => i.generation === 1 && i.pending === "cancelled"));
});

test("failed cleanup write preserves the first terminal intent for a later retry", async () => {
  let available = false,
    delivered: InvocationCleanupIntent | undefined;
  const q = new InvocationCleanup(async (intent) => {
    if (!available) throw Error("synthetic outage");
    delivered = intent;
  });
  const intent: InvocationCleanupIntent = {
    ownerId: "owner",
    id: randomUUID(),
    grantId: randomUUID(),
    generation: 1,
    bootId: randomUUID(),
    commitment: "b".repeat(64),
    pending: "failed",
    running: "outcome_unknown",
    approvalSessionId: null,
  };
  q.enqueue(intent);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(q.size, 1);
  assert.equal(q.health().outstanding, 0);
  q.enqueue({ ...intent, pending: "cancelled", running: "cancelled" });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(q.project("owner", intent.id, "pending_approval"), "failed");
  available = true;
  q.tick();
  await q.settle();
  assert.equal(q.size, 0);
  assert.equal(delivered?.pending, "failed");
  assert.equal(delivered?.running, "outcome_unknown");
});

test("failing rows do not starve unrelated cleanup intents", async () => {
  const ids: string[] = Array.from({ length: 4 }, () => randomUUID()),
    attempted: string[] = [];
  const q = new InvocationCleanup(async (intent) => {
    attempted.push(intent.id);
    if (ids.slice(0, 2).includes(intent.id)) throw Error("row-specific outage");
  });
  for (const id of ids)
    q.enqueue({
      ownerId: "owner",
      id,
      grantId: randomUUID(),
      generation: 1,
      bootId: randomUUID(),
      commitment: "c".repeat(64),
      pending: "expired",
      running: "outcome_unknown",
      approvalSessionId: null,
    });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(q.size, 4);
  q.tick();
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(ids.slice(2).every((id) => attempted.includes(id)));
  assert.equal(q.size, 2);
  assert.equal(q.health().outstanding, 0);
});

test("late snapshots preserve a completed cleanup projection until the old read ends", async () => {
  const id = randomUUID();
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const q = new InvocationCleanup(async () => {});
  const reading = q.read(
    async () => {
      await gate;
      return { state: "running" };
    },
    (row) => q.project("owner", id, row.state),
  );
  q.enqueue({
    ownerId: "owner",
    id,
    grantId: randomUUID(),
    generation: 1,
    bootId: randomUUID(),
    commitment: "d".repeat(64),
    pending: "cancelled",
    running: "outcome_unknown",
    approvalSessionId: null,
  });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(q.health().pending, 0);
  assert.equal(q.health().projections, 1);
  assert.equal(q.size, 1);
  resume();
  assert.equal(await reading, "outcome_unknown");
  assert.equal(q.health().projections, 0);
  assert.equal(q.health().readers, 0);
  assert.equal(q.size, 0);
});

test("shutdown drain actively retries recovered storage within its bounded window", async () => {
  let available = false,
    delivered = false;
  const q = new InvocationCleanup(async () => {
    if (!available) throw Error("synthetic outage");
    delivered = true;
  });
  q.enqueue({
    ownerId: "owner",
    id: randomUUID(),
    grantId: randomUUID(),
    generation: 1,
    bootId: randomUUID(),
    commitment: "e".repeat(64),
    pending: "failed",
    running: "failed",
    approvalSessionId: null,
  });
  await new Promise<void>((r) => setImmediate(r));
  const recovering = setTimeout(() => {
    available = true;
  }, 60);
  try {
    await q.settle(500);
    assert.equal(delivered, true);
    assert.equal(q.size, 0);
  } finally {
    clearTimeout(recovering);
  }
});

test("metadata snapshot waits have a bounded admission limit", async () => {
  const q = new InvocationCleanup(async () => {});
  let resume!: () => void;
  const gate = new Promise<void>((r) => {
    resume = r;
  });
  const reads = Array.from({ length: 64 }, () =>
    q.read(
      () => gate,
      () => true,
    ),
  );
  try {
    await assert.rejects(
      () =>
        q.read(
          () => gate,
          () => true,
        ),
      /MCP_METADATA_READ_CAPACITY/,
    );
    assert.equal(q.health().readers, 64);
  } finally {
    resume();
    await Promise.all(reads);
  }
  assert.equal(q.health().readers, 0);
});

test("cleanup retries run while an unrelated reservation is still unsettled", async () => {
  let available = false,
    delivered = false;
  const q = new InvocationCleanup(async () => {
    if (!available) throw Error("synthetic outage");
    delivered = true;
  });
  q.enqueue({
    ownerId: "owner",
    id: randomUUID(),
    grantId: randomUUID(),
    generation: 1,
    bootId: randomUUID(),
    commitment: "f".repeat(64),
    pending: "cancelled",
    running: "cancelled",
    approvalSessionId: null,
  });
  await new Promise<void>((r) => setImmediate(r));
  const pendingRegistration = new Promise<void>(() => {}),
    recover = setTimeout(() => {
      available = true;
    }, 50);
  const started = performance.now();
  try {
    await q.settle(250, [pendingRegistration]);
    assert.equal(delivered, true);
    assert.equal(q.health().pending, 0);
    assert.ok(performance.now() - started < 1000);
  } finally {
    clearTimeout(recover);
  }
});
