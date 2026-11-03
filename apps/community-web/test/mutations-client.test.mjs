import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { mutationClient } from "../src/mutations/client.ts";
import { MutationController } from "../src/mutations/controller.ts";

const workspace = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const previewId = "33333333-3333-4333-8333-333333333333";
const confirmationId = "44444444-4444-4444-8444-444444444444";
const executionId = "55555555-5555-4555-8555-555555555555";
const plan = {
  operation: "delete",
  table: "customers",
  where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "9007199254740993" } }],
};
const preview = {
  previewId,
  commitment: "a".repeat(43),
  revision: 1,
  operation: "delete",
  table: "customers",
  rowCount: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  rows: [{ before: { id: { kind: "integer", value: "9007199254740993" } }, after: null }],
};
const intent = { confirmationId, previewId, commitment: preview.commitment, revision: 1 };
const capability = {
  enabled: true,
  available: true,
  executionEnabled: true,
  code: "ready",
  tables: ["customers"],
};
const record = {
  ...intent,
  executionId,
  operation: "delete",
  table: "customers",
  rowCount: 1,
  expiresAt: preview.expiresAt,
  state: "registered",
  permitIssued: false,
  cancelRequested: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  reconciliationExpiresAt: null,
  affectedRows: null,
  code: null,
};

async function fixture(handler, timeoutMs = 200) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = mutationClient(workspace, source, {
    requestTimeoutMs: timeoutMs,
    fetch: (url, options) => fetch(new URL(url, `http://127.0.0.1:${address.port}`), options),
  });
  return {
    client,
    async close() {
      client.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function eventually(check) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(check(), true);
}
function json(res, value) {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

test("every mutation endpoint times out against a real server that never responds, with no automatic retry", async () => {
  let requests = 0,
    closed = 0;
  const f = await fixture((_req, res) => {
    requests++;
    res.once("close", () => closed++);
  }, 500);
  try {
    const results = await Promise.allSettled([
      f.client.capability(),
      f.client.preview(plan),
      f.client.confirm(intent),
      f.client.lookup(confirmationId),
      f.client.close(intent),
      f.client.executions(),
      f.client.recover(),
      f.client.execution(executionId),
      f.client.cancel(executionId),
      f.client.receipts(),
    ]);
    assert.equal(results.length, 10);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /超时.*原操作.*核对/);
    }
    assert.equal(requests, 10);
    await eventually(() => closed === 10);
  } finally {
    await f.close();
  }
});

test("the same deadline covers an incomplete response body and releases the panel's busy state", async () => {
  let closed = 0;
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"enabled":true,');
    res.once("close", () => closed++);
  });
  const controller = new MutationController(f.client, () => {});
  try {
    await controller.prepare();
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().phase, "recovery");
    assert.equal(controller.snapshot().capability, null);
    assert.match(controller.snapshot().message, /执行历史读取失败/);
    await eventually(() => closed === 2);
  } finally {
    controller.close();
    await f.close();
  }
});

test("closing a controller aborts browser IO without sending a database cancellation or accepting late results", async () => {
  let signalRequest;
  const started = new Promise((resolve) => {
    signalRequest = resolve;
  });
  const paths = [];
  let closed = 0,
    updates = 0;
  const f = await fixture((req, res) => {
    paths.push(req.url);
    res.once("close", () => closed++);
    signalRequest();
  }, 2000);
  const controller = new MutationController(f.client, () => updates++);
  try {
    const operation = controller.prepare();
    await started;
    await eventually(() => paths.length === 2);
    controller.close();
    const snapshot = controller.snapshot(),
      observed = updates;
    await operation;
    assert.deepEqual(controller.snapshot(), snapshot);
    assert.equal(updates, observed);
    await eventually(() => closed === 2);
    await assert.rejects(() => f.client.capability(), /网络等待.*不代表.*取消/);
    assert.equal(paths.length, 2);
    assert.ok(paths.some((path) => /\/capability$/.test(path)));
    assert.ok(paths.some((path) => /\/executions$/.test(path)));
  } finally {
    controller.close();
    await f.close();
  }
});

test("a confirmation body timeout preserves its original identity and can only reconcile it, never submit twice", async () => {
  const confirmations = [],
    lookups = [];
  const f = await fixture(async (req, res) => {
    if (req.url.endsWith("/capability")) {
      json(res, capability);
      return;
    }
    if (req.url.endsWith("/executions") || req.url.endsWith("/recovery")) {
      json(res, { items: [], nextCursor: null });
      return;
    }
    if (req.url.endsWith("/previews")) {
      json(res, preview);
      return;
    }
    if (req.url.endsWith("/confirm")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      confirmations.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"executionId":');
      return;
    }
    if (req.url.includes("/confirmations/")) {
      lookups.push(req.url);
      json(res, { state: "registered", execution: record });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const controller = new MutationController(
    f.client,
    () => {},
    () => confirmationId,
  );
  try {
    await controller.prepare();
    await controller.recover();
    await controller.preview(plan);
    await controller.confirm();
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().phase, "reconciling");
    assert.deepEqual(controller.snapshot().pending, intent);
    assert.equal(confirmations.length, 1);
    await controller.confirm();
    await controller.preview(plan);
    await controller.recover();
    controller.newDraft();
    assert.equal(confirmations.length, 1);
    await controller.lookup();
    assert.equal(lookups.length, 1);
    assert.match(lookups[0], new RegExp(`/confirmations/${confirmationId}$`));
    assert.equal(controller.snapshot().selected.confirmationId, confirmationId);
    assert.equal(controller.snapshot().selected.executionId, executionId);
    assert.equal(confirmations.length, 1);
  } finally {
    controller.close();
    await f.close();
  }
});

test("bounded responses still pass the typed JSON boundary without coercing invalid authorization flags", async () => {
  let requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    json(res, { ...capability, executionEnabled: "true" });
  });
  try {
    await assert.rejects(() => f.client.capability(), /数据不完整/);
    assert.equal(requests, 1);
  } finally {
    await f.close();
  }
});
