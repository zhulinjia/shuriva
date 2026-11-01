import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeChatPlan } from "../src/chat/chat-plan.ts";

const plan = {
  kind: "query",
  explanation: "按编号查询",
  sql: "SELECT `id` FROM `items`",
  parameters: [],
  maxRows: 10,
  schemaVersion: "a".repeat(64),
};

test("a complete AI plan keeps its structure binding", () => {
  assert.deepEqual(decodeChatPlan(plan), plan);
  assert.deepEqual(decodeChatPlan({ kind: "clarification", question: "需要哪个编号？" }), {
    kind: "clarification",
    question: "需要哪个编号？",
  });
});

test("AI plans with missing or malformed structure bindings cannot become manual queries", () => {
  const { schemaVersion: _removed, ...without } = plan;
  for (const value of [
    without,
    { ...plan, schemaVersion: null },
    { ...plan, schemaVersion: "A".repeat(64) },
    { ...plan, schemaVersion: "short" },
    { ...plan, extra: "x" },
  ]) {
    assert.throws(() => decodeChatPlan(value), /invalid model plan/);
  }
});

test("AI plan result rejects malformed parameters or unexpected structures", () => {
  assert.throws(() => decodeChatPlan({ ...plan, parameters: [{ kind: "number", value: "1" }] }));
  assert.throws(() =>
    decodeChatPlan({ ...plan, parameters: [{ kind: "string", value: "x", extra: true }] }),
  );
  assert.throws(() => decodeChatPlan({ ...plan, maxRows: 1001 }));
  assert.throws(() => decodeChatPlan({ kind: "clarification", question: "" }));
});
