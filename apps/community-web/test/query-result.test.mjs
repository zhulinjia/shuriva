import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeQueryResult } from "../src/queries/query-result.ts";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fixture = {
  columns: [
    { name: "name", type: "VARCHAR" },
    { name: "amount", type: "DECIMAL" },
  ],
  rows: [
    [
      { null: false, encoding: "text", value: "中文<script>" },
      { null: false, encoding: "text", value: "12345678901234567890.123456789" },
    ],
  ],
  timezone: "UTC",
  truncated: false,
};

test("decodes UTF-8, exact decimal text and binary or null cells without interpreting them", () => {
  const input = {
    ...fixture,
    rows: [...fixture.rows, [{ null: true }, { null: false, encoding: "base64", value: "AAE=" }]],
  };
  assert.deepEqual(decodeQueryResult(encode(input)), input);
});

test("rejects malformed, oversized, and structurally invalid result payloads", () => {
  assert.throws(() => decodeQueryResult("%%%"));
  assert.throws(() => decodeQueryResult("A".repeat(1_398_103)));
  assert.throws(() => decodeQueryResult(Buffer.from([0xff]).toString("base64url")));
  assert.throws(() => decodeQueryResult(encode({ ...fixture, timezone: "local" })));
  assert.throws(() => decodeQueryResult(encode({ ...fixture, rows: [[{ null: true }]] })));
  assert.throws(() =>
    decodeQueryResult(encode({ ...fixture, columns: [{ name: "<script>", type: "TEXT" }] })),
  );
  assert.throws(() => decodeQueryResult(encode({ ...fixture, truncated: true, reason: "other" })));
  assert.throws(() =>
    decodeQueryResult(
      encode({
        ...fixture,
        rows: [[{ null: false, encoding: "base64", value: "%%%" }, { null: true }]],
      }),
    ),
  );
  assert.throws(() =>
    decodeQueryResult(
      encode({
        ...fixture,
        rows: [[{ null: false, encoding: "text", value: "中".repeat(11_000) }, { null: true }]],
      }),
    ),
  );
  assert.throws(() =>
    decodeQueryResult(
      encode({ ...fixture, rows: Array.from({ length: 1001 }, () => fixture.rows[0]) }),
    ),
  );
});

test("preserves each explicit truncation reason", () => {
  for (const reason of ["rows", "bytes", "cell"]) {
    assert.equal(decodeQueryResult(encode({ ...fixture, truncated: true, reason })).reason, reason);
  }
});
