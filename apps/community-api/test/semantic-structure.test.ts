import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySemanticDocument } from "../src/semantic/model.js";
import { assertSemanticStructure, semanticStructureHash } from "../src/semantic/structure.js";
import { decodeModelSchema } from "../src/ai/schema.js";

const snapshot = {
  database: "demo",
  tables: [{ name: "customers", kind: "BASE TABLE" }],
  columns: [
    { table: "customers", name: "name", type: "varchar(50)", nullable: false, position: 1 },
  ],
};
const doc = {
  ...emptySemanticDocument(),
  fields: [
    {
      name: "客户名称",
      description: "业务说明",
      aliases: [],
      sensitivity: "normal" as const,
      table: "customers",
      column: "name",
      type: "varchar(50)",
    },
  ],
};

test("fresh exact structure rejects unscanned same-base-type changes, nullability and database identity changes", () => {
  const oldHash = semanticStructureHash(snapshot, "customers");
  const column = snapshot.columns[0];
  assert.ok(column);
  assert.equal(oldHash, "2874096940f6d2228080e404bb588b60ff2f8da74fadeb8bc8d749f3f721606c");
  assert.doesNotThrow(() =>
    assertSemanticStructure(doc, snapshot, new Map([["customers", oldHash]])),
  );
  for (const changed of [
    { ...snapshot, columns: [{ ...column, type: "varchar(60)" }] },
    { ...snapshot, columns: [{ ...column, nullable: true }] },
    { ...snapshot, database: "another" },
  ]) {
    const fresh = semanticStructureHash(changed, "customers");
    assert.notEqual(fresh, oldHash);
    assert.throws(
      () => assertSemanticStructure(doc, snapshot, new Map([["customers", fresh]])),
      /STALE/,
    );
    assert.doesNotThrow(() =>
      assertSemanticStructure(doc, changed, new Map([["customers", fresh]])),
    );
  }
  assert.throws(
    () => assertSemanticStructure(doc, null, new Map([["customers", oldHash]])),
    /STALE/,
  );
});

test("Connector structure proof is mandatory but stripped from all model-facing schema", () => {
  const table = {
    name: "customers",
    columns: [{ name: "name", type: "varchar" }],
    version: "a".repeat(64),
  };
  assert.throws(() => decodeModelSchema({ database: "demo", tables: [table] }));
  const structureHash = semanticStructureHash(snapshot, "customers");
  const decoded = decodeModelSchema({ database: "demo", tables: [{ ...table, structureHash }] });
  assert.equal(decoded.structures.get("customers"), structureHash);
  assert.doesNotMatch(JSON.stringify(decoded.schema), /structureHash|version/);
});
