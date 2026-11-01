import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptySemanticDocument,
  semanticDocumentSchema,
  staleSemanticEntries,
} from "../src/semantic/model.js";

const snapshot = {
  database: "demo",
  tables: [
    { name: "orders", kind: "BASE TABLE" },
    { name: "customers", kind: "BASE TABLE" },
  ],
  columns: [
    { table: "orders", name: "amount", type: "decimal(12,2)", nullable: false, position: 1 },
    { table: "orders", name: "customer_id", type: "int", nullable: false, position: 2 },
    { table: "customers", name: "id", type: "int", nullable: false, position: 1 },
  ],
};
const named = {
  name: "订单金额",
  description: "实付金额",
  aliases: ["成交额"],
  sensitivity: "normal" as const,
};
const field = { table: "orders", column: "amount", type: "decimal(12,2)" };

test("semantic entries validate as bounded structured data and detect changed references", () => {
  const document = semanticDocumentSchema.parse({
    ...emptySemanticDocument(),
    entities: [{ ...named, table: "orders" }],
    fields: [{ ...named, ...field }],
    relationships: [
      {
        ...named,
        from: { table: "orders", column: "customer_id", type: "int" },
        to: { table: "customers", column: "id", type: "int" },
      },
    ],
    metrics: [{ ...named, field, aggregation: "sum" }],
  });
  assert.deepEqual(staleSemanticEntries(document, snapshot), []);
  assert.deepEqual(
    staleSemanticEntries(document, {
      ...snapshot,
      columns: snapshot.columns.filter((column) => column.name !== "amount"),
    }),
    ["字段：订单金额", "指标：订单金额"],
  );
  assert.deepEqual(
    staleSemanticEntries(document, { ...snapshot, tables: [{ name: "orders", kind: "VIEW" }] }),
    ["实体：订单金额", "字段：订单金额", "关系：订单金额", "指标：订单金额"],
  );
});

test("semantic identifiers are data, while references, unknown properties and duplicates are validated", () => {
  const base = { ...emptySemanticDocument(), fields: [{ ...named, ...field }] };
  assert.equal(semanticDocumentSchema.safeParse(base).success, true);
  const untrusted = semanticDocumentSchema.parse({
    ...base,
    fields: [{ ...named, ...field, column: "id; DROP TABLE orders" }],
  });
  assert.deepEqual(staleSemanticEntries(untrusted, snapshot), ["字段：订单金额"]);
  assert.equal(
    semanticDocumentSchema.safeParse({ ...base, fields: [{ ...named, ...field, sql: "SELECT 1" }] })
      .success,
    false,
  );
  assert.equal(
    semanticDocumentSchema.safeParse({ ...base, fields: [...base.fields, ...base.fields] }).success,
    false,
  );
  assert.equal(
    semanticDocumentSchema.safeParse({
      ...base,
      metrics: [{ ...named, field: { ...field, type: "varchar(50)" }, aggregation: "sum" }],
    }).success,
    false,
  );
});
