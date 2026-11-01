import { randomBytes, randomUUID } from "node:crypto";

import { isolatedMysql } from "./isolated-mysql.js";
import { authSessionReferenceActive } from "../src/auth.js";
import { DataSourceStore } from "../src/datasources/store.js";
import {
  migrateDatabase,
  migrateStage3,
  migrateStage6,
  migrateStage7,
  migrateStage8,
} from "../src/migrations.js";
import { inspectStage8, stage8MigrationFile } from "../src/mutations/migration.js";
import type { MutationBinding, PreviewMetadata } from "../src/mutations/model.js";
import { MutationStore } from "../src/mutations/store.js";

/** This fixture has no .env path or default connection. Every checkout is pinned before SQL. */
export async function mutationFixture(options: { completeSchema?: boolean } = {}) {
  const isolated = await isolatedMysql();
  const admin = await isolated.admin();
  const database = `g3_mut_api_${randomBytes(8).toString("hex")}`;
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  const pool = isolated.pool(database);
  async function close() {
    await pool.end();
    try {
      await isolated.verify(admin);
      await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.end();
    }
  }
  try {
    await migrateDatabase(pool);
    await migrateStage3(pool);
    if (options.completeSchema) {
      await migrateStage6(pool);
      await migrateStage7(pool);
      await migrateStage8(pool);
    } else {
      const c = await pool.getConnection();
      try {
        const { sql } = await stage8MigrationFile();
        for (const statement of sql
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean))
          await c.query(statement);
        await inspectStage8(c);
      } finally {
        c.release();
      }
    }
    const binding: MutationBinding = {
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      sourceId: randomUUID(),
      connectorId: randomUUID(),
    };
    const sessionId = randomUUID();
    await pool.execute(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'isolated',?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.ownerId, `${binding.ownerId}@example.invalid`],
    );
    await pool.execute(
      "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'isolated',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.workspaceId, binding.ownerId],
    );
    await pool.execute(
      "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'isolated',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [binding.sourceId, binding.ownerId, binding.connectorId],
    );
    await pool.execute(
      "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
      [binding.workspaceId, binding.sourceId],
    );
    await pool.execute(
      "INSERT INTO session (id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [sessionId, binding.ownerId, randomBytes(32).toString("hex")],
    );
    const boot = randomBytes(32).toString("hex");
    const sources = new DataSourceStore(pool);
    const store = new MutationStore(pool, sources, boot, authSessionReferenceActive);
    const preview = (overrides: Partial<PreviewMetadata> = {}): PreviewMetadata => ({
      previewId: randomUUID(),
      commitment: randomBytes(32).toString("base64url"),
      revision: 1,
      apiBoot: boot,
      connectorBoot: randomBytes(32).toString("hex"),
      targetIdentity: `isolated:${database}`,
      targetEpoch: randomBytes(32).toString("hex"),
      policyGeneration: "1",
      installationGeneration: "1",
      operation: "update",
      table: "customers",
      rowCount: 1,
      expiresAt: new Date(Date.now() + 100000).toISOString(),
      ...overrides,
    });
    return { pool, database, binding, sessionId, boot, store, sources, preview, close };
  } catch (error) {
    await close();
    throw error;
  }
}
