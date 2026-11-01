import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createApprovalHandoff as createSupportedHandoff } from "../src/mcp/approval-handoff.js";
import {
  type ApprovalBinding,
  createApprovalHandoffCore,
} from "../src/mcp/approval-handoff-core.js";

const createApprovalHandoff = (
  key: Buffer,
  options: { monotonic?: () => number; wall?: () => number; ttlMs?: number } = {},
) =>
  createApprovalHandoffCore(key, {
    ...options,
    monotonic: options.monotonic ?? (() => performance.now()),
  });

const binding = () => ({
  grantId: randomUUID(),
  generation: 1,
  requestId: randomUUID(),
  toolVersion: "query.v1",
});

test("handoff copies and binds payload and rejects malformed runtime inputs", (t) => {
  const vault = createApprovalHandoff(randomBytes(32));
  t.after(() => vault.close());
  const target = binding(),
    payload = Buffer.from("synthetic private parameter");
  const { commitment } = vault.stage(target, payload);
  payload.fill(0);
  assert.equal(vault.take({ ...target, generation: 2 }, commitment), null);
  assert.equal(vault.take(target, "0".repeat(64)), null);
  assert.equal(vault.take(target, [commitment] as unknown as string), null);
  assert.throws(
    () =>
      vault.stage({ ...target, toolVersion: [49] } as unknown as ApprovalBinding, Buffer.from("x")),
    /MCP_HANDOFF_INVALID/,
  );
  assert.equal(vault.take(target, commitment)?.toString(), "synthetic private parameter");
  assert.equal(vault.take(target, commitment), null);
  vault.close();
  assert.throws(() => vault.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_CLOSED/);
});

test("wall expiry after a suspended monotonic clock and stale discard fail closed", (t) => {
  let mono = 1,
    wall = 1000;
  const vault = createApprovalHandoff(randomBytes(32), { monotonic: () => mono, wall: () => wall });
  t.after(() => vault.close());
  const first = binding(),
    old = vault.stage(first, Buffer.from("x"));
  assert.throws(() => vault.stage(first, Buffer.from("changed")), /MCP_HANDOFF_DUPLICATE/);
  wall += 120_000;
  assert.equal(vault.take(first, old.commitment), null);
  const next = vault.stage(first, Buffer.from("x"));
  old.discard();
  assert.equal(vault.take(first, next.commitment)?.toString(), "x");
  const backward = vault.stage(first, Buffer.from("x"));
  wall--;
  assert.throws(() => vault.take(first, backward.commitment), /MCP_HANDOFF_CLOCK_INVALID/);
  assert.equal(vault.size(), 0);
  mono++;
});

test("limits apply across vaults and independently bound entry count", (t) => {
  const a = createApprovalHandoff(randomBytes(32)),
    b = createApprovalHandoff(randomBytes(32));
  t.after(() => {
    a.close();
    b.close();
  });
  assert.throws(() => a.stage(binding(), Buffer.alloc(32769)), /MCP_HANDOFF_INVALID/);
  for (let i = 0; i < 64; i++) (i % 2 ? a : b).stage(binding(), Buffer.alloc(32768));
  assert.throws(() => b.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_FULL/);
  a.close();
  b.close();
  const c = createApprovalHandoff(randomBytes(32));
  t.after(() => c.close());
  for (let i = 0; i < 128; i++) c.stage(binding(), Buffer.from("x"));
  assert.throws(() => c.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_FULL/);
});

test("idle entries are cleared by the timer without a take or stage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  let samples = 0;
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 20,
    monotonic: () => {
      samples++;
      return now;
    },
    wall: () => now + 1000,
  });
  t.after(() => vault.close());
  vault.stage(binding(), Buffer.from("x"));
  now = 20;
  t.mock.timers.tick(20);
  assert.equal(vault.size(), 0);
  const stoppedAt = samples;
  now = 80;
  t.mock.timers.tick(60);
  assert.equal(samples, stoppedAt);
  vault.stage(binding(), Buffer.from("x"));
  assert.ok(samples > stoppedAt);
  now = 100;
  t.mock.timers.tick(20);
  assert.equal(vault.size(), 0);
});

test("staggered entries are cleaned at their own deadlines", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 300,
    monotonic: () => 1,
    wall: () => 1,
  });
  t.after(() => vault.close());
  vault.stage(binding(), Buffer.from("first"));
  t.mock.timers.tick(100);
  vault.stage(binding(), Buffer.from("second"));
  t.mock.timers.tick(250);
  assert.equal(vault.size(), 1);
  t.mock.timers.tick(150);
  assert.equal(vault.size(), 0);
});

test("staging rejects content that expires while its timer is being armed", (t) => {
  let samples = 0;
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 300,
    monotonic: () => (samples++ === 0 ? 0 : 301),
    wall: () => 1000,
  });
  t.after(() => vault.close());
  assert.throws(() => vault.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_EXPIRED/);
  assert.equal(vault.size(), 0);
});

test("staging rechecks expiry after arming the cleanup timer", (t) => {
  let samples = 0;
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 300,
    monotonic: () => (++samples < 3 ? 0 : 301),
    wall: () => 1000,
  });
  t.after(() => vault.close());
  assert.throws(() => vault.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_EXPIRED/);
  assert.equal(vault.size(), 0);
});

test("the final expiry check uses the pre-arm deadline after a delayed registration", (t) => {
  let samples = 0;
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 300,
    monotonic: () => [0, 299, 301][Math.min(samples++, 2)] ?? 301,
    wall: () => 1000,
  });
  t.after(() => vault.close());
  assert.throws(() => vault.stage(binding(), Buffer.from("x")), /MCP_HANDOFF_EXPIRED/);
  assert.equal(vault.size(), 0);
});

test("public factory rejects unsupported platforms regardless of test clock support", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    assert.throws(
      () =>
        Reflect.apply(createSupportedHandoff, undefined, [randomBytes(32), { monotonic: () => 0 }]),
      /MCP_HANDOFF_PLATFORM_UNSUPPORTED/,
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("cleanup timer uses the remaining lifetime after delayed staging", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let samples = 0;
  const vault = createApprovalHandoff(randomBytes(32), {
    ttlMs: 300,
    monotonic: () => {
      if (samples++ === 0) return 0;
      if (samples === 2) t.mock.timers.tick(150);
      return 150;
    },
    wall: () => 1000,
  });
  t.after(() => vault.close());
  vault.stage(binding(), Buffer.from("x"));
  t.mock.timers.tick(149);
  assert.equal(vault.size(), 1);
  t.mock.timers.tick(1);
  assert.equal(vault.size(), 0);
});

test("a clock exception clears staged sensitive entries", (t) => {
  let failed = false;
  const vault = createApprovalHandoff(randomBytes(32), {
    monotonic: () => {
      if (failed) throw new Error("clock failed");
      return 1;
    },
  });
  t.after(() => vault.close());
  const target = binding(),
    item = vault.stage(target, Buffer.from("x"));
  failed = true;
  assert.throws(() => vault.take(target, item.commitment), /MCP_HANDOFF_CLOCK_INVALID/);
  assert.equal(vault.size(), 0);
});

test("an observed wall-clock regression after an advance clears entries", (t) => {
  let wall = 1000;
  const vault = createApprovalHandoff(randomBytes(32), { monotonic: () => 1, wall: () => wall });
  t.after(() => vault.close());
  const target = binding(),
    item = vault.stage(target, Buffer.from("x"));
  wall += 90_000;
  assert.equal(vault.take(target, "0".repeat(64)), null);
  wall -= 60_000;
  assert.throws(() => vault.take(target, item.commitment), /MCP_HANDOFF_CLOCK_INVALID/);
  assert.equal(vault.size(), 0);
});

test("worker isolates cannot bypass the process quota", async () => {
  const worker = new Worker(
    new URL("../../test/fixtures/mcp-approval-worker.mjs", import.meta.url),
  );
  const result = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.equal(result, "MCP_HANDOFF_WORKER_UNSUPPORTED");
  await worker.terminate();
});

test("commitments bind every field, payload, key, and unambiguous framing", () => {
  const key = randomBytes(32),
    first = binding(),
    content = Buffer.from("same content");
  const digest = (target: ApprovalBinding, body: Buffer, secret = key) => {
    const vault = createApprovalHandoff(secret);
    try {
      return vault.stage(target, body).commitment;
    } finally {
      vault.close();
    }
  };
  const initial = digest(first, content);
  for (const changed of [
    { ...first, grantId: randomUUID() },
    { ...first, requestId: randomUUID() },
    { ...first, generation: 2 },
    { ...first, toolVersion: "query.v2" },
  ])
    assert.notEqual(initial, digest(changed, content));
  assert.notEqual(initial, digest(first, Buffer.from("changed")));
  assert.notEqual(initial, digest(first, content, randomBytes(32)));
  assert.notEqual(
    digest({ ...first, toolVersion: "x" }, Buffer.from("yz")),
    digest({ ...first, toolVersion: "xy" }, Buffer.from("z")),
  );
  assert.throws(() => createApprovalHandoff(Buffer.alloc(31)), /MCP_HANDOFF_KEY_INVALID/);
});
