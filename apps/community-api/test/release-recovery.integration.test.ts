import assert from "node:assert/strict";
import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { authMutationIdentity, createAuth } from "../src/auth.js";
import { bindingIdentitiesAvailable } from "../src/datasources/public.js";
import { migrateMcpSchema, verifyMcpSchema } from "../src/mcp/migration.js";
import { migrateExternalSchema, verifyExternalSchema } from "../src/mcp-client/migration.js";
import { verifyDatabaseCurrent } from "../src/migrations.js";
import { resetOnlyAdminPassword } from "../src/reset-password.js";
import {
  assertCliIdentityGuard,
  encryptedSnapshot,
  restoreSnapshot,
} from "./g4-runtime/mysql-backup.js";
import { isolatedMysql } from "./isolated-mysql.js";
import { mutationFixture } from "./mutation-fixture.js";

async function cleanupRecovery(
  databaseCleanups: readonly (() => Promise<unknown>)[],
  privateCleanup: () => Promise<unknown>,
) {
  const failures: unknown[] = [];
  for (const cleanup of [...databaseCleanups, privateCleanup]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "ISOLATED_RECOVERY_CLEANUP_FAILED");
}

test("release recovery removes private backup files even when database cleanup fails", async () => {
  const privateDirectory = await mkdtemp(join(tmpdir(), "shuriva-recovery-cleanup-"));
  const remainingCleanup: string[] = [];
  try {
    await writeFile(join(privateDirectory, "backup.fixture"), "nonsecret fixture", { flag: "wx" });
    await assert.rejects(
      cleanupRecovery(
        [
          async () => {
            throw Error("ISOLATED_TARGET_UNAVAILABLE");
          },
          async () => {
            remainingCleanup.push("admin");
            throw Error("ISOLATED_ADMIN_CLOSE_FAILED");
          },
          async () => remainingCleanup.push("fixture"),
        ],
        async () => {
          assert.equal(await realpath(privateDirectory), resolve(privateDirectory));
          assert.equal(dirname(privateDirectory), resolve(tmpdir()));
          assert.match(basename(privateDirectory), /^shuriva-recovery-cleanup-[A-Za-z0-9]+$/);
          await rm(privateDirectory, { recursive: true, force: true });
        },
      ),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message === "ISOLATED_RECOVERY_CLEANUP_FAILED" &&
        error.errors.length === 2,
    );
    assert.deepEqual(remainingCleanup, ["admin", "fixture"]);
    await assert.rejects(readFile(join(privateDirectory, "backup.fixture")), { code: "ENOENT" });
  } finally {
    assert.equal(dirname(privateDirectory), resolve(tmpdir()));
    assert.match(basename(privateDirectory), /^shuriva-recovery-cleanup-[A-Za-z0-9]+$/);
    await rm(privateDirectory, { recursive: true, force: true });
  }
});

async function snapshot(pool: Pool, database: string) {
  const [tables] = await pool.execute<RowDataPacket[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
    [database],
  );
  assert.ok(tables.length > 0 && tables.length <= 128);
  const result: Record<string, string> = {};
  for (const { TABLE_NAME: table } of tables) {
    assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/);
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
    result[table] = createHash("sha256")
      .update(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()))
      .digest("hex");
  }
  return result;
}

test("release recovery restores an encrypted isolated dump and revokes resurrected sessions before cutover", {
  skip: process.env.STAGE12_RECOVERY_TEST !== "1",
  timeout: 90000,
}, async () => {
  assert.equal(process.platform, "win32");
  const guard = await isolatedMysql();
  const manifestPath = process.env.STAGE8_G3_MANIFEST;
  assert.ok(manifestPath);
  const privateRoot = dirname(resolve(manifestPath));
  const destination = `g3_mut_api_${randomBytes(8).toString("hex")}`;
  const privateDirectory = join(privateRoot, `backup-${randomUUID()}`);
  assert.equal(dirname(privateDirectory), privateRoot);
  assert.match(basename(privateDirectory), /^backup-[0-9a-f-]{36}$/);
  const admin = await guard.admin();
  const backupKey = randomBytes(32);
  let fixture: Awaited<ReturnType<typeof mutationFixture>> | undefined;
  let restored: Pool | undefined,
    created = false,
    backupCreated = false;
  try {
    const f = await mutationFixture({ completeSchema: true });
    fixture = f;
    await migrateMcpSchema(f.pool);
    await migrateExternalSchema(f.pool);
    const username = `recovery${randomBytes(5).toString("hex")}`,
      password = randomBytes(24).toString("hex");
    await f.pool.execute("UPDATE user SET username=?,displayUsername=? WHERE id=?", [
      username,
      username,
      f.binding.ownerId,
    ]);
    await f.pool.execute(
      "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [randomUUID(), f.binding.ownerId, f.binding.ownerId, await hashPassword(password)],
    );
    const config = {
      databaseUrl: "mysql://unused:unused@127.0.0.1:13308/unused",
      origin: "http://127.0.0.1:5199",
      secret: randomBytes(32).toString("hex"),
    };
    const auth = createAuth(config, f.pool);
    const login = await auth.api.signInUsername({
      body: { username, password },
      returnHeaders: true,
    });
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.equal((await authMutationIdentity(auth)({ cookie }))?.ownerId, f.binding.ownerId);
    const expected = await snapshot(f.pool, f.database);
    await mkdir(privateDirectory, { mode: 0o700 });
    backupCreated = true;
    // Reuse the CLI boundary: actual Windows DACL, exclusive defaults/no login
    // paths, explicit TCP host/port/user, cleared MYSQL_PWD and an init-command
    // that rejects a different instance on the child's own connection.
    await assertCliIdentityGuard(f.database);
    await guard.verify(admin);
    const backupPath = join(privateDirectory, "platform.dump.aes-gcm");
    await encryptedSnapshot(f.database, backupPath, backupKey);
    const encrypted = await readFile(backupPath);
    assert.ok(encrypted.length > 28 && encrypted.length < 8 * 1048576);
    assert.equal(encrypted.includes(Buffer.from("CREATE TABLE")), false);
    const tampered = Buffer.from(encrypted);
    tampered[28] ^= 1;
    assert.throws(() => {
      const d = createDecipheriv("aes-256-gcm", backupKey, tampered.subarray(0, 12));
      d.setAuthTag(tampered.subarray(12, 28));
      d.update(tampered.subarray(28));
      d.final();
    });
    // Revoke after the backup to reproduce the exact disaster-recovery risk.
    await resetOnlyAdminPassword(f.pool, randomBytes(24).toString("hex"));
    assert.equal(await authMutationIdentity(auth)({ cookie }), undefined);
    await guard.verify(admin);
    assert.match(destination, /^g3_mut_api_[0-9a-f]{16}$/);
    await admin.query(
      `CREATE DATABASE \`${destination}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    restored = guard.pool(destination);
    const [empty] = await restored.execute<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=?",
      [destination],
    );
    assert.equal(Number(empty[0]?.n), 0);
    await guard.verify(admin);
    await restoreSnapshot(destination, backupPath, backupKey);
    backupKey.fill(0);
    assert.deepEqual(await snapshot(restored, destination), expected);
    await verifyDatabaseCurrent(restored, true, true, true, true);
    await verifyMcpSchema(restored);
    await verifyExternalSchema(restored);
    const c = await restored.getConnection();
    try {
      assert.equal(await bindingIdentitiesAvailable(c), true);
    } finally {
      c.release();
    }
    const restoredAuth = createAuth(config, restored);
    assert.equal(
      (await authMutationIdentity(restoredAuth)({ cookie }))?.ownerId,
      f.binding.ownerId,
    );
    const newPassword = randomBytes(24).toString("hex");
    await resetOnlyAdminPassword(restored, newPassword);
    assert.equal(await authMutationIdentity(restoredAuth)({ cookie }), undefined);
    const [sessions] = await restored.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM session");
    assert.equal(Number(sessions[0]?.n), 0);
    await assert.rejects(restoredAuth.api.signInUsername({ body: { username, password } }));
    assert.equal(
      (await restoredAuth.api.signInUsername({ body: { username, password: newPassword } })).user
        .id,
      f.binding.ownerId,
    );
  } finally {
    await cleanupRecovery(
      [
        async () => restored?.end(),
        async () => {
          if (created) {
            await guard.verify(admin);
            await admin.query(`DROP DATABASE \`${destination}\``);
          }
        },
        async () => admin.end(),
        async () => fixture?.close(),
      ],
      async () => {
        backupKey.fill(0);
        // Independent of MySQL availability; remove only this owned fixture.
        if (backupCreated) {
          assert.equal(await realpath(privateDirectory), resolve(privateDirectory));
          assert.equal(dirname(privateDirectory), privateRoot);
          assert.match(basename(privateDirectory), /^backup-[0-9a-f-]{36}$/);
          await rm(privateDirectory, { recursive: true, force: true });
        }
      },
    );
  }
});
