import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { createAuth, createDatabase } from "../src/auth.js";
import { resetOnlyAdminPassword } from "../src/reset-password.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("local recovery changes only the single administrator and revokes all sessions", {
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
  const username = `reset${suffix}`;
  const result = await auth.api.signUpEmail({
    body: {
      username,
      email: `${suffix}@example.test`,
      name: "Reset fixture",
      password: "old-password-only-123",
    },
  });
  const id = result.user.id;
  try {
    await auth.api.signInUsername({ body: { username, password: "old-password-only-123" } });
    await assert.rejects(() => resetOnlyAdminPassword(pool, "too short"));
    await resetOnlyAdminPassword(pool, "new-password-only-456");
    const [sessions] = await pool.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `session` WHERE userId = ?",
      [id],
    );
    assert.equal(Number(sessions[0]?.count), 0);
    await assert.rejects(() =>
      auth.api.signInUsername({ body: { username, password: "old-password-only-123" } }),
    );
    const login = await auth.api.signInUsername({
      body: { username, password: "new-password-only-456" },
    });
    assert.equal(login.user.id, id);
    const second = await auth.api.signUpEmail({
      body: {
        username: `other${suffix}`,
        email: `other${suffix}@example.test`,
        name: "Other",
        password: "other-password-only-123",
      },
    });
    try {
      await assert.rejects(
        () => resetOnlyAdminPassword(pool, "never-used-password-789"),
        /仅存在一个管理员/,
      );
    } finally {
      await pool.execute("DELETE FROM `user` WHERE id=?", [second.user.id]);
    }
  } finally {
    await pool.execute("DELETE FROM `user` WHERE id=?", [id]);
    await pool.end();
  }
});
