import assert from "node:assert/strict";
import { test } from "node:test";
import { MutationController } from "../src/mutations/controller.ts";
import { parseExecution, parsePreview } from "../src/mutations/client.ts";
import { buildPlan, emptyDraft, mayConfirm, canCancel } from "../src/mutations/model.ts";

const previewId = "11111111-1111-4111-8111-111111111111";
const executionId = "22222222-2222-4222-8222-222222222222";
const confirmationId = "33333333-3333-4333-8333-333333333333";
const capability = {
  enabled: true,
  available: true,
  executionEnabled: true,
  code: "ready",
  tables: ["customers"],
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
const plan = {
  operation: "delete",
  table: "customers",
  where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "9007199254740993" } }],
};
const record = {
  ...preview,
  rows: undefined,
  executionId,
  confirmationId,
  state: "registered",
  permitIssued: false,
  cancelRequested: false,
  reconciliationExpiresAt: null,
  affectedRows: null,
  code: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
function client(overrides = {}) {
  return {
    dispose() {},
    capability: async () => capability,
    preview: async () => preview,
    confirm: async () => record,
    lookup: async () => ({ state: "registered", execution: record }),
    close: async () => ({ state: "closed", execution: null }),
    executions: async () => ({ items: [], nextCursor: null }),
    recover: async () => ({ items: [], nextCursor: null }),
    execution: async () => record,
    cancel: async () => ({ ...record, cancelRequested: true }),
    receipts: async () => ({ items: [], nextCursor: null, metadataError: null }),
    ...overrides,
  };
}
async function prepared(transport = client()) {
  const controller = new MutationController(
    transport,
    () => {},
    () => confirmationId,
  );
  await controller.prepare();
  assert.equal(controller.canDraft(), false); // A GET list is not a recovery barrier.
  await controller.recover();
  return controller;
}
test("delete confirmation requires explicit review, exact table, nonexpired preview and released execution", () => {
  assert.equal(mayConfirm(preview, capability, false, "customers"), false);
  assert.equal(mayConfirm(preview, capability, true, "other"), false);
  assert.equal(
    mayConfirm(preview, { ...capability, executionEnabled: false }, true, "customers"),
    false,
  );
  assert.equal(mayConfirm({ ...preview, rows: [] }, capability, true, "customers"), false);
  assert.equal(
    mayConfirm({ ...preview, expiresAt: "2020-01-01T00:00:00Z" }, capability, true, "customers"),
    false,
  );
  assert.equal(mayConfirm(preview, capability, true, "customers"), true);
  assert.equal(canCancel({ ...record, permitIssued: true }), false);
});
test("structured drafts preserve exact integers and reject missing targets or duplicate assignments", () => {
  const draft = emptyDraft();
  draft.table = "customers";
  draft.operation = "delete";
  draft.where[0] = { ...draft.where[0], column: "id", kind: "integer", value: "9007199254740993" };
  assert.equal(buildPlan(draft).where[0].value.value, "9007199254740993");
  assert.throws(() => buildPlan({ ...draft, where: [] }));
  draft.operation = "insert";
  const field = { id: "a", column: "id", kind: "integer", value: "1" };
  assert.throws(() => buildPlan({ ...draft, rows: [[field, { ...field, id: "b" }]] }));
});
test("lost confirmation response is queried with the original ID without a second submission", async () => {
  let dispatched = 0,
    lookedUp = 0;
  const controller = await prepared(
    client({
      confirm: async () => {
        dispatched++;
        throw Error("response lost");
      },
      lookup: async (id) => {
        assert.equal(id, confirmationId);
        return ++lookedUp === 1
          ? { state: "unseen", execution: null }
          : { state: "registered", execution: record };
      },
    }),
  );
  await controller.preview(plan);
  await controller.confirm();
  assert.equal(controller.snapshot().phase, "reconciling");
  assert.equal(controller.snapshot().pending.confirmationId, confirmationId);
  await controller.confirm();
  await controller.preview(plan);
  await controller.recover();
  await controller.prepare();
  await controller.refresh(executionId);
  controller.newDraft();
  assert.equal(controller.snapshot().phase, "reconciling");
  assert.equal(dispatched, 1);
  await controller.lookup();
  assert.equal(controller.snapshot().phase, "reconciling");
  assert.match(controller.snapshot().message, /尚未见登记/);
  await controller.lookup();
  assert.equal(controller.snapshot().selected.executionId, executionId);
  assert.equal(dispatched, 1);
});
test("editing first seals the real old preview and lost close reply remains pending", async () => {
  let closed = 0;
  const controller = await prepared(
    client({
      close: async (intent) => {
        closed++;
        assert.equal(intent.previewId, previewId);
        throw Error("close reply lost");
      },
      lookup: async () => ({ state: "closed", execution: null }),
    }),
  );
  await controller.preview(plan);
  await controller.edit();
  assert.equal(closed, 1);
  assert.equal(controller.snapshot().phase, "reconciling");
  assert.equal(controller.canDraft(), false);
  await controller.lookup();
  assert.equal(controller.snapshot().phase, "draft");
  assert.equal(controller.snapshot().preview, null);
});
test("unknown remains frozen after a later matching committed result and permits no cancel after permit", async () => {
  let cancellations = 0;
  let state = "outcome_unknown";
  const controller = await prepared(
    client({
      execution: async () => ({ ...record, state, permitIssued: true }),
      cancel: async () => {
        cancellations++;
        return record;
      },
    }),
  );
  await controller.refresh(executionId);
  assert.equal(controller.snapshot().selected.executionId, executionId);
  assert.equal(controller.canDraft(), false);
  state = "committed";
  await controller.refresh();
  controller.newDraft();
  await controller.cancel();
  assert.equal(controller.snapshot().phase, "execution");
  assert.equal(controller.canDraft(), false);
  assert.equal(cancellations, 0);
});
test("orphan target receipts block new drafts and do not fabricate confirmation records", async () => {
  const controller = await prepared(
    client({
      recover: async () => ({
        items: [],
        nextCursor: null,
        recoveredReceipts: [{ executionId, rowCount: 1, targetIdentity: "target" }],
        receiptCursor: null,
        metadataError: "orphaned_receipt",
      }),
    }),
  );
  assert.equal(controller.snapshot().records.length, 0);
  assert.equal(controller.snapshot().receipts[0].executionId, executionId);
  assert.equal(controller.canDraft(), false);
  assert.equal(controller.snapshot().selected, null);
});
test("receipt discovery must finish every page before the UI allows a new draft", async () => {
  const controller = await prepared(
    client({
      recover: async () => ({
        items: [],
        nextCursor: null,
        recoveredReceipts: [],
        receiptCursor: executionId,
        metadataError: null,
      }),
      receipts: async (after) => {
        assert.equal(after, executionId);
        return { items: [], nextCursor: null, metadataError: null };
      },
    }),
  );
  assert.equal(controller.canDraft(), false);
  await controller.moreReceipts();
  assert.equal(controller.canDraft(), true);
});
test("closing a controller suppresses late responses without cancelling or redelivering the target task", async () => {
  let resolve;
  let disposed = 0;
  let updates = 0,
    confirms = 0;
  const late = new Promise((yes) => {
    resolve = yes;
  });
  const controller = new MutationController(
    client({
      dispose() { disposed++; },
      preview: async () => late,
      confirm: async () => {
        confirms++;
        return record;
      },
    }),
    () => {
      updates++;
    },
    () => confirmationId,
  );
  await controller.prepare();
  await controller.recover();
  const pending = controller.preview(plan);
  controller.close();
  controller.close();
  assert.equal(disposed, 1);
  const previous = controller.snapshot();
  const previousUpdates = updates;
  resolve(preview);
  await pending;
  await controller.confirm();
  assert.deepEqual(controller.snapshot(), previous);
  assert.equal(confirms, 0);
  assert.equal(updates, previousUpdates);
});
test("preview and status boundary reject truncated targets, unknown states and malformed values", () => {
  assert.equal(parsePreview(preview).rows[0].before.id.value, "9007199254740993");
  assert.throws(() => parsePreview({ ...preview, rowCount: 2 }));
  assert.throws(() =>
    parsePreview({
      ...preview,
      rows: [{ before: { id: { kind: "javascript", value: "alert(1)" } }, after: null }],
    }),
  );
  assert.throws(() => parseExecution({ ...record, state: "success" }));
  assert.equal(parseExecution(record).executionId, executionId);
  const insert = parsePreview({
    ...preview,
    operation: "insert",
    rows: [
      {
        before: null,
        after: { status: { kind: "string", value: "active" } },
        generatedColumns: ["id"],
        defaultColumns: ["status"],
      },
    ],
  });
  assert.deepEqual(insert.rows[0].generatedColumns, ["id"]);
  assert.throws(() =>
    parsePreview({
      ...preview,
      operation: "insert",
      rows: [
        { before: null, after: { id: { kind: "integer", value: "1" } }, generatedColumns: ["id"] },
      ],
    }),
  );
});
