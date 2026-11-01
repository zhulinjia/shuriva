import assert from "node:assert/strict";
import { test } from "node:test";
import { readStage8Enabled } from "../src/config.js";
import {
  migrateDatabase,
  migrateStage3,
  migrateStage6,
  migrateStage7,
  migrateStage8,
  verifyDatabaseCurrent,
} from "../src/migrations.js";
import { mutationTables } from "../src/mutations/migration.js";
import { mutationFixture } from "./mutation-fixture.js";
import type { RowDataPacket } from "mysql2/promise";

test("controlled writes cannot be enabled by an environment switch before G4", () => {
  assert.equal(readStage8Enabled({}), false);
  assert.equal(readStage8Enabled({ ENABLE_STAGE8_WRITES: "0" }), false);
  for (const value of ["1", "true", "", "yes"])
    assert.throws(() => readStage8Enabled({ ENABLE_STAGE8_WRITES: value }));
});

test("explicit mutation migration preserves the isolated auth/workspace baseline and every current migration accepts the new schema", {
  skip: process.env.STAGE8_G3_TEST !== "1",
}, async () => {
  const fixture = await mutationFixture();
  try {
    assert.match(fixture.database, /^g3_mut_api_[0-9a-f]{16}$/);
    // This helper initially installs empty mutation fixture tables directly.
    // Re-create only these known-empty, owned objects via the actual migrator.
    for (const table of mutationTables) {
      const [rows] = await fixture.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM \`${table}\``,
      );
      assert.equal(Number(rows[0]?.total), 0);
      await fixture.pool.query(`DROP TABLE \`${table}\``);
    }
    await migrateStage6(fixture.pool);
    await migrateStage7(fixture.pool);
    await migrateStage8(fixture.pool);
    assert.deepEqual(await verifyDatabaseCurrent(fixture.pool, true, true, true, true), {
      hasStage3: true,
      hasSemantics: true,
      hasHistory: true,
      hasMutations: true,
    });
    for (const migrate of [
      migrateDatabase,
      migrateStage3,
      migrateStage6,
      migrateStage7,
      migrateStage8,
    ])
      await migrate(fixture.pool);
    const [rows] = await fixture.pool.execute<RowDataPacket[]>(
      "SELECT w.id,s.id AS sessionId,b.sourceId FROM workspace w JOIN session s ON s.userId=w.createdByAccountId JOIN workspace_data_source b ON b.workspaceId=w.id WHERE w.id=? AND s.id=?",
      [fixture.binding.workspaceId, fixture.sessionId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sourceId, fixture.binding.sourceId);
    const [history] = await fixture.pool.query<RowDataPacket[]>(
      "SELECT version FROM _workspace_migrations ORDER BY version",
    );
    assert.deepEqual(
      history.map((row) => row.version),
      ["001", "002", "003", "004", "005", "006"],
    );
  } finally {
    await fixture.close();
  }
});
