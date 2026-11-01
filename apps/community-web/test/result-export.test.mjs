import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeResultExport, exportReviewedResult } from "../src/queries/result-export.ts";

test("export preserves exact result values, binary encoding, nulls and truncation without spreadsheet formulas", () => {
  const result = {
    columns: [
      { name: "amount", type: "DECIMAL" },
      { name: "note", type: "TEXT" },
      { name: "binary", type: "BLOB" },
      { name: "missing", type: "TEXT" },
    ],
    rows: [
      [
        { null: false, encoding: "text", value: "12345678901234567890.01" },
        { null: false, encoding: "text", value: '=HYPERLINK("https://example.invalid")' },
        { null: false, encoding: "base64", value: "AAE=" },
        { null: true },
      ],
    ],
    timezone: "UTC",
    truncated: true,
    reason: "rows",
  };
  const encoded = encodeResultExport(result);
  assert.deepEqual(JSON.parse(encoded), {
    format: "ai-workspace-query-result",
    version: 1,
    ...result,
  });
  assert.ok(encoded.endsWith("\n"));
});

test("export is refused if the reviewed result or scope changes while authorization waits", async () => {
  const result = { columns: [], rows: [], timezone: "UTC", truncated: false };
  const intent = { result, scope: "workspace-a" };
  let current = intent;
  let release;
  let downloads = 0;
  let authorizations = 0;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const attempt = exportReviewedResult(
    intent,
    (value) => value === current,
    async () => {
      authorizations++;
      await waiting;
    },
    () => {
      downloads++;
    },
  );
  current = { result, scope: "workspace-b" };
  release();
  assert.equal(await attempt, "stale");
  assert.equal(authorizations, 1);
  assert.equal(downloads, 0);
  assert.equal(
    await exportReviewedResult(
      intent,
      (value) => value === current,
      async () => {
        authorizations++;
      },
      () => {
        downloads++;
      },
    ),
    "stale",
  );
  assert.equal(authorizations, 1);
  current = intent;
  assert.equal(
    await exportReviewedResult(
      intent,
      (value) => value === current,
      async () => {
        authorizations++;
      },
      (value) => {
        assert.equal(value, result);
        downloads++;
      },
    ),
    "exported",
  );
  assert.equal(downloads, 1);
});
