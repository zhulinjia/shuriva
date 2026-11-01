import assert from "node:assert/strict";
import { test } from "node:test";
import { closeOwnedDatabase } from "./fixtures/cleanup.mjs";

test("pool-end and schema-drop failures still close the admin and preserve all cleanup errors", async () => {
  const operations = [],
    poolError = new Error("synthetic pool-end failure"),
    dropError = new Error("synthetic drop failure");
  await assert.rejects(
    () =>
      closeOwnedDatabase(
        async () => {
          operations.push("pool");
          throw poolError;
        },
        async () => {
          operations.push("drop");
          throw dropError;
        },
        async () => {
          operations.push("admin");
        },
      ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === poolError &&
      error.errors[1] === dropError,
  );
  assert.deepEqual(operations, ["pool", "drop", "admin"]);
});
