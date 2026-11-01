import assert from "node:assert/strict";
import { test } from "node:test";
import { schemaChanges } from "../src/datasources/schema-diff.ts";

test("schema comparison reports additions, removals, changed fields and foreign keys", () => {
  const old = {
    database: "fixture",
    serverVersion: "test",
    tables: [{ name: "customers", kind: "BASE TABLE" }],
    columns: [
      { table: "customers", name: "id", type: "int", nullable: false, position: 1 },
      { table: "customers", name: "old", type: "int", nullable: true, position: 2 },
    ],
    relations: [],
    externalRelationsOmitted: 0,
  };
  const next = {
    database: "fixture",
    serverVersion: "test",
    tables: [
      { name: "customers", kind: "BASE TABLE" },
      { name: "orders", kind: "BASE TABLE" },
    ],
    columns: [
      { table: "customers", name: "id", type: "bigint", nullable: false, position: 1 },
      { table: "orders", name: "customer_id", type: "int", nullable: false, position: 1 },
    ],
    relations: [
      {
        table: "orders",
        column: "customer_id",
        referencedTable: "customers",
        referencedColumn: "id",
        constraint: "fk",
        position: 1,
      },
    ],
    externalRelationsOmitted: 1,
  };
  const changes = schemaChanges(next, old);
  assert.ok(changes.includes("新增表或视图：orders"));
  assert.ok(changes.includes("字段定义变化：customers.id"));
  assert.ok(changes.includes("移除字段：customers.old"));
  assert.ok(changes.some((line) => line.startsWith("新增关系：orders.customer_id")));
  assert.ok(changes.some((line) => line.includes("范围外关系")));
  assert.deepEqual(schemaChanges(old, old), []);
  assert.ok(
    schemaChanges({ ...old, database: "other" }, old).includes("数据库名称变化：fixture → other"),
  );
});
