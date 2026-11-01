import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMutationAICandidate, decodeMutationAIReview, mutationSemanticLines } from "../src/mutations/ai-client.ts";
import { buildPlan, draftFromPlan } from "../src/mutations/model.ts";

const candidate = { kind: "mutation", explanation: "等待完整预览", plan: { operation: "update", table: "customers", changes: [{ column: "balance", value: { kind: "decimal", value: "9007199254740993.01" } }], where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "9007199254740993" } }] } };
const semantics = { entities: [{ name: "客户", description: "当前客户资料", aliases: ["用户"], table: "customers" }], fields: [{ name: "余额", description: "精确金额", aliases: [], table: "customers", column: "balance" }], relationships: [], metrics: [] };
const review = { ticketId: "11111111-1111-4111-8111-111111111111", disclosureHash: "a".repeat(43), question: "名称改为内部测试值", expiresAt: "2099-01-01T00:00:00.000Z", destination: { baseUrl: "https://model.example/v1", model: "test-model", configVersion: "version" }, schema: { database: "isolated", tables: [{ name: "customers", columns: [{ name: "id", type: "bigint" }, { name: "balance", type: "decimal" }] }] }, writeScope: { customers: { insert: ["balance"], update: ["balance"], filter: ["id"], delete: false } }, semantics };

test("loading an AI candidate only creates an editable exact-value draft", () => {
  const parsed = decodeMutationAICandidate(candidate);
  const draft = draftFromPlan(parsed.plan);
  assert.deepEqual(buildPlan(draft), candidate.plan);
  assert.equal(draft.where[0].value, "9007199254740993");
  assert.equal(draft.changes[0].value, "9007199254740993.01");
  assert.notEqual(draft.changes[0].id, draft.where[0].id);
  const deleted = { operation: "delete", table: "customers", where: [{ column: "balance", operator: "is_null" }] };
  assert.deepEqual(buildPlan(draftFromPlan(deleted)), deleted);
  const inserted = { operation: "insert", table: "customers", rows: [candidate.plan.changes] };
  assert.deepEqual(buildPlan(draftFromPlan(inserted)), inserted);
});

test("AI response boundary rejects raw SQL, unknown fields, truncated plans and oversized values", () => {
  for (const plan of [
    { ...candidate.plan, sql: "UPDATE customers SET balance=0" },
    { ...candidate.plan, changes: [] },
    { ...candidate.plan, where: [] },
    { ...candidate.plan, changes: [{ column: "balance", value: { kind: "expression", value: "balance+1" } }] },
    { ...candidate.plan, changes: [{ column: "balance", value: { kind: "string", value: "字".repeat(11000) } }] },
  ]) assert.throws(() => decodeMutationAICandidate({ ...candidate, plan }));
  assert.throws(() => decodeMutationAICandidate({ kind: "clarification", question: "" }));
  assert.deepEqual(decodeMutationAICandidate({ kind: "clarification", question: "需要修改哪一行？" }), { kind: "clarification", question: "需要修改哪一行？" });
});

test("disclosure preserves exact question, destination, fields, allowed operations and every business description", () => {
  const parsed = decodeMutationAIReview(review);
  assert.equal(parsed.question, review.question);
  assert.deepEqual(parsed.destination, review.destination);
  assert.deepEqual(parsed.schema, review.schema);
  assert.deepEqual(parsed.writeScope.customers, review.writeScope.customers);
  const lines = mutationSemanticLines(parsed.semantics);
  assert.match(lines[0].text, /customers.*客户.*当前客户资料.*用户/);
  assert.match(lines[1].text, /customers.balance.*余额.*精确金额/);
  assert.throws(() => decodeMutationAIReview({ ...review, disclosureHash: "truncated" }));
  assert.throws(() => decodeMutationAIReview({ ...review, semantics: { ...semantics, secret: "undisclosed data" } }));
  assert.throws(() => decodeMutationAIReview({ ...review, writeScope: {} }));
});
