import { validReadQueryResult as validResult } from "@shuriva/core-contracts";
import { createHmac, randomBytes } from "node:crypto";
import { decodeModelSchema } from "../ai/public.js";
import type { ReadCancel, ReadTask } from "../protocol/read-task.js";
import type { ExecutionState, ExecutionSummary } from "./journal.js";

type Scope = { ownerId: string; connectorId: string; workspaceId: string; sourceId: string };
type SubmittedScope = Scope & { sessionId: string };
type Parameter = { kind: "string" | "integer" | "decimal" | "boolean" | "null"; value: string };
type State = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";
type Job = Scope & {
  sessionId: string | null;
  id: string;
  fingerprint: string | null;
  state: State;
  dispatched: boolean;
  payload: string;
  outcomePayload?: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  cancellationNonce: string;
  cancellationPending: boolean;
  retainedUntil: number;
  maxRows: number;
  operation: ReadTask["operation"];
  executionOutcome?: { state: ExecutionState; summary: ExecutionSummary };
};
type ReadDraft = Omit<ReadTask, "signature">;
type CancelDraft = Omit<ReadCancel, "signature">;
export type ReadWork = { type: "read"; task: ReadDraft } | { type: "cancel"; task: CancelDraft };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actor = /^[A-Za-z0-9._:-]{1,128}$/;
const kinds = new Set(["string", "integer", "decimal", "boolean", "null"]);
const failureCodes = new Set<string>([
  "denied",
  "unavailable",
  "cancelled",
  "timeout",
  "error",
  "outcome_unknown",
  "schema_changed",
]);

/** Shared validation for the signed delegated query and schema tasks. */
function validatedDelegation(delegatedScope: unknown): Record<string, string[]> {
  if (!Array.isArray(delegatedScope) || delegatedScope.length < 1 || delegatedScope.length > 256)
    throw new Error("INVALID");
  const validated: Record<string, string[]> = Object.create(null);
  let scopeBytes = 2;
  let tableCount = 0;
  for (const entry of delegatedScope as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("INVALID");
    const [table, columns]: unknown[] = entry;
    if (
      typeof table !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table) ||
      Object.hasOwn(validated, table) ||
      !Array.isArray(columns) ||
      columns.length < 1 ||
      columns.length > 256
    )
      throw new Error("INVALID");
    scopeBytes += table.length + 5 + (tableCount++ > 0 ? 1 : 0);
    if (scopeBytes > 24576) throw new Error("INVALID");
    const accepted: string[] = [];
    for (const column of columns as unknown[]) {
      if (typeof column !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(column))
        throw new Error("INVALID");
      scopeBytes += column.length + 2 + (accepted.length > 0 ? 1 : 0);
      if (scopeBytes > 24576) throw new Error("INVALID");
      accepted.push(column);
    }
    if (new Set(accepted).size !== accepted.length) throw new Error("INVALID");
    validated[table] = accepted;
  }
  return validated;
}

/** Validate the exact delegated signed-task budget before human approval. */
export function validateDelegatedRead(
  input: {
    sql: string;
    parameters: Array<{ kind: string; value: string }>;
    maxRows: number;
    schemaVersion: string | null;
  },
  tables: unknown,
): void {
  const delegatedScope = validatedDelegation(tables);
  if (
    Buffer.byteLength(input.sql) < 1 ||
    Buffer.byteLength(input.sql) > 16384 ||
    input.parameters.length > 64 ||
    input.parameters.some((p) => !kinds.has(p.kind) || Buffer.byteLength(p.value) > 4096) ||
    !Number.isInteger(input.maxRows) ||
    input.maxRows < 1 ||
    input.maxRows > 1000 ||
    (input.schemaVersion !== null && !/^[0-9a-f]{64}$/.test(input.schemaVersion))
  )
    throw new Error("INVALID");
  if (
    Buffer.from(
      JSON.stringify({
        sql: input.sql,
        parameters: input.parameters,
        maxRows: input.maxRows,
        schemaVersion: input.schemaVersion,
        delegatedScope,
      }),
    ).toString("base64url").length > 32768
  )
    throw new Error("INVALID");
}
/** Bounded, ephemeral task storage. Callers must authenticate and recheck scope. */
export class ReadJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly fingerprintKey = randomBytes(32);
  private readonly cleanup: NodeJS.Timeout;
  constructor(private readonly now: () => number = Date.now) {
    this.cleanup = setInterval(() => this.prune(), 5000);
    this.cleanup.unref();
  }

  close(): void {
    clearInterval(this.cleanup);
    this.jobs.clear();
  }

  /** Metadata for a previously authorized execution; no query text or parameters. */
  executionState(
    scope: Scope,
    id: string,
  ): { state: ExecutionState; summary: ExecutionSummary } | null {
    this.prune();
    const job = this.find(scope, id);
    if (!job) return null;
    const outcome = job.executionOutcome;
    return outcome
      ? { state: outcome.state, summary: { ...outcome.summary } }
      : { state: job.state, summary: {} };
  }

  /** This dispatch identity differs if an expired request ID is enqueued again. */
  executionIdentity(scope: Scope, id: string): string | null {
    this.prune();
    const job = this.find(scope, id);
    return job?.operation === "read_query" ? job.nonce : null;
  }

  sessionIdentity(
    scope: Scope,
    id: string,
  ): { ownerId: string; sessionId: string; taskNonce: string } | null {
    this.prune();
    const job = this.find(scope, id);
    return job?.sessionId
      ? { ownerId: job.ownerId, sessionId: job.sessionId, taskNonce: job.nonce }
      : null;
  }

  /** Result disposal and later authorization changes must not rewrite execution history. */
  private finishExecution(
    job: Job,
    state: ExecutionState,
    summary: ExecutionSummary = {},
    cause: "lifecycle" | "verified-result" = "lifecycle",
  ): void {
    if (!job.executionOutcome)
      job.executionOutcome =
        cause === "lifecycle" && job.dispatched
          ? { state: "outcome_unknown", summary: { code: "outcome_unknown" } }
          : { state, summary: { ...summary } };
  }

  create(
    scope: SubmittedScope,
    requestId: unknown,
    sql: unknown,
    parameters: unknown,
    maxRows: unknown,
    schemaVersion?: unknown,
  ): string {
    return this.createRead(scope, requestId, sql, parameters, maxRows, schemaVersion, null);
  }

  /** Only application use cases with a verified delegation may call this path. */
  createDelegated(
    scope: SubmittedScope,
    requestId: unknown,
    sql: unknown,
    parameters: unknown,
    maxRows: unknown,
    schemaVersion: unknown,
    delegatedScope: unknown,
  ): string {
    return this.createRead(
      scope,
      requestId,
      sql,
      parameters,
      maxRows,
      schemaVersion,
      validatedDelegation(delegatedScope),
    );
  }

  private createRead(
    scope: SubmittedScope,
    requestId: unknown,
    sql: unknown,
    parameters: unknown,
    maxRows: unknown,
    schemaVersion: unknown,
    delegatedScope: Record<string, string[]> | null,
  ): string {
    this.prune();
    if (
      !actor.test(scope.ownerId) ||
      !uuid.test(scope.connectorId) ||
      !uuid.test(scope.workspaceId) ||
      !uuid.test(scope.sourceId) ||
      typeof requestId !== "string" ||
      !uuid.test(requestId) ||
      typeof sql !== "string" ||
      Buffer.byteLength(sql) === 0 ||
      Buffer.byteLength(sql) > 16384 ||
      !Array.isArray(parameters) ||
      parameters.length > 64 ||
      !Number.isSafeInteger(maxRows) ||
      Number(maxRows) < 1 ||
      Number(maxRows) > 1000
    )
      throw new Error("INVALID");
    if (
      schemaVersion !== undefined &&
      schemaVersion !== null &&
      (typeof schemaVersion !== "string" || !/^[0-9a-f]{64}$/.test(schemaVersion))
    )
      throw new Error("INVALID");
    const params: Parameter[] = [];
    for (const value of parameters) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID");
      const item = value as Record<string, unknown>;
      if (
        Object.keys(item).length !== 2 ||
        typeof item.kind !== "string" ||
        !kinds.has(item.kind) ||
        typeof item.value !== "string" ||
        Buffer.byteLength(item.value) > 4096
      )
        throw new Error("INVALID");
      params.push({ kind: item.kind as Parameter["kind"], value: item.value });
    }
    if (delegatedScope)
      validateDelegatedRead(
        {
          sql,
          parameters: params,
          maxRows: Number(maxRows),
          schemaVersion: typeof schemaVersion === "string" ? schemaVersion : null,
        },
        Object.entries(delegatedScope),
      );
    const payload = Buffer.from(
      JSON.stringify({
        sql,
        parameters: params,
        maxRows,
        schemaVersion: schemaVersion ?? null,
        delegatedScope,
      }),
    ).toString("base64url");
    if (payload.length > 32768) throw new Error("INVALID");
    return this.enqueue(scope, requestId, payload, Number(maxRows), "read_query");
  }

  /** A fresh signed Connector task discloses only its local model-authorized schema. */
  createModelSchema(scope: SubmittedScope, requestId: unknown): string {
    return this.createModelTask(scope, requestId, "model_schema");
  }

  /** Schema disclosure for a verified delegation must use this narrower path. */
  createDelegatedModelSchema(
    scope: SubmittedScope,
    requestId: unknown,
    delegatedScope: unknown,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ delegatedScope: validatedDelegation(delegatedScope) }),
    ).toString("base64url");
    if (payload.length > 32768) throw new Error("INVALID");
    return this.createModelTask(scope, requestId, "model_schema", payload);
  }

  createModelAuthorization(scope: SubmittedScope, requestId: unknown): string {
    return this.createModelTask(scope, requestId, "model_authorize");
  }

  private createModelTask(
    scope: SubmittedScope,
    requestId: unknown,
    operation: "model_schema" | "model_authorize",
    payload = Buffer.from("{}").toString("base64url"),
  ): string {
    this.prune();
    if (
      !actor.test(scope.ownerId) ||
      !uuid.test(scope.connectorId) ||
      !uuid.test(scope.workspaceId) ||
      !uuid.test(scope.sourceId) ||
      typeof requestId !== "string" ||
      !uuid.test(requestId)
    )
      throw new Error("INVALID");
    return this.enqueue(scope, requestId, payload, 0, operation);
  }

  private enqueue(
    scope: SubmittedScope,
    requestId: string,
    payload: string,
    maxRows: number,
    operation: ReadTask["operation"],
  ): string {
    if (!uuid.test(scope.sessionId)) throw new Error("INVALID");
    const fingerprint = createHmac("sha256", this.fingerprintKey)
      .update(operation)
      .update(scope.sessionId)
      .update("\0")
      .update(payload)
      .digest("hex");
    const existing = this.jobs.get(requestId);
    if (existing) {
      if (
        !this.find(scope, requestId) ||
        (existing.fingerprint !== null && existing.fingerprint !== fingerprint)
      )
        throw new Error("CONFLICT");
      return requestId;
    }
    const retained = [...this.jobs.values()];
    const active = retained.filter(
      (job) => ["queued", "running"].includes(job.state) || job.cancellationPending,
    ).length;
    if (active >= 16) throw new Error("CAPACITY");
    // Reserve room for active queries; never silently discard an unread result.
    if (active + retained.filter((job) => job.state === "completed").length >= 32)
      throw new Error("RESULT_CAPACITY");
    // Keep bounded idempotency tombstones for their complete retention period;
    // evicting one early could allow a lost-response retry to execute twice.
    if (this.jobs.size >= 2048) throw new Error("CAPACITY");
    const id = requestId;
    const issuedAt = Math.floor(this.now() / 1000);
    this.jobs.set(id, {
      ...scope,
      id,
      fingerprint,
      state: "queued",
      dispatched: false,
      payload,
      issuedAt,
      expiresAt: issuedAt + (operation === "model_authorize" ? 30 : 60),
      nonce: randomBytes(32).toString("base64url"),
      cancellationNonce: randomBytes(32).toString("base64url"),
      cancellationPending: false,
      retainedUntil: issuedAt + 360,
      maxRows,
      operation,
    });
    return id;
  }

  /** Called only after validating the connector and current binding. */
  claim(connectorId: string): ReadWork | null {
    this.prune();
    const cancel = [...this.jobs.values()].find(
      (j) => j.connectorId === connectorId && j.cancellationPending,
    );
    if (cancel)
      return {
        type: "cancel",
        task: {
          taskId: cancel.id,
          connectorId,
          actorId: cancel.ownerId,
          workspaceId: cancel.workspaceId,
          sourceId: cancel.sourceId,
          issuedAt: cancel.issuedAt,
          expiresAt: cancel.expiresAt,
          nonce: cancel.cancellationNonce,
        },
      };
    const job =
      [...this.jobs.values()].find((j) => j.connectorId === connectorId && j.state === "running") ??
      [...this.jobs.values()].find((j) => j.connectorId === connectorId && j.state === "queued");
    if (!job) return null;
    if (job.operation === "model_authorize" && job.state === "queued") {
      // The Connector enforces a two-second clock/transport bound on first
      // dispatch; queue waiting must not consume that bound.
      job.issuedAt = Math.floor(this.now() / 1000);
      job.expiresAt = job.issuedAt + 30;
    }
    const task: ReadDraft = {
      id: job.id,
      connectorId,
      actorId: job.ownerId,
      workspaceId: job.workspaceId,
      sourceId: job.sourceId,
      operation: job.operation,
      payload: job.payload,
      issuedAt: job.issuedAt,
      expiresAt: job.expiresAt,
      nonce: job.nonce,
      protocol: 1,
    };
    job.state = "running";
    return { type: "read", task };
  }

  busy(connectorId: string): boolean {
    this.prune();
    return [...this.jobs.values()].some(
      (job) =>
        job.connectorId === connectorId && (job.state === "running" || job.cancellationPending),
    );
  }

  /** Cancel any active work immediately after a matching authorization changes. */
  cancelMatching(
    ownerId: string,
    workspaceId?: string,
    sourceId?: string,
    connectorId?: string,
  ): void {
    for (const job of this.jobs.values()) {
      if (
        job.ownerId === ownerId &&
        (!workspaceId || job.workspaceId === workspaceId) &&
        (!sourceId || job.sourceId === sourceId) &&
        (!connectorId || job.connectorId === connectorId)
      ) {
        if (job.state === "completed" || job.state === "failed") {
          job.state = "cancelled";
          job.outcomePayload = undefined;
        } else {
          this.cancel(job, job.id);
        }
      }
    }
  }

  /** A semantic edit affects model context, not independent read tasks or retained results. */
  cancelModelMatching(ownerId: string, workspaceId: string, sourceId: string): void {
    for (const job of this.jobs.values()) {
      if (
        job.ownerId === ownerId &&
        job.workspaceId === workspaceId &&
        job.sourceId === sourceId &&
        (job.operation === "model_schema" || job.operation === "model_authorize")
      ) {
        this.cancel(job, job.id);
      }
    }
  }

  /** A revoked identity can no longer receive cancellation tasks or results. */
  revokeConnector(ownerId: string, connectorId: string): void {
    this.cancelMatching(ownerId, undefined, undefined, connectorId);
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId && job.connectorId === connectorId)
        job.cancellationPending = false;
    }
  }

  reject(scope: Scope, id: string, taskNonce: string): void {
    const job = this.find(scope, id);
    if (job?.state === "running" && job.nonce === taskNonce && !job.dispatched) {
      job.state = "failed";
      job.outcomePayload = "denied";
      job.payload = "";
      this.finishExecution(job, "failed", { code: "denied" });
    }
  }

  /** Publication can have reached the Connector even if the HTTP reply is lost. */
  markDispatched(scope: Scope, id: string, taskNonce: string): boolean {
    const job = this.find(scope, id);
    if (job?.state !== "running" || job.nonce !== taskNonce) return false;
    job.dispatched = true;
    return true;
  }

  clearCancellation(scope: Scope, id: string): void {
    const job = this.find(scope, id);
    if (job) job.cancellationPending = false;
  }

  /** A result must refer to this exact dispatch, even after a process restart. */
  matchesResultNonce(scope: Scope, id: string, taskNonce: string): boolean {
    const job = this.find(scope, id);
    return (
      !!job &&
      (taskNonce === job.nonce ||
        (job.state === "cancelled" &&
          job.cancellationPending &&
          taskNonce === job.cancellationNonce))
    );
  }

  cancel(scope: Scope, id: string): boolean {
    this.prune();
    if (!uuid.test(id)) return false;
    let job = this.find(scope, id);
    if (!job) {
      if (this.jobs.has(id)) return false;
      if (this.jobs.size >= 2048) throw new Error("CAPACITY");
      const issuedAt = Math.floor(this.now() / 1000);
      // A DELETE can arrive before the corresponding POST. Retain a scoped
      // cancellation tombstone so a late POST with this ID cannot execute.
      job = {
        ...scope,
        sessionId: null,
        id,
        fingerprint: null,
        state: "cancelled",
        dispatched: false,
        payload: "",
        issuedAt,
        expiresAt: issuedAt + 60,
        nonce: "",
        cancellationNonce: "",
        cancellationPending: false,
        retainedUntil: issuedAt + 360,
        maxRows: 0,
        operation: "read_query",
      };
      this.jobs.set(id, job);
      this.finishExecution(job, "cancelled");
      return true;
    }
    if (job.state === "cancelled") return true;
    if (job.state === "completed" || job.state === "failed") {
      job.state = "expired";
      job.outcomePayload = undefined;
      return true;
    }
    if (!["queued", "running"].includes(job.state)) return false;
    job.cancellationPending = job.state === "running";
    job.state = "cancelled";
    job.payload = "";
    this.finishExecution(job, "cancelled");
    return true;
  }

  /** Call only after verifying result signature and rechecking current binding. */
  complete(scope: Scope, id: string, outcome: "ok" | "failed", payload: string): boolean {
    this.prune();
    const job = this.find(scope, id);
    if (job?.state === "cancelled" && job.cancellationPending) {
      job.cancellationPending = false;
      return false;
    }
    if (job?.state !== "running") return false;
    if (outcome !== "ok" && outcome !== "failed") throw new Error("INVALID");
    const summary: ExecutionSummary = {};
    if (outcome === "failed") {
      if (!failureCodes.has(payload)) throw new Error("INVALID");
      summary.code = payload as NonNullable<ExecutionSummary["code"]>;
    } else {
      if (payload.length === 0 || payload.length > 1_398_102 || !/^[A-Za-z0-9_-]+$/.test(payload))
        throw new Error("INVALID");
      const data = Buffer.from(payload, "base64url");
      if (data.length > 1_048_576 || data.toString("base64url") !== payload)
        throw new Error("INVALID");
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
        const value: unknown = JSON.parse(decoded);
        if (job.operation === "model_schema") decodeModelSchema(value);
        else if (job.operation === "model_authorize") {
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== 3 ||
            !("database" in value) ||
            !("tables" in value) ||
            !("leaseExpiresAt" in value) ||
            value.leaseExpiresAt !== job.expiresAt
          )
            throw new Error("INVALID");
          decodeModelSchema({ database: value.database, tables: value.tables });
        } else {
          if (!validResult(value, job.maxRows)) throw new Error("INVALID");
          const result = value as {
            rows: unknown[];
            truncated: boolean;
            reason?: "rows" | "bytes" | "cell";
          };
          summary.rowCount = result.rows.length;
          summary.truncated = result.truncated;
          if (result.reason) summary.reason = result.reason;
        }
      } catch {
        throw new Error("INVALID");
      }
    }
    job.state = outcome === "ok" ? "completed" : "failed";
    job.outcomePayload = payload;
    job.payload = "";
    job.cancellationPending = false;
    this.finishExecution(
      job,
      summary.code === "outcome_unknown" ? "outcome_unknown" : job.state,
      summary,
      "verified-result",
    );
    return true;
  }

  /** Call only after rechecking the owner's current workspace/source access. */
  status(scope: Scope, id: string): { state: State; payload?: string } | null {
    this.prune();
    const job = this.find(scope, id);
    if (!job) return null;
    return job.outcomePayload === undefined
      ? { state: job.state }
      : { state: job.state, payload: job.outcomePayload };
  }

  /** Model context must come from a fresh, signed scope task, not the UI. */
  modelSchema(scope: Scope, id: string): ReturnType<typeof decodeModelSchema> | null {
    this.prune();
    const job = this.find(scope, id);
    if (
      job?.operation !== "model_schema" ||
      job.state !== "completed" ||
      !job.outcomePayload ||
      job.expiresAt <= Math.floor(this.now() / 1000)
    )
      return null;
    try {
      const data = Buffer.from(job.outcomePayload, "base64url");
      return decodeModelSchema(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown,
      );
    } catch {
      return null;
    }
  }

  modelAuthorization(
    scope: Scope,
    id: string,
  ): (ReturnType<typeof decodeModelSchema> & { leaseExpiresAt: number }) | null {
    this.prune();
    const job = this.find(scope, id);
    if (
      job?.operation !== "model_authorize" ||
      job.state !== "completed" ||
      !job.outcomePayload ||
      job.expiresAt <= Math.floor(this.now() / 1000)
    )
      return null;
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(job.outcomePayload, "base64url"),
        ),
      );
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("database" in value) ||
        !("tables" in value) ||
        !("leaseExpiresAt" in value) ||
        value.leaseExpiresAt !== job.expiresAt
      )
        return null;
      return {
        ...decodeModelSchema({ database: value.database, tables: value.tables }),
        leaseExpiresAt: job.expiresAt,
      };
    } catch {
      return null;
    }
  }

  prune(): void {
    const now = Math.floor(this.now() / 1000);
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now && (job.state === "queued" || job.state === "running")) {
        job.state = "expired";
        job.payload = "";
        this.finishExecution(job, job.dispatched ? "outcome_unknown" : "expired");
      }
      if (job.expiresAt <= now) job.cancellationPending = false;
      if (job.retainedUntil <= now) this.jobs.delete(id);
    }
  }

  private find(scope: Scope, id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job &&
      job.ownerId === scope.ownerId &&
      job.connectorId === scope.connectorId &&
      job.workspaceId === scope.workspaceId &&
      job.sourceId === scope.sourceId
      ? job
      : undefined;
  }
}
