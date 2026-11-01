import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mutationPayload, type MutationMessage } from "../src/connectors/mutation-protocol.js";
import { ConnectorMutationTransport } from "../src/mutations/connector-transport.js";
import type { MutationExecution } from "../src/mutations/model.js";
import type { MutationAccess } from "../src/mutations/ports.js";

test("closing while a task is being signed never republishes its sensitive payload", async () => {
  const binding = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const access: MutationAccess = {
    async authenticate() {
      return undefined;
    },
    async withScope(_scope, operation) {
      return operation(binding);
    },
  };
  const channel = new ConnectorMutationTransport(
    {
      async signMutationMessage(message) {
        await held;
        return { ...message, signature: "A".repeat(86) };
      },
    },
    access,
  );
  const request = channel.capability(binding, "a".repeat(64));
  const rejected = assert.rejects(
    request,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNAVAILABLE",
  );
  channel.close();
  release();
  await rejected;
  assert.equal(await channel.next(binding.connectorId, []), null);
  await assert.rejects(channel.capability(binding, "a".repeat(64)));
});

test("a task too large for the nested signed poll reply is rejected before queueing", async () => {
  const binding = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const access: MutationAccess = {
    async authenticate() {
      return undefined;
    },
    async withScope(_scope, operation) {
      return operation(binding);
    },
  };
  const channel = new ConnectorMutationTransport(
    {
      async signMutationMessage(message) {
        return { ...message, signature: "A".repeat(86) };
      },
    },
    access,
  );
  try {
    await assert.rejects(
      channel.preview(binding, "a".repeat(64), {
        operation: "insert",
        table: "orders",
        rows: [[{ column: "label", value: { kind: "string", value: "x".repeat(900_000) } }]],
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CAPACITY",
    );
    assert.equal(await channel.next(binding.connectorId, []), null);
  } finally {
    channel.close();
  }
});

test("status polling cannot starve an earlier confirmed execution; retries yield to new work", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const binding = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const execution: MutationExecution = {
    ...binding,
    previewId: randomUUID(),
    executionId: randomUUID(),
    confirmationId: randomUUID(),
    commitment: "A".repeat(43),
    revision: 1,
    apiBoot: "a".repeat(64),
    connectorBoot: "b".repeat(64),
    targetIdentity: "isolated-target",
    targetEpoch: "c".repeat(64),
    policyGeneration: "policy-1",
    installationGeneration: "install-1",
    operation: "update",
    table: "orders",
    rowCount: 1,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    sessionId: "private-session",
    state: "registered",
    cancelRequested: false,
    permitIssued: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    code: null,
    reconciliationExpiresAt: null,
    affectedRows: null,
  };
  const access: MutationAccess = {
    async authenticate() {
      return undefined;
    },
    async withScope(_scope, operation) {
      return operation(binding);
    },
  };
  const channel = new ConnectorMutationTransport(
    {
      async signMutationMessage(message) {
        return { ...message, signature: "A".repeat(86) };
      },
    },
    access,
  );
  t.after(() => channel.close());
  const polled: Promise<unknown>[] = [];
  const status = async () => {
    // Attach rejection immediately: close deliberately rejects unfinished work.
    polled.push(channel.status(binding, execution).catch(() => undefined));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await channel.execute(binding, execution);
  await status();
  const first = await channel.next(binding.connectorId, []);
  assert.equal(first?.operation, "execute");
  assert.equal(JSON.stringify(first).includes("private-session"), false);
  // With the reply missing and more status requests arriving, new work gets a
  // turn rather than the old dispatch taking every poll.
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(2_000);
    if (i < 2) await status();
    const next = await channel.next(binding.connectorId, []);
    assert.equal(next?.operation, "status");
  }
  t.mock.timers.tick(2_000);
  assert.equal((await channel.next(binding.connectorId, []))?.id, first?.id);
  assert.ok(first);
  const {
    sessionId: _session,
    confirmationId: _confirmation,
    operation: _operation,
    table: _table,
    rowCount: _rows,
    expiresAt: _expiry,
    state: _state,
    cancelRequested: _cancel,
    permitIssued: _permit,
    createdAt: _created,
    updatedAt: _updated,
    code: _code,
    reconciliationExpiresAt: _reconciliation,
    affectedRows: _affected,
    ...receiptBinding
  } = execution;
  const reply: MutationMessage = {
    ...first,
    kind: "result",
    replyTo: first.nonce,
    payload: mutationPayload({
      ok: true,
      result: { ...receiptBinding, state: "committed", code: "", rowCount: 1 },
    }),
  };
  await channel.accept(reply);
  channel.close();
  await Promise.all(polled);
});
