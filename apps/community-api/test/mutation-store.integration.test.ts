import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { authSessionReferenceActive } from "../src/auth.js";
import { executionBindingSchema, MutationError, publicExecution } from "../src/mutations/model.js";
import { inspectStage8 } from "../src/mutations/migration.js";
import { MutationStore } from "../src/mutations/store.js";
import { MutationService } from "../src/mutations/service.js";
import type { BoundSourceAccess } from "../src/datasources/public.js";
import { mutationFixture } from "./mutation-fixture.js";

const integration = { skip: process.env.STAGE8_G3_TEST !== "1" };
test(
  "mutation SQL registers one execution, seals late confirmations, persists permit once and retains identity",
  integration,
  async () => {
    const f = await mutationFixture();
    try {
      const preview = f.preview();
      await f.store.savePreview(f.binding, preview);
      const confirmations = await Promise.allSettled(
        Array.from({ length: 24 }, () =>
          f.store.confirm(f.binding, f.sessionId, {
            confirmationId: randomUUID(),
            previewId: preview.previewId,
            commitment: preview.commitment,
            revision: 1,
          }),
        ),
      );
      const successes = confirmations.flatMap((item) =>
        item.status === "fulfilled" ? [item.value] : [],
      );
      assert.equal(successes.length, 1);
      const registered = successes[0].execution;
      assert.equal(registered.state, "registered");
      assert.equal("sessionId" in publicExecution(registered), false);
      const input = {
        confirmationId: registered.confirmationId,
        previewId: registered.previewId,
        commitment: registered.commitment,
        revision: 1,
      };
      assert.equal(
        (await f.store.confirm(f.binding, f.sessionId, input)).execution.executionId,
        registered.executionId,
      );
      assert.equal((await f.store.confirm(f.binding, f.sessionId, input)).created, false);
      await assert.rejects(
        () =>
          f.store.confirm(f.binding, f.sessionId, {
            ...input,
            commitment: randomBytes(32).toString("base64url"),
          }),
        (error: unknown) => error instanceof MutationError && error.code === "CONFLICT",
      );
      const bound = executionBindingSchema.parse({
        ownerId: registered.ownerId,
        workspaceId: registered.workspaceId,
        sourceId: registered.sourceId,
        connectorId: registered.connectorId,
        executionId: registered.executionId,
        previewId: registered.previewId,
        commitment: registered.commitment,
        revision: registered.revision,
        apiBoot: registered.apiBoot,
        connectorBoot: registered.connectorBoot,
        targetIdentity: registered.targetIdentity,
        targetEpoch: registered.targetEpoch,
        policyGeneration: registered.policyGeneration,
        installationGeneration: registered.installationGeneration,
      });
      await f.store.claim(f.binding, bound);
      await assert.rejects(() => f.store.claim(f.binding, bound), /DENIED/);
      let signatures = 0;
      const signer = {
        async sign() {
          signatures++;
          return randomBytes(64).toString("base64url");
        },
      };
      const request = { ...bound, challenge: randomBytes(32).toString("base64url") };
      const first = await f.store.permit(f.binding, request, signer);
      const repeated = await f.store.permit(f.binding, request, signer);
      assert.deepEqual(repeated, first);
      assert.equal(signatures, 1);
      assert.equal((await f.store.get(f.binding, registered.executionId)).permitIssued, true);
      await assert.rejects(() => f.store.cancel(f.binding, registered.executionId), /CONFLICT/);
      await assert.rejects(
        () =>
          f.store.permit(
            f.binding,
            { ...request, challenge: randomBytes(32).toString("base64url") },
            signer,
          ),
        /CONFLICT/,
      );
      await f.store.update(f.binding, registered.executionId, "committed", null, null, 1);
      const recovered = await f.store.recovery(f.binding);
      assert.equal(recovered.items[0]?.executionId, registered.executionId);
      assert.equal(recovered.items[0]?.state, "committed");
      assert.equal(recovered.items[0]?.affectedRows, 1);
      await assert.rejects(
        () => f.store.update(f.binding, registered.executionId, "rolled_back", "wrong"),
        /CONFLICT/,
      );
      const sealed = f.preview();
      await f.store.savePreview(f.binding, sealed);
      await f.store.recovery(f.binding);
      await assert.rejects(
        () =>
          f.store.confirm(f.binding, f.sessionId, {
            confirmationId: randomUUID(),
            previewId: sealed.previewId,
            commitment: sealed.commitment,
            revision: 1,
          }),
        /CONFLICT/,
      );
      const closed = f.preview();
      await f.store.savePreview(f.binding, closed);
      const close = {
        confirmationId: randomUUID(),
        previewId: closed.previewId,
        commitment: closed.commitment,
        revision: 1,
      };
      assert.equal(await f.store.closeConfirmation(f.binding, close), null);
      assert.equal((await f.store.confirmation(f.binding, close.confirmationId)).state, "closed");
      await assert.rejects(() => f.store.confirm(f.binding, f.sessionId, close), /CONFLICT/);
      const outbox: string[] = [];
      const sink = {
        async append(_scope: unknown, id: string) {
          outbox.push(id);
        },
      };
      await f.store.flushAudit(sink);
      await f.store.flushAudit(sink);
      assert.equal(new Set(outbox).size, outbox.length);
      assert.equal(outbox.length, 2); // One confirmed plus one terminal-state event.
      const [persisted] = await f.pool.query<RowDataPacket[]>(
        "SELECT request FROM mutation_permit",
      );
      assert.equal(JSON.stringify(persisted).includes("UPDATE"), false);
      assert.equal(JSON.stringify(persisted).includes("private-reference"), false);
    } finally {
      await f.close();
    }
  },
);

test(
  "session deletion serializes with final permit and API restart never reauthorizes old execution",
  integration,
  async () => {
    const f = await mutationFixture();
    try {
      const p = f.preview();
      await f.store.savePreview(f.binding, p);
      const { execution } = await f.store.confirm(f.binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: p.previewId,
        commitment: p.commitment,
        revision: 1,
      });
      const bound = executionBindingSchema.parse(
        Object.fromEntries(
          Object.keys(executionBindingSchema.shape).map((key) => [
            key,
            Reflect.get(execution, key),
          ]),
        ),
      );
      await f.store.claim(f.binding, bound);
      const blocker = await f.pool.getConnection();
      await blocker.beginTransaction();
      assert.equal(await authSessionReferenceActive(blocker, f.binding.ownerId, f.sessionId), true);
      const deleting = f.pool.getConnection();
      const deleteConnection = await deleting;
      await deleteConnection.query("SET SESSION innodb_lock_wait_timeout=1");
      await assert.rejects(
        () => deleteConnection.execute("DELETE FROM session WHERE id=?", [f.sessionId]),
        (error: unknown) =>
          !!error && typeof error === "object" && "errno" in error && error.errno === 1205,
      );
      await blocker.rollback();
      blocker.release();
      await deleteConnection.execute("DELETE FROM session WHERE id=?", [f.sessionId]);
      deleteConnection.release();
      await assert.rejects(
        () =>
          f.store.permit(
            f.binding,
            { ...bound, challenge: randomBytes(32).toString("base64url") },
            {
              async sign() {
                throw Error("must not sign revoked session");
              },
            },
          ),
        /DENIED/,
      );
      const restarted = new MutationStore(
        f.pool,
        f.sources,
        randomBytes(32).toString("hex"),
        authSessionReferenceActive,
      );
      await restarted.recoverPreviousBoot();
      assert.equal(
        (await restarted.get(f.binding, execution.executionId)).state,
        "outcome_unknown",
      );
      await assert.rejects(() => restarted.claim(f.binding, bound), /DENIED/);
      let receiptReads = 0;
      const restoredService = new MutationService(
        restarted,
        {
          async authenticate() {
            return undefined;
          },
          async withScope(_scope, operation) {
            return operation(f.binding);
          },
        },
        {
          async capability() {
            return { available: false, code: "frozen" };
          },
          async preview() {
            throw Error("no new preview during receipt recovery");
          },
          async execute() {
            throw Error("old execution must never be redelivered");
          },
          async status(_binding, old) {
            receiptReads++;
            assert.equal(old.executionId, execution.executionId);
            assert.equal(old.apiBoot, f.boot);
            return { state: "committed", code: null };
          },
          async cancel() {
            throw Error("receipt query must not cancel a task");
          },
        },
        {
          async sign() {
            throw Error("receipt recovery must not sign a permit");
          },
        },
        { enabled: true },
      );
      assert.equal(
        (await restoredService.get(f.binding, execution.executionId)).state,
        "committed",
      );
      assert.equal(receiptReads, 1);
      await assert.rejects(
        () => restarted.savePreview(f.binding, f.preview({ apiBoot: restarted.apiBoot })),
        /FROZEN/,
      );
      const connection = await f.pool.getConnection();
      try {
        await inspectStage8(connection);
      } finally {
        connection.release();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "failed confirmation transaction rolls back preview consumption, execution and audit together",
  integration,
  async () => {
    const f = await mutationFixture();
    try {
      const p = f.preview();
      await f.store.savePreview(f.binding, p);
      await f.pool.query(
        "CREATE TRIGGER mutation_reject_outbox BEFORE INSERT ON mutation_outbox FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated injected outbox failure'",
      );
      const input = {
        confirmationId: randomUUID(),
        previewId: p.previewId,
        commitment: p.commitment,
        revision: 1,
      };
      await assert.rejects(() => f.store.confirm(f.binding, f.sessionId, input));
      const [rows] = await f.pool.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM mutation_execution) AS executions,(SELECT COUNT(*) FROM mutation_confirmation) AS confirmations,(SELECT COUNT(*) FROM mutation_preview WHERE state='pending') AS previews",
      );
      assert.equal(rows[0]?.executions, 0);
      assert.equal(rows[0]?.confirmations, 0);
      assert.equal(rows[0]?.previews, 1);
      await f.pool.query("DROP TRIGGER mutation_reject_outbox");
      assert.equal((await f.store.confirm(f.binding, f.sessionId, input)).created, true);
    } finally {
      await f.close();
    }
  },
);

test(
  "unknown freezes aliases atomically before another workspace confirms, claims or obtains a permit",
  integration,
  async (t) => {
    for (const phase of ["confirm", "claim", "permit"] as const)
      await t.test(phase, async () => {
        const f = await mutationFixture();
        try {
          const alias = { ...f.binding, workspaceId: randomUUID(), sourceId: randomUUID() };
          await f.pool.execute(
            "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'alias',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
            [alias.workspaceId, alias.ownerId],
          );
          await f.pool.execute(
            "INSERT INTO data_source (id,ownerId,connectorId,name,createdAt,updatedAt) VALUES (?,?,?,'alias',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
            [alias.sourceId, alias.ownerId, alias.connectorId],
          );
          await f.pool.execute(
            "INSERT INTO workspace_data_source (workspaceId,sourceId,boundAt) VALUES (?,?,UTC_TIMESTAMP(3))",
            [alias.workspaceId, alias.sourceId],
          );
          const first = f.preview();
          await f.store.savePreview(f.binding, first);
          const started = await f.store.confirm(f.binding, f.sessionId, {
            confirmationId: randomUUID(),
            previewId: first.previewId,
            commitment: first.commitment,
            revision: 1,
          });
          const second = f.preview({ targetIdentity: first.targetIdentity });
          await f.store.savePreview(alias, second);
          const confirmation = {
            confirmationId: randomUUID(),
            previewId: second.previewId,
            commitment: second.commitment,
            revision: 1,
          };
          const aliasRecord =
            phase === "confirm"
              ? null
              : (await f.store.confirm(alias, f.sessionId, confirmation)).execution;
          const binding = aliasRecord
            ? executionBindingSchema.parse(
                Object.fromEntries(
                  Object.keys(executionBindingSchema.shape).map((key) => [
                    key,
                    Reflect.get(aliasRecord, key),
                  ]),
                ),
              )
            : null;
          if (phase === "permit" && binding) await f.store.claim(alias, binding);
          let releaseFreeze!: () => void;
          let freezeReady!: () => void;
          const held = new Promise<void>((resolve) => {
            releaseFreeze = resolve;
          });
          const ready = new Promise<void>((resolve) => {
            freezeReady = resolve;
          });
          const paused: BoundSourceAccess = {
            withBoundSnapshot: (owner, workspace, source, action) =>
              f.sources.withBoundSnapshot(owner, workspace, source, async (c, snapshot) => {
                const value = await action(c, snapshot);
                freezeReady();
                await held;
                return value;
              }),
          };
          const freezing = new MutationStore(
            f.pool,
            paused,
            f.boot,
            authSessionReferenceActive,
          ).update(f.binding, started.execution.executionId, "outcome_unknown", "lost_receipt");
          await ready; // The real transaction owns the shared physical-target row; not committed yet.
          let aliasReady!: () => void;
          const aliasReadView = new Promise<void>((resolve) => {
            aliasReady = resolve;
          });
          const aliasAccess: BoundSourceAccess = {
            withBoundSnapshot: (owner, workspace, source, action) =>
              f.sources.withBoundSnapshot(owner, workspace, source, async (c, snapshot) => {
                // withBoundSnapshot has already performed its consistent snapshot read.
                // A non-locking freeze lookup here could see the old RR read view.
                aliasReady();
                return action(c, snapshot);
              }),
          };
          const aliasStore = new MutationStore(
            f.pool,
            aliasAccess,
            f.boot,
            authSessionReferenceActive,
          );
          const competing =
            phase === "confirm"
              ? aliasStore.confirm(alias, f.sessionId, confirmation)
              : phase === "claim" && binding
                ? aliasStore.claim(alias, binding)
                : binding
                  ? aliasStore.permit(
                      alias,
                      { ...binding, challenge: randomBytes(32).toString("base64url") },
                      {
                        async sign() {
                          throw Error("frozen alias must not sign");
                        },
                      },
                    )
                  : Promise.reject(Error("missing alias binding"));
          await aliasReadView;
          releaseFreeze();
          await freezing;
          await assert.rejects(
            () => competing,
            (error: unknown) => error instanceof MutationError && error.code === "FROZEN",
          );
          if (aliasRecord)
            assert.equal(
              (await f.store.get(alias, aliasRecord.executionId)).state,
              phase === "claim" ? "registered" : "running",
            );
          await f.store.update(f.binding, started.execution.executionId, "committed", null);
          await assert.rejects(
            () => f.store.savePreview(alias, f.preview({ targetIdentity: first.targetIdentity })),
            /FROZEN/,
          );
        } finally {
          await f.close();
        }
      });
  },
);

test(
  "orphan and conflicting target receipts freeze their physical target without fabricating execution authority",
  integration,
  async () => {
    const f = await mutationFixture();
    try {
      const p = f.preview();
      await f.store.savePreview(f.binding, p);
      const known = await f.store.confirm(f.binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: p.previewId,
        commitment: p.commitment,
        revision: 1,
      });
      const matching = {
        executionId: known.execution.executionId,
        commitment: p.commitment,
        targetIdentity: p.targetIdentity,
        targetEpoch: p.targetEpoch,
        scope: f.binding,
        rowCount: 1,
      };
      assert.deepEqual(await f.store.reconcileReceipts(f.binding, [matching]), {
        items: [],
        metadataError: null,
      });
      assert.equal(await f.store.targetFrozen(f.binding, p.targetIdentity), false);
      const orphan = {
        ...matching,
        executionId: randomUUID(),
        commitment: randomBytes(32).toString("base64url"),
      };
      const found = await f.store.reconcileReceipts(f.binding, [matching, orphan]);
      assert.equal(found.items[0]?.executionId, orphan.executionId);
      assert.equal(found.items.length, 1);
      assert.equal(found.metadataError, "orphaned_receipt");
      assert.equal(await f.store.targetFrozen(f.binding, p.targetIdentity), true);
      const [rows] = await f.pool.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM mutation_preview) AS previews,(SELECT COUNT(*) FROM mutation_confirmation) AS confirmations,(SELECT COUNT(*) FROM mutation_execution) AS executions",
      );
      assert.equal(rows[0]?.previews, 1);
      assert.equal(rows[0]?.confirmations, 1);
      assert.equal(rows[0]?.executions, 1);
      const mismatch = { ...matching, commitment: randomBytes(32).toString("base64url") };
      assert.equal(
        (await f.store.reconcileReceipts(f.binding, [mismatch])).metadataError,
        "receipt_mismatch",
      );
      await assert.rejects(
        () =>
          f.store.reconcileReceipts(f.binding, [
            { ...orphan, scope: { ...f.binding, workspaceId: randomUUID() } },
          ]),
        /DENIED/,
      );
      await assert.rejects(() => f.store.savePreview(f.binding, f.preview()), /FROZEN/);
    } finally {
      await f.close();
    }
  },
);

test(
  "unknown reconciliation deadline is retained as metadata and repeated results cannot extend it",
  integration,
  async () => {
    const f = await mutationFixture();
    try {
      const p = f.preview();
      await f.store.savePreview(f.binding, p);
      const { execution } = await f.store.confirm(f.binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: p.previewId,
        commitment: p.commitment,
        revision: 1,
      });
      const deadline = new Date(Date.now() + 86400000).toISOString();
      assert.equal(
        (
          await f.store.update(
            f.binding,
            execution.executionId,
            "outcome_unknown",
            "connection_lost",
            deadline,
          )
        ).reconciliationExpiresAt,
        deadline,
      );
      await assert.rejects(() => f.store.cancel(f.binding, execution.executionId), /CONFLICT/);
      await f.store.update(
        f.binding,
        execution.executionId,
        "outcome_unknown",
        "connection_lost",
        deadline,
      );
      await assert.rejects(
        () =>
          f.store.update(
            f.binding,
            execution.executionId,
            "outcome_unknown",
            "connection_lost",
            new Date(Date.parse(deadline) + 1000).toISOString(),
          ),
        /CONFLICT/,
      );
      const terminal = await f.store.update(f.binding, execution.executionId, "committed", null);
      assert.equal(terminal.reconciliationExpiresAt, deadline);
      assert.equal(await f.store.targetFrozen(f.binding, p.targetIdentity), true);
    } finally {
      await f.close();
    }
  },
);
