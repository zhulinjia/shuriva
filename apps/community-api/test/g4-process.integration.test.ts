import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { DataSourceStore } from "../src/datasources/store.js";
import { resetOnlyAdminPassword } from "../src/reset-password.js";
import {
  assertCliIdentityGuard,
  encryptedSnapshot,
  restoreSnapshot,
} from "./g4-runtime/mysql-backup.js";
import { g4Runtime, until } from "./g4-runtime/runtime.js";
import { isolatedMysql } from "./isolated-mysql.js";

test("G4 actual API crash, lost confirmation response and cancel-before-permit never replay DML", {
  skip: process.env.STAGE8_G4_ACCEPTANCE !== "1",
  timeout: 150_000,
}, async () => {
  const runtime = await g4Runtime();
  try {
    await verifyProcessAndRestore(runtime);
  } finally {
    await runtime.close();
  }
});

async function verifyProcessAndRestore(runtime: Awaited<ReturnType<typeof g4Runtime>>) {
  const isolated = await isolatedMysql(),
    admin = await isolated.admin();
  const restoredDatabase = `g3_mut_api_${randomBytes(8).toString("hex")}`;
  const restoredPool = isolated.pool(restoredDatabase);
  let created = false;
  try {
    await assertCliIdentityGuard(runtime.fixture.database);
    await runtime.command("arm", "heartbeat-drop");
    await runtime.barrier("heartbeat-drop");
    const preview = await runtime.preview("lost-response-once");
    const confirmation = runtime.confirmation(preview);
    await runtime.command("arm", "confirm-drop");
    await assert.rejects(runtime.request(`/previews/${preview.previewId}/confirm`, confirmation));
    await runtime.barrier("confirm-drop");
    const registered = await runtime.json(`/confirmations/${confirmation.confirmationId}`);
    assert.equal(registered.state, "registered");
    const execution = registered.execution as { executionId: string };
    assert.ok(execution.executionId);
    await until(async () =>
      (await runtime.json(`/executions/${execution.executionId}`)).state === "committed"
        ? true
        : undefined,
    );
    assert.equal((await runtime.observe())[0]?.label, "lost-response-once");
    assert.equal(
      (await runtime.json(`/previews/${preview.previewId}/confirm`, confirmation)).executionId,
      execution.executionId,
    );
    await runtime.fixture.pool.query("RENAME TABLE history_entry TO g4_unavailable_history");
    await assert.rejects(runtime.command("flush-audit"));
    const [pendingAudit] = await runtime.fixture.pool.query<
      import("mysql2/promise").RowDataPacket[]
    >("SELECT id FROM mutation_outbox WHERE delivered=0 ORDER BY id");
    assert.ok(pendingAudit.length > 0);
    await runtime.restart();
    await runtime.fixture.pool.query("RENAME TABLE g4_unavailable_history TO history_entry");
    await runtime.command("flush-audit");
    await runtime.command("flush-audit");
    const [deliveredAudit] = await runtime.fixture.pool.query<
      import("mysql2/promise").RowDataPacket[]
    >("SELECT id FROM history_entry WHERE kind='audit' ORDER BY id");
    assert.deepEqual(
      deliveredAudit.map((row) => row.id),
      pendingAudit.map((row) => row.id),
    );
    const snapshot = join(runtime.directory, "platform-backup.gcm"),
      backupKey = randomBytes(32);
    const revokedWorkspace = randomUUID();
    await runtime.fixture.pool.execute(
      "INSERT INTO workspace(id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'G4 revoked binding',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [revokedWorkspace, runtime.fixture.binding.ownerId],
    );
    await runtime.fixture.sources.bind(
      runtime.fixture.binding.ownerId,
      revokedWorkspace,
      runtime.fixture.binding.sourceId,
    );
    const [snapshotSessions] = await runtime.fixture.pool.query<
      import("mysql2/promise").RowDataPacket[]
    >("SELECT id FROM session ORDER BY id");
    assert.ok(snapshotSessions.length > 0);
    runtime.captureSnapshotAuthority();
    await encryptedSnapshot(runtime.fixture.database, snapshot, backupKey);
    assert.equal((await readFile(snapshot)).includes(Buffer.from("CREATE TABLE")), false);
    await runtime.fixture.pool.execute("DELETE FROM workspace_data_source WHERE workspaceId=?", [
      revokedWorkspace,
    ]);
    await runtime.rotatePassword();

    const committedPreview = await runtime.preview("committed-before-api-crash");
    await runtime.command("arm", "result-hold");
    const committed = await runtime.json(
      `/previews/${committedPreview.previewId}/confirm`,
      runtime.confirmation(committedPreview),
    );
    await runtime.barrier("result-hold");
    assert.equal((await runtime.observe())[0]?.label, "committed-before-api-crash");
    await runtime.restart();
    // New API boot may only reconcile a durable receipt, never renew the grant.
    await until(
      async () =>
        (await runtime.json(`/executions/${committed.executionId}`)).state === "committed"
          ? true
          : undefined,
      45_000,
    );
    const recovery = await runtime.json("/recovery", {});
    assert.ok(
      (recovery.items as Array<{ executionId: string }>).some(
        (item) => item.executionId === committed.executionId,
      ),
    );
    const cancelledPreview = await runtime.preview("must-not-commit");
    await runtime.command("arm", "permit-hold");
    const cancelled = await runtime.json(
      `/previews/${cancelledPreview.previewId}/confirm`,
      runtime.confirmation(cancelledPreview),
    );
    await runtime.barrier("permit-hold");
    const cancelRequest = runtime.json(`/executions/${cancelled.executionId}/cancel`, {});
    await until(async () => {
      const [rows] = await runtime.fixture.pool.query<import("mysql2/promise").RowDataPacket[]>(
        "SELECT cancelRequested FROM mutation_execution WHERE id=?",
        [cancelled.executionId],
      );
      return rows[0]?.cancelRequested === 1 ? true : undefined;
    });
    await runtime.command("release");
    await cancelRequest;
    // Driver cancellation can make rollback acknowledgement ambiguous. An
    // unknown state is honest and must keep the target closed, never retry.
    const state = await until(async () => {
      const value = await runtime.json(`/executions/${cancelled.executionId}`);
      return ["rejected", "rolled_back", "outcome_unknown"].includes(String(value.state))
        ? value
        : undefined;
    });
    if (state.state === "outcome_unknown")
      assert.equal((await runtime.json("/capability")).code, "frozen");
    assert.equal((await runtime.observe())[0]?.label, "committed-before-api-crash");
    await admin.query(
      `CREATE DATABASE \`${restoredDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    created = true;
    await assert.rejects(
      restoreSnapshot(restoredDatabase, snapshot, randomBytes(32)),
      /authenticate|auth/i,
    );
    await restoreSnapshot(restoredDatabase, snapshot, backupKey);
    backupKey.fill(0);
    const [restoredSessions] = await restoredPool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT id FROM session ORDER BY id",
    );
    assert.deepEqual(
      restoredSessions.map((row) => row.id),
      snapshotSessions.map((row) => row.id),
    );
    // Offline recovery requires renewed administrator credentials and explicit
    // scope approval; snapshot-era credentials and bindings are not authority.
    const restoredPassword = `G4-restored-${randomBytes(20).toString("hex")}`;
    await resetOnlyAdminPassword(restoredPool, restoredPassword);
    await restoredPool.execute("DELETE FROM workspace_data_source");
    const [currentBinding] = await runtime.fixture.pool.query<
      import("mysql2/promise").RowDataPacket[]
    >("SELECT workspaceId,sourceId FROM workspace_data_source WHERE workspaceId=? AND sourceId=?", [
      runtime.fixture.binding.workspaceId,
      runtime.fixture.binding.sourceId,
    ]);
    assert.equal(currentBinding.length, 1);
    await new DataSourceStore(restoredPool, true).bind(
      runtime.fixture.binding.ownerId,
      runtime.fixture.binding.workspaceId,
      runtime.fixture.binding.sourceId,
    );
    const [revoked] = await restoredPool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT workspaceId FROM workspace_data_source WHERE workspaceId=?",
      [revokedWorkspace],
    );
    assert.equal(revoked.length, 0);
    await runtime.useRestoredDatabase(restoredDatabase, restoredPassword);
    const restored = await runtime.json("/recovery", {});
    assert.equal(restored.metadataError, "orphaned_receipt");
    assert.ok(
      (restored.recoveredReceipts as Array<{ executionId: string }>).some(
        (receipt) => receipt.executionId === committed.executionId,
      ),
    );
    assert.equal((await runtime.observe())[0]?.label, "committed-before-api-crash");
    // A restored platform snapshot cannot fabricate the missing registration
    // or turn the independently retained target receipt into authority to retry.
    assert.equal((await runtime.json("/capability")).code, "frozen");
  } finally {
    try {
      await runtime.close();
    } finally {
      try {
        await restoredPool.end();
      } finally {
        try {
          if (created) {
            await isolated.verify(admin);
            await admin.query(`DROP DATABASE \`${restoredDatabase}\``);
          }
        } finally {
          await admin.end();
        }
      }
    }
  }
}
