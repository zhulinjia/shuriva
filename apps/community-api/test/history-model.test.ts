import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseHistoryContent } from "../src/history/model.js";

test("history definitions reject parameter values and raw audit content while preserving conversation messages", () => {
  const conversation = {
    title: "本机对话",
    messages: [{ id: randomUUID(), role: "user", text: "业务问题" }],
  };
  assert.deepEqual(parseHistoryContent("conversation", conversation), conversation);
  assert.throws(() =>
    parseHistoryContent("conversation", {
      ...conversation,
      messages: [...conversation.messages, ...conversation.messages],
    }),
  );
  const artifact = {
    name: "余额查询",
    kind: "query",
    sql: "SELECT id FROM customers WHERE id=?",
    parameterKinds: ["integer"],
    maxRows: 100,
    schemaVersion: null,
    notes: "",
    chart: null,
  };
  assert.deepEqual(parseHistoryContent("artifact", artifact), artifact);
  assert.throws(() =>
    parseHistoryContent("artifact", {
      ...artifact,
      parameters: [{ kind: "integer", value: "secret" }],
    }),
  );
  assert.throws(() =>
    parseHistoryContent("artifact", { ...artifact, chart: { type: "bar", x: "id", y: "balance" } }),
  );
  assert.throws(() =>
    parseHistoryContent("audit", {
      event: "query.failed",
      outcome: "failure",
      error: "private-token",
    }),
  );
  assert.throws(() =>
    parseHistoryContent("audit", {
      event: "query.failed",
      outcome: "failure",
      sql: "SELECT secret FROM customers",
    }),
  );
});
