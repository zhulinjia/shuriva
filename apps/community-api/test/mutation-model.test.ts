import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationPlanSchema } from "../src/mutations/model.js";

test("mutation plans admit only bounded typed structured operations", () => {
  assert.equal(
    mutationPlanSchema.parse({
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    }).operation,
    "delete",
  );
  for (const input of [
    { operation: "delete", table: "customers", where: [] },
    { operation: "delete", table: "customers", where: [{ column: "id", operator: "eq" }] },
    {
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "is_null", value: { kind: "null", value: "" } }],
    },
    {
      operation: "insert",
      table: "customers",
      rows: [
        [
          { column: "id", value: { kind: "integer", value: "1" } },
          { column: "id", value: { kind: "integer", value: "2" } },
        ],
      ],
    },
    {
      operation: "delete",
      table: "customers",
      sql: "DELETE FROM customers",
      where: [{ column: "id", operator: "is_null" }],
    },
  ])
    assert.equal(mutationPlanSchema.safeParse(input).success, false);
});

test("mutation value and assignment limits match the complete Connector boundary without truncation", () => {
  const plan = (value: string) => ({
    operation: "insert",
    table: "items",
    rows: [[{ column: "label", value: { kind: "string", value } }]],
  });
  assert.equal(mutationPlanSchema.safeParse(plan("a".repeat(32768))).success, true);
  assert.equal(mutationPlanSchema.safeParse(plan("a".repeat(32769))).success, false);
  assert.equal(mutationPlanSchema.safeParse(plan("汉".repeat(10922))).success, true);
  assert.equal(mutationPlanSchema.safeParse(plan("汉".repeat(10923))).success, false);
  const fields = Array.from({ length: 256 }, (_value, index) => ({
    column: `field${index}`,
    value: { kind: "string", value: "x" },
  }));
  assert.equal(
    mutationPlanSchema.safeParse({ operation: "insert", table: "items", rows: [fields] }).success,
    true,
  );
  assert.equal(
    mutationPlanSchema.safeParse({
      operation: "insert",
      table: "items",
      rows: [[...fields, { column: "one_too_many", value: { kind: "string", value: "x" } }]],
    }).success,
    false,
  );
});
