import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactContent,
  changedParameterKind,
  decodeArtifact,
  decodeConversation,
  decodeHistoryCapability,
  parameterInputs,
  restoreArtifact,
  sameConversation,
} from "../src/history-model.ts";

const id = "11111111-1111-4111-8111-111111111111";
const definition = {
  name: "客户查询", kind: "query", sql: "SELECT id FROM customers WHERE city = ?",
  parameters: [{ kind: "string", value: "保密值" }], maxRows: 100,
  schemaVersion: "a".repeat(64), notes: "说明", visualization: { kind: "table" },
};
const record = (content) => ({ id, revision: 7, content, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deletedAt: null });

test("unknown history capability cannot silently bypass export auditing", () => {
  assert.equal(decodeHistoryCapability({enabled:true}),true);
  assert.equal(decodeHistoryCapability({enabled:false}),false);
  for(const input of [{},{enabled:"false"},{enabled:null},null])assert.throws(()=>decodeHistoryCapability(input));
});

test("saved definitions retain kinds and an explicit SQL definition, excluding values and raw results", () => {
  const content = artifactContent({ ...definition, rows: [{ private: "secret row" }], token: "secret token" });
  assert.deepEqual(content.parameterKinds, ["string"]);
  assert.deepEqual(Object.keys(content).sort(), ["name", "kind", "sql", "parameterKinds", "maxRows", "schemaVersion", "notes", "chart"].sort());
  assert.equal(JSON.stringify(content).includes("保密值"), false);
  assert.equal(JSON.stringify(content).includes("secret"), false);
});

test("reopening an artifact clears every parameter and never recovers injected values or cached rows", () => {
  const content = artifactContent(definition);
  const draft = restoreArtifact(record({ ...content, parameterValues: ["secret"], rows: [["private"]] }));
  assert.deepEqual(draft.parameters, [{ kind: "string", value: "" }]);
  assert.equal(draft.requiresParameterInput, true);
  assert.deepEqual(parameterInputs(draft), [{ kind: "string", value: "", needsInput: true }]);
  assert.equal(JSON.stringify(draft).includes("secret"), false);
  assert.equal(JSON.stringify(draft).includes("private"), false);
});

test("restored text and boolean inputs require a fresh decision; changing type cannot invent a true value", () => {
  for (const kind of ["string", "integer", "decimal", "boolean"]) {
    assert.deepEqual(changedParameterKind(kind), { kind, value: "", needsInput: true });
  }
  assert.deepEqual(changedParameterKind("null"), { kind: "null", value: "", needsInput: false });
  assert.deepEqual(parameterInputs({ ...restoreArtifact(record(artifactContent(definition))), parameters: [{ kind: "boolean", value: "true" }] }), [{ kind: "boolean", value: "", needsInput: true }]);
});

test("a chart round trip keeps only the chart definition, and reopening does not invent result rows", () => {
  const content = artifactContent({ ...definition, kind: "chart", visualization: { kind: "line", x: "month", y: "total" } });
  assert.deepEqual(content.chart, { type: "line", x: "month", y: "total" });
  const draft = restoreArtifact(record(content));
  assert.deepEqual(draft.visualization, { kind: "line", x: "month", y: "total" });
  assert.equal("rows" in draft, false);
  assert.throws(() => artifactContent({ ...definition, kind: "chart" }));
  assert.throws(() => decodeArtifact({ ...content, chart: { ...content.chart, y: "" } }));
});

test("history payloads reject invalid kinds, revisions of schema and duplicate or privileged conversation roles", () => {
  const content = artifactContent(definition);
  assert.throws(() => decodeArtifact({ ...content, parameterKinds: ["password"] }));
  assert.throws(() => decodeArtifact({ ...content, schemaVersion: "untrusted" }));
  assert.throws(() => decodeArtifact({ ...content, maxRows: 1001 }));
  assert.throws(() => decodeArtifact({ ...content, name: " " }));
  const message = { id, role: "user", text: "问题" };
  assert.throws(() => decodeConversation({ title: "会话", messages: [message, message] }));
  assert.throws(() => decodeConversation({ title: "会话", messages: [{ ...message, role: "system" }] }));
});

test("an uncertain save reconciles reordered MySQL JSON, but never acknowledges concurrent content as its own", () => {
  const expected = { title: "会话", messages: [{ id, role: "user", text: "问题" }] };
  assert.equal(sameConversation(expected, { messages: [{ text: "问题", role: "user", id }], title: "会话" }), true);
  assert.equal(sameConversation(expected, { ...expected, title: "另一页修改" }), false);
  assert.equal(sameConversation(expected, { ...expected, messages: [{ ...expected.messages[0], text: "另一页的问题" }] }), false);
  assert.equal(sameConversation(null, expected), false);
  assert.equal(sameConversation(expected, { ...expected, messages: [{ ...expected.messages[0], role: "system" }] }), false);
});
