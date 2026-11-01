import assert from "node:assert/strict";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { isolatedMysql } from "./isolated-mysql.js";
import { g4Runtime } from "./g4-runtime/runtime.js";

test("G4 failed directory creation and failed executable spawn close every acquired platform fixture", {
  skip: process.env.STAGE8_G4_ACCEPTANCE !== "1",
  timeout: 60_000,
}, async () => {
  const isolated = await isolatedMysql(),
    admin = await isolated.admin();
  const schemas = async () => {
    await isolated.verify(admin);
    const [rows] = await admin.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME name FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME,11)='g3_mut_api_' ORDER BY SCHEMA_NAME",
    );
    return rows.map((row) => row.name);
  };
  try {
    const before = await schemas();
    await assert.rejects(g4Runtime({ directoryUnavailable: true }), { code: "ENOENT" });
    assert.deepEqual(await schemas(), before);
    await assert.rejects(g4Runtime({ probeUnavailable: true }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1, "another owned resource failed cleanup");
      assert.ok(error.errors[0] instanceof Error);
      assert.equal(error.errors[0].message, "G4_PROBE_START_FAILED");
      return true;
    });
    assert.deepEqual(await schemas(), before);
  } finally {
    await admin.end();
  }
});
