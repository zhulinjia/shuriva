import assert from "node:assert/strict";
import { test } from "node:test";
import { semanticDisclosure } from "../src/semantic/disclosure.js";
import { emptySemanticDocument } from "../src/semantic/model.js";

test("semantic disclosure intersects connector authorization and excludes sensitive descriptions and fields", () => {
  const schema = {
    database: "demo",
    tables: [
      {
        name: "customers",
        columns: [
          { name: "id", type: "int" },
          { name: "email", type: "varchar" },
        ],
      },
    ],
  };
  const common = { description: "业务解释", aliases: ["别名"], sensitivity: "normal" as const };
  const doc = {
    ...emptySemanticDocument(),
    entities: [
      { ...common, name: "客户", table: "customers" },
      { ...common, name: "不授权的表", table: "private" },
    ],
    fields: [
      { ...common, name: "编号", table: "customers", column: "id", type: "int" },
      {
        ...common,
        name: "电子邮件秘密",
        table: "customers",
        column: "email",
        type: "varchar(50)",
        sensitivity: "sensitive" as const,
      },
      { ...common, name: "不存在", table: "customers", column: "secret", type: "int" },
    ],
    metrics: [
      {
        ...common,
        name: "邮箱数量",
        field: { table: "customers", column: "email", type: "varchar(50)" },
        aggregation: "count" as const,
      },
    ],
  };
  const result = semanticDisclosure(schema, doc);
  assert.deepEqual(result.schema.tables[0]?.columns, [{ name: "id", type: "int" }]);
  assert.deepEqual(
    result.semantics.fields.map((field) => field.name),
    ["编号"],
  );
  assert.equal(result.semantics.entities.length, 1);
  assert.equal(result.semantics.metrics.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /电子邮件秘密|不授权的表|不存在|邮箱数量|email/);
  assert.throws(
    () =>
      semanticDisclosure(schema, {
        ...doc,
        entities: [{ ...common, name: "客户", table: "customers", sensitivity: "sensitive" }],
      }),
    /NO_MODEL_FIELDS/,
  );
});
