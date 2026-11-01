import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { createAuth, createDatabase } from "../src/auth.js";
import { migrateDatabase, verifyDatabaseCurrent } from "../src/migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("migration preserves existing identity, password, workspace and session and is repeatable", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ai_workspace_stage1_test")
    throw new Error("Use only the dedicated stage 1 test database");
  const pool = createDatabase(databaseUrl);
  const auth = createAuth(
    { databaseUrl, origin: "http://127.0.0.1:5173", secret: randomBytes(32).toString("hex") },
    pool,
  );
  const suffix = randomUUID().replaceAll("-", "");
  const user = await auth.api.signUpEmail({
    body: {
      username: `migration${suffix}`,
      email: `${suffix}@example.test`,
      name: "Migration fixture",
      password: "test-only-password-123",
    },
  });
  const id = user.user.id;
  const workspaceId = randomUUID();
  try {
    await pool.execute(
      "INSERT INTO workspace (id, name, description, createdByAccountId, createdAt, updatedAt) VALUES (?, 'migration fixture', NULL, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [workspaceId, id],
    );
    await auth.api.signInUsername({
      body: { username: `migration${suffix}`, password: "test-only-password-123" },
    });
    const [before] = await pool.execute<RowDataPacket[]>(
      "SELECT a.password, (SELECT COUNT(*) FROM `session` s WHERE s.userId = a.userId) AS sessions FROM account a WHERE a.userId=?",
      [id],
    );
    assert.equal(Number(before[0]?.sessions), 1);
    await migrateDatabase(pool);
    await migrateDatabase(pool);
    await verifyDatabaseCurrent(pool);
    const [history] = await pool.query<RowDataPacket[]>(
      "SELECT checksum FROM _workspace_migrations WHERE version='001'",
    );
    const original = history[0]?.checksum;
    assert.equal(typeof original, "string");
    try {
      await pool.execute("UPDATE _workspace_migrations SET checksum=? WHERE version='001'", [
        "0".repeat(64),
      ]);
      await assert.rejects(() => verifyDatabaseCurrent(pool), /migration history/);
      await assert.rejects(() => migrateDatabase(pool), /altered migration/);
    } finally {
      await pool.execute("UPDATE _workspace_migrations SET checksum=? WHERE version='001'", [
        original,
      ]);
    }
    const [after] = await pool.execute<RowDataPacket[]>(
      "SELECT a.password, (SELECT COUNT(*) FROM `session` s WHERE s.userId = a.userId) AS sessions FROM account a WHERE a.userId=?",
      [id],
    );
    assert.equal(after[0]?.password, before[0]?.password);
    assert.equal(Number(after[0]?.sessions), 1);
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT name, archivedAt FROM workspace WHERE id=?",
      [workspaceId],
    );
    assert.equal(rows[0]?.name, "migration fixture");
    assert.equal(rows[0]?.archivedAt, null);
    const login = await auth.api.signInUsername({
      body: { username: `migration${suffix}`, password: "test-only-password-123" },
    });
    assert.equal(login.user.id, id);
  } finally {
    await pool.execute("DELETE FROM workspace WHERE id=? AND createdByAccountId=?", [
      workspaceId,
      id,
    ]);
    await pool.execute("DELETE FROM `user` WHERE id=?", [id]);
    await pool.end();
  }
});
