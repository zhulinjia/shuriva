import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCandidate } from "../src/ai/plan.js";

const scope = new Map([["customers", new Set(["id", "name", "city"])]]);
const query = {
  kind: "query",
  explanation: "查找符合条件的客户",
  table: "customers",
  columns: ["id", "name"],
  filters: [
    { column: "id", operator: "eq", parameter: { kind: "integer", value: "18446744073709551615" } },
    { column: "city", operator: "is_null" },
  ],
  orderBy: [{ column: "name", direction: "asc" }],
  maxRows: 100,
};

test("a bounded authorized candidate compiles into a parameterized read plan", () => {
  assert.deepEqual(validateCandidate(query, scope), {
    kind: "query",
    explanation: "查找符合条件的客户",
    table: "customers",
    sql: "SELECT `id`, `name` FROM `customers` WHERE `id` = ? AND `city` IS NULL ORDER BY `name` ASC",
    parameters: [{ kind: "integer", value: "18446744073709551615" }],
    maxRows: 100,
  });
  assert.deepEqual(
    validateCandidate({ kind: "clarification", question: "要查询哪个城市？" }, scope),
    {
      kind: "clarification",
      question: "要查询哪个城市？",
    },
  );
});

test("untrusted plans cannot smuggle SQL or exceed authorization in any clause", () => {
  const bad = [
    { ...query, table: "customers; DROP TABLE customers" },
    { ...query, table: "private_table" },
    { ...query, columns: ["id", "password"] },
    { ...query, columns: ["id", "id"] },
    { ...query, filters: [{ column: "password", operator: "is_null" }] },
    { ...query, orderBy: [{ column: "password", direction: "asc" }] },
    {
      ...query,
      filters: [
        { column: "id", operator: "eq OR 1=1", parameter: { kind: "integer", value: "1" } },
      ],
    },
    { ...query, sql: "DELETE FROM customers" },
    { ...query, maxRows: 1001 },
  ];
  for (const candidate of bad) assert.throws(() => validateCandidate(candidate, scope));
});

test("parameter values remain data, null comparisons are explicit, and integers are bounded", () => {
  const filter = (operator: string, kind: string, value: string) => ({
    ...query,
    filters: [{ column: "name", operator, parameter: { kind, value } }],
  });
  const plan = validateCandidate(filter("eq", "string", "x' OR 1=1 --"), scope);
  assert.equal(plan.kind, "query");
  if (plan.kind === "query") {
    assert.ok(!plan.sql.includes("OR 1=1"));
    assert.equal(plan.parameters[0]?.value, "x' OR 1=1 --");
  }
  assert.throws(() => validateCandidate(filter("eq", "null", ""), scope));
  assert.doesNotThrow(() => validateCandidate(filter("null_safe_eq", "null", ""), scope));
  assert.throws(() => validateCandidate(filter("eq", "integer", "18446744073709551616"), scope));
  assert.throws(() => validateCandidate(filter("eq", "integer", "-9223372036854775809"), scope));
});
