import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { BoundSourceAccess } from "../datasources/public.js";
import {
  type ConfirmationInput,
  type MutationBinding,
  MutationError,
  type MutationExecution,
  type MutationExecutionBinding,
  type MutationPermit,
  type MutationPermitRequest,
  type MutationScope,
  type MutationState,
  type PreviewMetadata,
  executionBindingSchema,
  type MutationReceiptSummary,
  previewMetadataSchema,
} from "./model.js";
import type { MutationAuditSink, MutationPermitSigner } from "./ports.js";
import { checkOutcomeTransition, validateOutcome } from "./outcome.js";

interface PreviewRow extends RowDataPacket {
  id: string;
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
  commitment: string;
  revision: number;
  apiBoot: string;
  connectorBoot: string;
  targetIdentity: string;
  targetEpoch: string;
  policyGeneration: string;
  installationGeneration: string;
  operation: "insert" | "update" | "delete";
  tableName: string;
  rowCount: number;
  expiresAt: Date;
  state: string;
}
interface ExecutionRow extends PreviewRow {
  executionId: string;
  confirmationId: string;
  sessionId: string;
  executionState: MutationState;
  cancelRequested: number;
  code: string | null;
  executionCreatedAt: Date;
  executionUpdatedAt: Date;
  permitIssued: number;
  reconciliationExpiresAt: Date | null;
  affectedRows: number | null;
  sequence: string;
}
interface ConfirmationRow extends RowDataPacket {
  id: string;
  previewId: string;
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  commitment: string;
  revision: number;
  state: string;
  executionId: string | null;
}
const scopeValues = (scope: MutationScope) => [scope.ownerId, scope.workspaceId, scope.sourceId];
const sameScope = (a: MutationScope, b: MutationScope) =>
  a.ownerId === b.ownerId && a.workspaceId === b.workspaceId && a.sourceId === b.sourceId;
const executionQuery =
  "SELECT p.*,e.id AS executionId,CAST(e.sequence AS CHAR) AS sequence,e.confirmationId,e.sessionId,e.state AS executionState,e.cancelRequested,EXISTS(SELECT 1 FROM mutation_permit pm WHERE pm.executionId=e.id) AS permitIssued,e.code,e.reconciliationExpiresAt,e.affectedRows,e.createdAt AS executionCreatedAt,e.updatedAt AS executionUpdatedAt FROM mutation_execution e JOIN mutation_preview p ON p.id=e.previewId";
function metadata(row: PreviewRow): PreviewMetadata {
  return previewMetadataSchema.parse({
    previewId: row.id,
    commitment: row.commitment,
    revision: row.revision,
    apiBoot: row.apiBoot,
    connectorBoot: row.connectorBoot,
    targetIdentity: row.targetIdentity,
    targetEpoch: row.targetEpoch,
    policyGeneration: row.policyGeneration,
    installationGeneration: row.installationGeneration,
    operation: row.operation,
    table: row.tableName,
    rowCount: row.rowCount,
    expiresAt: row.expiresAt.toISOString(),
  });
}
function execution(row: ExecutionRow): MutationExecution {
  return {
    ...metadata(row),
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    connectorId: row.connectorId,
    executionId: row.executionId,
    confirmationId: row.confirmationId,
    sessionId: row.sessionId,
    state: row.executionState,
    cancelRequested: row.cancelRequested === 1,
    permitIssued: Number(row.permitIssued) === 1,
    code: row.code,
    reconciliationExpiresAt: row.reconciliationExpiresAt?.toISOString() ?? null,
    affectedRows: row.affectedRows === null ? null : Number(row.affectedRows),
    createdAt: row.executionCreatedAt.toISOString(),
    updatedAt: row.executionUpdatedAt.toISOString(),
  };
}
function matchesBinding(record: MutationExecution, submitted: MutationExecutionBinding): boolean {
  const expected = executionBindingSchema.parse({
    ownerId: record.ownerId,
    workspaceId: record.workspaceId,
    sourceId: record.sourceId,
    connectorId: record.connectorId,
    executionId: record.executionId,
    previewId: record.previewId,
    commitment: record.commitment,
    revision: record.revision,
    apiBoot: record.apiBoot,
    connectorBoot: record.connectorBoot,
    targetIdentity: record.targetIdentity,
    targetEpoch: record.targetEpoch,
    policyGeneration: record.policyGeneration,
    installationGeneration: record.installationGeneration,
  });
  return Object.entries(expected).every(
    ([key, value]) => submitted[key as keyof MutationExecutionBinding] === value,
  );
}
function conflict(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "ER_DUP_ENTRY")
    throw new MutationError("CONFLICT");
  throw error;
}

/** Owns mutation_* only. The source public unit-of-work provides current binding locks. */
export class MutationStore {
  constructor(
    private readonly pool: Pool,
    private readonly sources: BoundSourceAccess,
    readonly apiBoot: string,
    private readonly sessionActive: (
      transaction: PoolConnection,
      ownerId: string,
      sessionId: string,
    ) => Promise<boolean>,
  ) {}
  private scoped<T>(
    scope: MutationScope,
    action: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    return this.sources.withBoundSnapshot(
      scope.ownerId,
      scope.workspaceId,
      scope.sourceId,
      (connection) => action(connection),
    );
  }
  private async lock(c: PoolConnection, scope: MutationScope, create = false): Promise<void> {
    if (create)
      await c.execute(
        "INSERT IGNORE INTO mutation_scope (ownerId,workspaceId,sourceId) VALUES (?,?,?)",
        scopeValues(scope),
      );
    await c.execute(
      "SELECT ownerId FROM mutation_scope WHERE ownerId=? AND workspaceId=? AND sourceId=? FOR UPDATE",
      scopeValues(scope),
    );
  }
  /** Locking current read avoids using the source unit-of-work's older RR snapshot.
   * All methods take workspace/source -> preview/execution -> target -> session.
   * A transaction never locks another workspace. Receipt conflict reconciliation
   * takes its bounded set of target identities in sorted order.
   */
  private async target(
    c: PoolConnection,
    identity: string,
    create = false,
    writing = true,
  ): Promise<boolean> {
    if (create)
      await c.execute(
        "INSERT IGNORE INTO mutation_target (identity,frozen,code) VALUES (?,0,NULL)",
        [identity],
      );
    const [rows] = await c.execute<RowDataPacket[]>(
      "SELECT frozen FROM mutation_target WHERE identity=? FOR UPDATE",
      [identity],
    );
    if (rows.length !== 1) throw new MutationError("UNAVAILABLE");
    const frozen = Number(rows[0]?.frozen) !== 0;
    if (writing && frozen) throw new MutationError("FROZEN");
    return frozen;
  }
  private async getWith(
    c: PoolConnection,
    scope: MutationScope,
    id: string,
    lock = false,
  ): Promise<MutationExecution> {
    const [rows] = await c.execute<ExecutionRow[]>(
      `${executionQuery} WHERE e.id=? AND p.ownerId=? AND p.workspaceId=? AND p.sourceId=?${lock ? " FOR UPDATE" : ""}`,
      [id, ...scopeValues(scope)],
    );
    if (!rows[0]) throw new MutationError("NOT_FOUND");
    return execution(rows[0]);
  }
  private async outbox(c: PoolConnection, scope: MutationScope, id: string, event: string) {
    await c.execute(
      "INSERT INTO mutation_outbox (id,executionId,ownerId,workspaceId,sourceId,event,delivered,createdAt) VALUES (?,?,?,?,?,?,0,UTC_TIMESTAMP(3))",
      [randomUUID(), id, ...scopeValues(scope), event],
    );
  }
  async savePreview(binding: MutationBinding, input: PreviewMetadata): Promise<void> {
    const p = previewMetadataSchema.parse(input);
    if (
      p.apiBoot !== this.apiBoot ||
      Date.parse(p.expiresAt) <= Date.now() ||
      Date.parse(p.expiresAt) > Date.now() + 125000
    )
      throw new MutationError("EXPIRED");
    try {
      await this.scoped(binding, async (c) => {
        await this.lock(c, binding, true);
        await this.target(c, p.targetIdentity, true);
        await c.execute(
          "INSERT INTO mutation_preview (id,ownerId,workspaceId,sourceId,connectorId,commitment,revision,apiBoot,connectorBoot,targetIdentity,targetEpoch,policyGeneration,installationGeneration,operation,tableName,rowCount,expiresAt,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',UTC_TIMESTAMP(3))",
          [
            p.previewId,
            ...scopeValues(binding),
            binding.connectorId,
            p.commitment,
            p.revision,
            p.apiBoot,
            p.connectorBoot,
            p.targetIdentity,
            p.targetEpoch,
            p.policyGeneration,
            p.installationGeneration,
            p.operation,
            p.table,
            p.rowCount,
            new Date(p.expiresAt),
          ],
        );
      });
    } catch (error) {
      conflict(error);
    }
  }
  async confirm(
    binding: MutationBinding,
    sessionId: string,
    input: ConfirmationInput,
  ): Promise<{ execution: MutationExecution; created: boolean }> {
    try {
      return await this.scoped(binding, async (c) => {
        await this.lock(c, binding);
        const [prior] = await c.execute<ConfirmationRow[]>(
          "SELECT * FROM mutation_confirmation WHERE id=? FOR UPDATE",
          [input.confirmationId],
        );
        if (prior[0]) {
          const old = prior[0];
          if (
            !sameScope(old, binding) ||
            old.previewId !== input.previewId ||
            old.commitment !== input.commitment ||
            old.revision !== input.revision ||
            old.state !== "registered" ||
            !old.executionId
          )
            throw new MutationError("CONFLICT");
          return { execution: await this.getWith(c, binding, old.executionId), created: false };
        }
        const [previews] = await c.execute<PreviewRow[]>(
          "SELECT * FROM mutation_preview WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=? FOR UPDATE",
          [input.previewId, ...scopeValues(binding)],
        );
        const p = previews[0];
        if (!p) throw new MutationError("NOT_FOUND");
        if (p.connectorId !== binding.connectorId || p.apiBoot !== this.apiBoot)
          throw new MutationError("STALE_BOOT");
        if (
          p.state !== "pending" ||
          p.commitment !== input.commitment ||
          p.revision !== input.revision
        )
          throw new MutationError("CONFLICT");
        if (p.expiresAt.getTime() <= Date.now()) throw new MutationError("EXPIRED");
        await this.target(c, p.targetIdentity);
        const id = randomUUID();
        await c.execute("UPDATE mutation_preview SET state='consumed' WHERE id=?", [p.id]);
        await c.execute(
          "INSERT INTO mutation_confirmation (id,previewId,ownerId,workspaceId,sourceId,commitment,revision,state,executionId) VALUES (?,?,?,?,?,?,?,'registered',?)",
          [
            input.confirmationId,
            p.id,
            ...scopeValues(binding),
            input.commitment,
            input.revision,
            id,
          ],
        );
        await c.execute(
          "INSERT INTO mutation_execution (id,confirmationId,previewId,sessionId,state,cancelRequested,code,createdAt,updatedAt) VALUES (?,?,?,?,'registered',0,NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
          [id, input.confirmationId, p.id, sessionId],
        );
        await this.outbox(c, binding, id, "mutation.confirmed");
        return { execution: await this.getWith(c, binding, id), created: true };
      });
    } catch (error) {
      conflict(error);
    }
  }
  get(scope: MutationScope, id: string): Promise<MutationExecution> {
    return this.scoped(scope, (c) => this.getWith(c, scope, id));
  }
  async confirmation(
    scope: MutationScope,
    id: string,
  ): Promise<{ state: "unseen" | "closed" | "registered"; execution: MutationExecution | null }> {
    return this.scoped(scope, async (c) => {
      const [rows] = await c.execute<ConfirmationRow[]>(
        "SELECT * FROM mutation_confirmation WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=?",
        [id, ...scopeValues(scope)],
      );
      const row = rows[0];
      if (!row) return { state: "unseen", execution: null };
      return {
        state: row.executionId ? "registered" : "closed",
        execution: row.executionId ? await this.getWith(c, scope, row.executionId) : null,
      };
    });
  }
  async closeConfirmation(
    scope: MutationScope,
    input: ConfirmationInput,
  ): Promise<MutationExecution | null> {
    try {
      return await this.scoped(scope, async (c) => {
        await this.lock(c, scope);
        const [rows] = await c.execute<PreviewRow[]>(
          "SELECT * FROM mutation_preview WHERE id=? AND ownerId=? AND workspaceId=? AND sourceId=? FOR UPDATE",
          [input.previewId, ...scopeValues(scope)],
        );
        const p = rows[0];
        if (!p || p.commitment !== input.commitment || p.revision !== input.revision)
          throw new MutationError("NOT_FOUND");
        const [prior] = await c.execute<ConfirmationRow[]>(
          "SELECT * FROM mutation_confirmation WHERE id=? FOR UPDATE",
          [input.confirmationId],
        );
        if (
          prior[0] &&
          (!sameScope(prior[0], scope) ||
            prior[0].previewId !== input.previewId ||
            prior[0].commitment !== input.commitment ||
            prior[0].revision !== input.revision)
        )
          throw new MutationError("CONFLICT");
        const [existing] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM mutation_execution WHERE previewId=?",
          [p.id],
        );
        if (existing[0]) return this.getWith(c, scope, String(existing[0].id));
        await c.execute(
          "UPDATE mutation_preview SET state='closed' WHERE id=? AND state='pending'",
          [p.id],
        );
        if (!prior[0])
          await c.execute(
            "INSERT INTO mutation_confirmation (id,previewId,ownerId,workspaceId,sourceId,commitment,revision,state,executionId) VALUES (?,?,?,?,?,?,?,'closed',NULL)",
            [input.confirmationId, p.id, ...scopeValues(scope), input.commitment, input.revision],
          );
        return null;
      });
    } catch (error) {
      conflict(error);
    }
  }
  async list(
    scope: MutationScope,
    after?: string,
  ): Promise<{ items: MutationExecution[]; nextCursor: string | null }> {
    return this.scoped(scope, (c) => this.listWith(c, scope, after));
  }
  private async listWith(c: PoolConnection, scope: MutationScope, after = "18446744073709551615") {
    if (!/^[1-9][0-9]{0,19}$/.test(after) || BigInt(after) > 18446744073709551615n)
      throw new MutationError("INVALID");
    const [rows] = await c.execute<ExecutionRow[]>(
      `${executionQuery} WHERE p.ownerId=? AND p.workspaceId=? AND p.sourceId=? AND e.sequence<? ORDER BY e.sequence DESC LIMIT 101`,
      [...scopeValues(scope), after],
    );
    const items = rows.slice(0, 100).map(execution);
    return { items, nextCursor: rows.length > 100 ? (rows[99]?.sequence ?? null) : null };
  }
  recovery(
    scope: MutationScope,
  ): Promise<{ items: MutationExecution[]; nextCursor: string | null }> {
    return this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      await c.execute(
        "UPDATE mutation_preview SET state='closed' WHERE ownerId=? AND workspaceId=? AND sourceId=? AND state='pending'",
        scopeValues(scope),
      );
      return this.listWith(c, scope);
    });
  }
  /** Receipt discovery never fabricates a preview/confirmation or retries an old task.
   * Missing or conflicting authority is a persistent physical-target freeze.
   */
  async reconcileReceipts(
    scope: MutationBinding,
    receipts: MutationReceiptSummary[],
  ): Promise<{
    items: MutationReceiptSummary[];
    metadataError: "orphaned_receipt" | "receipt_mismatch" | null;
  }> {
    if (receipts.length > 100) throw new MutationError("INVALID");
    if (
      receipts.some(
        (receipt) =>
          !sameScope(receipt.scope, scope) || receipt.scope.connectorId !== scope.connectorId,
      )
    )
      throw new MutationError("DENIED");
    if (!receipts.length) return { items: [], metadataError: null };
    return this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      const [rows] = await c.execute<ExecutionRow[]>(
        `${executionQuery} WHERE p.ownerId=? AND p.workspaceId=? AND p.sourceId=? AND e.id IN (${receipts.map(() => "?").join(",")})`,
        [...scopeValues(scope), ...receipts.map((item) => item.executionId)],
      );
      const known = new Map(rows.map((item) => [item.executionId, execution(item)]));
      const missing: MutationReceiptSummary[] = [];
      let metadataError: "orphaned_receipt" | "receipt_mismatch" | null = null;
      const freeze = new Map<string, { code: string; executionId: string }>();
      for (const receipt of receipts) {
        const record = known.get(receipt.executionId);
        if (
          record &&
          record.commitment === receipt.commitment &&
          record.targetIdentity === receipt.targetIdentity &&
          record.targetEpoch === receipt.targetEpoch &&
          record.connectorId === receipt.scope.connectorId
        )
          continue;
        missing.push(receipt);
        const code = record ? "receipt_mismatch" : "orphaned_receipt";
        if (record) metadataError = "receipt_mismatch";
        else metadataError ??= "orphaned_receipt";
        freeze.set(receipt.targetIdentity, { code, executionId: receipt.executionId });
        if (record) freeze.set(record.targetIdentity, { code, executionId: receipt.executionId });
      }
      for (const [identity, reason] of [...freeze.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const alreadyFrozen = await this.target(c, identity, true, false);
        await c.execute("UPDATE mutation_target SET frozen=1,code=? WHERE identity=?", [
          reason.code,
          identity,
        ]);
        if (!alreadyFrozen)
          await this.outbox(c, scope, reason.executionId, "mutation.target_frozen");
      }
      return { items: missing, metadataError };
    });
  }
  async targetFrozen(scope: MutationScope, identity: string): Promise<boolean> {
    return this.scoped(scope, async (c) => {
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT frozen FROM mutation_target WHERE identity=? FOR SHARE",
        [identity],
      );
      return rows.length > 0 && Number(rows[0]?.frozen) !== 0;
    });
  }
  async cancel(scope: MutationScope, id: string): Promise<MutationExecution> {
    return this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      const record = await this.getWith(c, scope, id, true);
      if (record.state !== "registered" && record.state !== "running")
        throw new MutationError("CONFLICT");
      const [permits] = await c.execute<RowDataPacket[]>(
        "SELECT executionId FROM mutation_permit WHERE executionId=? FOR SHARE",
        [id],
      );
      if (permits.length) throw new MutationError("CONFLICT");
      if (record.cancelRequested) return record;
      await c.execute(
        "UPDATE mutation_execution SET cancelRequested=1,updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
        [id],
      );
      await this.outbox(c, scope, id, "mutation.cancelled");
      return this.getWith(c, scope, id);
    });
  }
  async claim(scope: MutationScope, submitted: MutationExecutionBinding): Promise<void> {
    await this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      const record = await this.getWith(c, scope, submitted.executionId, true);
      if (
        !matchesBinding(record, submitted) ||
        record.apiBoot !== this.apiBoot ||
        record.cancelRequested ||
        record.state !== "registered"
      )
        throw new MutationError("DENIED");
      await this.target(c, record.targetIdentity);
      if (!(await this.sessionActive(c, record.ownerId, record.sessionId)))
        throw new MutationError("DENIED");
      await c.execute(
        "UPDATE mutation_execution SET state='running',updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
        [record.executionId],
      );
    });
  }
  async permit(
    scope: MutationScope,
    request: MutationPermitRequest,
    signer: MutationPermitSigner,
  ): Promise<MutationPermit> {
    return this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      const record = await this.getWith(c, scope, request.executionId, true);
      if (
        !matchesBinding(record, request) ||
        record.apiBoot !== this.apiBoot ||
        record.cancelRequested ||
        !["running", "commit_intent"].includes(record.state)
      )
        throw new MutationError("DENIED");
      await this.target(c, record.targetIdentity);
      if (!(await this.sessionActive(c, record.ownerId, record.sessionId)))
        throw new MutationError("DENIED");
      const [rows] = await c.execute<RowDataPacket[]>(
        "SELECT request,permitId,signature FROM mutation_permit WHERE executionId=?",
        [record.executionId],
      );
      if (rows[0]) {
        const stored: unknown =
          typeof rows[0].request === "string" ? JSON.parse(rows[0].request) : rows[0].request;
        if (JSON.stringify(stored) !== JSON.stringify(request)) {
          // MySQL JSON key ordering is not transport order. Compare explicit fields.
          if (
            !stored ||
            typeof stored !== "object" ||
            Object.keys(request).some(
              (key) => Reflect.get(stored, key) !== request[key as keyof MutationPermitRequest],
            ) ||
            Object.keys(stored).length !== Object.keys(request).length
          )
            throw new MutationError("CONFLICT");
        }
        return {
          ...request,
          permitId: String(rows[0].permitId),
          budgetMillis: 3000,
          signature: String(rows[0].signature),
        };
      }
      const unsigned = { ...request, permitId: randomUUID(), budgetMillis: 3000 as const };
      const signature = await signer.sign(unsigned);
      if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new MutationError("UNAVAILABLE");
      await c.execute(
        "INSERT INTO mutation_permit (executionId,permitId,request,signature) VALUES (?,?,?,?)",
        [record.executionId, unsigned.permitId, JSON.stringify(request), signature],
      );
      return { ...unsigned, signature };
    });
  }
  async update(
    scope: MutationScope,
    id: string,
    state: MutationState,
    code: string | null,
    reconciliationExpiresAt: string | null = null,
    affectedRows: number | null = null,
  ): Promise<MutationExecution> {
    const normalizedExpiry = validateOutcome(
      state,
      code,
      reconciliationExpiresAt,
      affectedRows,
      Date.now(),
    );
    return this.scoped(scope, async (c) => {
      await this.lock(c, scope);
      const prior = await this.getWith(c, scope, id, true);
      if (checkOutcomeTransition(prior, state, normalizedExpiry, affectedRows) === "unchanged")
        return prior;
      await this.target(c, prior.targetIdentity, false, false);
      if (state === "outcome_unknown")
        await c.execute("UPDATE mutation_target SET frozen=1,code=? WHERE identity=?", [
          code ?? "outcome_unknown",
          prior.targetIdentity,
        ]);
      await c.execute(
        "UPDATE mutation_execution SET state=?,code=?,reconciliationExpiresAt=COALESCE(?,reconciliationExpiresAt),affectedRows=COALESCE(?,affectedRows),updatedAt=UTC_TIMESTAMP(3) WHERE id=?",
        [
          state,
          code,
          reconciliationExpiresAt === null ? null : new Date(reconciliationExpiresAt),
          affectedRows,
          id,
        ],
      );
      if (prior.state !== state) await this.outbox(c, scope, id, "mutation.state_changed");
      return this.getWith(c, scope, id);
    });
  }
  /** Startup fences stale metadata. It never schedules or retries a target task. */
  async recoverPreviousBoot(): Promise<void> {
    const c = await this.pool.getConnection();
    try {
      await c.beginTransaction();
      // Startup happens before serving mutations. Keep target ordering stable;
      // persisted freezes do not clear if a later receipt proves an old result.
      const [stale] = await c.execute<RowDataPacket[]>(
        "SELECT DISTINCT p.targetIdentity FROM mutation_execution e JOIN mutation_preview p ON p.id=e.previewId WHERE p.apiBoot<>? AND e.state IN ('registered','running','commit_intent') ORDER BY p.targetIdentity",
        [this.apiBoot],
      );
      for (const row of stale) {
        await this.target(c, String(row.targetIdentity), false, false);
        await c.execute(
          "UPDATE mutation_target SET frozen=1,code='process_restarted' WHERE identity=?",
          [row.targetIdentity],
        );
      }
      await c.execute(
        "UPDATE mutation_preview SET state='closed' WHERE state='pending' AND apiBoot<>?",
        [this.apiBoot],
      );
      await c.execute(
        "UPDATE mutation_execution e JOIN mutation_preview p ON p.id=e.previewId SET e.state='outcome_unknown',e.code='process_restarted',e.updatedAt=UTC_TIMESTAMP(3) WHERE p.apiBoot<>? AND e.state IN ('registered','running','commit_intent')",
        [this.apiBoot],
      );
      await c.commit();
    } catch (error) {
      await c.rollback();
      throw error;
    } finally {
      c.release();
    }
  }
  async flushAudit(sink: MutationAuditSink): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      "SELECT * FROM mutation_outbox WHERE delivered=0 ORDER BY createdAt,id LIMIT 100",
    );
    for (const row of rows) {
      const event: unknown = row.event;
      if (
        event !== "mutation.confirmed" &&
        event !== "mutation.cancelled" &&
        event !== "mutation.state_changed" &&
        event !== "mutation.target_frozen"
      )
        throw new MutationError("UNAVAILABLE");
      await sink.append(
        {
          ownerId: String(row.ownerId),
          workspaceId: String(row.workspaceId),
          sourceId: String(row.sourceId),
        },
        String(row.id),
        event,
        String(row.executionId),
      );
      await this.pool.execute("UPDATE mutation_outbox SET delivered=1 WHERE id=?", [row.id]);
    }
  }
}
