import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  readTaskSchema,
  readCancelSchema,
  readResultSchema,
  schemaTaskSchema,
  canonicalReadTaskFields,
  pairInputSchema,
  heartbeatInputSchema,
  readQueryPayloadSchema,
  validReadQueryResult,
  readFailureCodeSchema,
  canonicalReadResultAcknowledgement,
  connectorHeartbeatReplySchema,
  cancelReadWireTask,
  delegatedReadScopeSchema,
  validateCandidate,
} from "../dist/index.js";

test("model text and parameters enforce the UTF-8 byte budget", () => {
  const scope = new Map([["orders", new Set(["id"])]]);
  const question = "🚀".repeat(1024);
  assert.equal(validateCandidate({ kind: "clarification", question }, scope).question, question);
  assert.throws(
    () => validateCandidate({ kind: "clarification", question: question + "x" }, scope),
    /INVALID_PLAN/,
  );
  const query = {
    kind: "query",
    explanation: "Find the order",
    table: "orders",
    columns: ["id"],
    filters: [{ column: "id", operator: "eq", parameter: { kind: "string", value: question } }],
    orderBy: [],
    maxRows: 1,
  };
  assert.equal(validateCandidate(query, scope).parameters[0].value, question);
  query.filters[0].parameter.value += "x";
  assert.throws(() => validateCandidate(query, scope), /INVALID_PLAN/);
});

const id = "11111111-1111-4111-8111-111111111111";
const task = {
  id,
  connectorId: id,
  actorId: "owner",
  workspaceId: id,
  sourceId: id,
  operation: "read_query",
  payload: "c3ludGhldGlj",
  issuedAt: 1,
  expiresAt: 2,
  nonce: Buffer.alloc(32, 1).toString("base64url"),
  protocol: 1,
  signature: Buffer.alloc(64, 2).toString("base64url"),
};
test("public transport does not accept extra authorization claims or invalid lifetimes", () => {
  assert.deepEqual(readTaskSchema.parse(task), task);
  assert.equal(readTaskSchema.safeParse({ ...task, tenantAdmin: true }).success, false);
  assert.equal(readTaskSchema.safeParse({ ...task, expiresAt: 1 }).success, false);
  assert.equal(
    readTaskSchema.safeParse({ ...task, operation: "model_authorize", issuedAt: 1, expiresAt: 32 })
      .success,
    false,
  );
  assert.equal(schemaTaskSchema.safeParse(task).success, false);
});
test("canonical read signing order preserves the existing wire protocol", () => {
  const hash = (input) => createHash("sha256").update(input).digest("hex");
  assert.deepEqual(canonicalReadTaskFields(task, hash), [
    "connector-read-v1",
    "read-query",
    id,
    id,
    "owner",
    id,
    id,
    hash(task.payload),
    "1",
    "2",
    task.nonce,
    "1",
  ]);
});
test("handshake validates the actual canonical base64url Ed25519 wire format", () => {
  const pair = {
    pairingId: id,
    connectorId: id,
    name: "test",
    proof: task.nonce,
    publicKey: task.nonce,
    agentVersion: "1.0.0",
    protocol: 2,
    signature: task.signature,
  };
  assert.equal(pairInputSchema.safeParse(pair).success, true);
  assert.equal(pairInputSchema.safeParse({ ...pair, signature: "b".repeat(64) }).success, false);
  assert.equal(
    heartbeatInputSchema.safeParse({
      connectorId: id,
      agentVersion: "1.0.0",
      protocol: 1,
      timestamp: 1,
      nonce: task.nonce,
      signature: task.signature,
    }).success,
    true,
  );
});
test("public schemas accept the same committed cross-language Connector vectors", async () => {
  const pair = JSON.parse(
    await readFile(new URL("../../../connector/testdata/pair-v2.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(pairInputSchema.parse(pair.pair), pair.pair);
  const read = JSON.parse(
    await readFile(new URL("../../../connector/testdata/read-task.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(readTaskSchema.parse(read.task), read.task);
  assert.deepEqual(readCancelSchema.parse(read.cancel), read.cancel);
  assert.deepEqual(readResultSchema.parse(read.result), read.result);
  const decoded = JSON.parse(Buffer.from(read.task.payload, "base64url").toString("utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(readQueryPayloadSchema.parse(decoded))), decoded);
  assert.deepEqual(canonicalReadResultAcknowledgement(read.result), [
    "connector-read-v1",
    "read-result-ack",
    read.result.connectorId,
    read.result.taskId,
    read.result.nonce,
    "1",
  ]);
  const cancel = cancelReadWireTask(read.cancel);
  assert.equal(cancel.id, read.cancel.taskId);
  assert.equal(cancel.signature, read.cancel.signature);
  assert.equal(Object.hasOwn(cancel, "taskId"), false);
  for (const wire of [null, read.task, cancel]) {
    assert.equal(
      connectorHeartbeatReplySchema.safeParse({
        ok: true,
        protocol: 1,
        signature: task.signature,
        task: wire,
      }).success,
      true,
    );
  }
});

test("read payload limits count UTF-8 bytes, retain precise parameters and require explicit scope", () => {
  const query = {
    sql: "SELECT id FROM orders WHERE id = ?",
    parameters: [{ kind: "integer", value: "9007199254740993" }],
    maxRows: 1,
    schemaVersion: null,
    delegatedScope: { orders: ["id"] },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(readQueryPayloadSchema.parse(query))), query);
  assert.equal(
    readQueryPayloadSchema.safeParse({ ...query, delegatedScope: undefined }).success,
    false,
  );
  assert.equal(
    readQueryPayloadSchema.safeParse({ ...query, sql: "中".repeat(5500) }).success,
    false,
  );
  assert.equal(
    readQueryPayloadSchema.safeParse({
      ...query,
      parameters: [{ kind: "string", value: "中".repeat(1366) }],
    }).success,
    false,
  );
  assert.equal(
    readQueryPayloadSchema.safeParse({ ...query, delegatedScope: { orders: ["id", "id"] } })
      .success,
    false,
  );
  assert.equal(readFailureCodeSchema.safeParse("internal-secret-error").success, false);
});

test("delegations preserve every own MySQL identifier without prototype mutation or silent validation loss", () => {
  const scope = JSON.parse('{"__proto__":["id"],"constructor":["value"],"orders":["id"]}');
  const parsed = delegatedReadScopeSchema.parse(scope);
  assert.deepEqual(Object.keys(parsed), Object.keys(scope));
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(Object.hasOwn(Object.prototype, "id"), false);
  assert.equal(JSON.stringify(parsed), JSON.stringify(scope));
  assert.equal(
    delegatedReadScopeSchema.safeParse(JSON.parse('{"__proto__":[],"orders":["id"]}')).success,
    false,
  );
  assert.equal(
    delegatedReadScopeSchema.safeParse(JSON.parse('{"__proto__":["id","id"],"orders":["id"]}'))
      .success,
    false,
  );
  assert.equal(
    delegatedReadScopeSchema.safeParse(
      JSON.parse('{"__proto__":{"polluted":true},"orders":["id"]}'),
    ).success,
    false,
  );
  assert.equal(
    delegatedReadScopeSchema.safeParse(Object.create({ inherited: ["id"] })).success,
    false,
  );
  assert.equal(
    delegatedReadScopeSchema.safeParse({ orders: ["id"], invalid_name: ["x".repeat(65)] }).success,
    false,
  );
});

test("result contract preserves byte/null semantics and rejects row/shape/truncation mismatches", () => {
  const result = {
    columns: [{ name: "id", type: "BIGINT" }],
    rows: [[{ null: false, encoding: "text", value: "9007199254740993" }]],
    timezone: "UTC",
    truncated: false,
  };
  assert.equal(validReadQueryResult(result, 1), true);
  assert.equal(
    validReadQueryResult({ ...result, rows: [...result.rows, ...result.rows] }, 1),
    false,
  );
  assert.equal(validReadQueryResult({ ...result, reason: "rows" }, 1), false);
  assert.equal(validReadQueryResult({ ...result, truncated: true }, 1), false);
  assert.equal(
    validReadQueryResult({ ...result, rows: [[{ null: true, value: "secret" }]] }, 1),
    false,
  );
  assert.equal(
    validReadQueryResult(
      { ...result, rows: [[{ null: false, encoding: "base64", value: "AB==" }]] },
      1,
    ),
    false,
  );
  assert.equal(
    validReadQueryResult(
      { ...result, rows: [[{ null: false, encoding: "base64", value: "AA==" }]] },
      1,
    ),
    true,
  );
});
