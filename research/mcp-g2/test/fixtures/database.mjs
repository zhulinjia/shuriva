import { randomBytes } from "node:crypto";
import { migrateDatabase } from "../../../../apps/community-api/dist/src/migrations.js";
import { isolatedMysql } from "../../../../apps/community-api/dist/test/isolated-mysql.js";
import { closeOwnedDatabase } from "./cleanup.mjs";

/** Reuse the existing guard. No env loader, default port or unverified SQL. */
export async function databaseFixture() {
  if (!process.env.STAGE8_G3_MANIFEST) throw new Error("G2_FRESH_MANIFEST_REQUIRED");
  const isolated = await isolatedMysql();
  const admin = await isolated.admin();
  const database = `g3_mut_api_${randomBytes(8).toString("hex")}`;
  let pool,
    sdkPool,
    created = false;
  const close = async () => {
    await closeOwnedDatabase(
      async () => {
        const results = await Promise.allSettled(
          [pool, sdkPool].filter(Boolean).map((value) => value.end()),
        );
        const failures = results
          .filter((value) => value.status === "rejected")
          .map((value) => value.reason);
        if (failures.length) throw new AggregateError(failures, "G2_POOL_CLEANUP_FAILED");
      },
      async () => {
        if (!created) return;
        await isolated.verify(admin);
        await admin.query(`DROP DATABASE \`${database}\``);
        created = false;
      },
      () => admin.end(),
    );
  };
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    pool = isolated.pool(database);
    await migrateDatabase(pool);
    // A locked grant observation must not hold every connection that the public
    // SDK needs for its final token check. Both bounded pools use the same guard.
    sdkPool = isolated.pool(database);
    return { pool, sdkPool, database, close, runId: isolated.runId };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "G2_FIXTURE_FAILED");
    }
    throw error;
  }
}
