import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSnapshot } from "../src/datasources/snapshot.js";
import { DataSourceError } from "../src/datasources/store.js";

test("snapshot decoder rejects malformed, unexpected and unbound metadata", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const value = {
    database: "fixture",
    serverVersion: "fixture",
    tables: [{ name: "items", kind: "BASE TABLE" }],
    columns: [{ table: "items", name: "id", type: "int", nullable: false, position: 1 }],
    relations: [],
    externalRelationsOmitted: 0,
  };
  assert.deepEqual(decodeSnapshot(encode(value)), value);
  assert.throws(
    () => decodeSnapshot(encode({ ...value, password: "not-allowed" })),
    DataSourceError,
  );
  assert.throws(
    () => decodeSnapshot(encode({ ...value, columns: [{ ...value.columns[0], table: "other" }] })),
    DataSourceError,
  );
  assert.throws(() => decodeSnapshot("not valid base64"), DataSourceError);
  assert.throws(
    () =>
      decodeSnapshot(
        encode({ ...value, tables: Array.from({ length: 257 }, () => value.tables[0]) }),
      ),
    DataSourceError,
  );
});
