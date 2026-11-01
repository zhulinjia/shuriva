import { randomBytes, randomUUID } from "node:crypto";
import { diagnostics } from "../logging/public.js";
import { ConnectorError, type QueryConnector } from "../connectors/public.js";
import { ScopeCoordinator, type ScopeSourceLookup } from "../datasources/public.js";
import { ReadJobs } from "./jobs.js";
import type { ExecutionState, ExecutionSummary, QueryJournal } from "./journal.js";
import type { ReadResult, ReadTask } from "../protocol/read-task.js";
import type { SessionAccess } from "../auth/public.js";

type Scope = { ownerId: string; connectorId: string; workspaceId: string; sourceId: string };
type CancelTask = Omit<ReadTask, "payload" | "operation"> & { operation: "cancel_read" };

/** In-memory orchestration for explicitly enabled read-only queries. */
export class ReadService {
  readonly jobs = new ReadJobs();
  readonly instanceId = randomUUID();
  private readonly bindingTokens = new Map<string, { connectorId: string; token: string }>();
  private readonly bindingWatchers = new Map<string, Set<AbortController>>();
  private readonly tracked = new Map<
    string,
    {
      scope: Scope;
      identity: string;
      started: number;
      last: string;
      terminal?: { state: ExecutionState; summary: ExecutionSummary };
    }
  >();
  private readonly journalTimer?: NodeJS.Timeout;
  private flushing = false;
  private closed = false;
  private readonly sessionWatches = new Set<() => void>();
  authenticate(headers: Parameters<SessionAccess["authenticate"]>[0]) {
    return this.sessions.authenticate(headers);
  }
  private async sessionActive(scope: Scope, id: string, nonce: string): Promise<boolean> {
    if (this.closed) return false;
    const identity = this.jobs.sessionIdentity(scope, id);
    return (
      identity?.taskNonce === nonce &&
      (await this.sessions.active(identity)) &&
      !this.closed &&
      this.jobs.sessionIdentity(scope, id)?.taskNonce === nonce
    );
  }
  async assertSession(scope: Scope, id: string, expectedSessionId?: string) {
    if (this.closed) throw new Error("STALE");
    const identity = this.jobs.sessionIdentity(scope, id);
    if (!identity || (expectedSessionId !== undefined && identity.sessionId !== expectedSessionId))
      throw new Error("STALE");
    const active = await this.sessions.active(identity);
    if (this.closed || this.jobs.sessionIdentity(scope, id)?.taskNonce !== identity.taskNonce)
      throw new Error("STALE");
    if (!active) {
      this.jobs.cancel(scope, id);
      throw new Error("STALE");
    }
    return identity;
  }
  /** Final sends recheck the database directly. Polling also aborts waits and
   * in-flight replies after logout, external reset or expiration. */
  async watchSession(scope: Scope, id: string, expectedSessionId?: string) {
    await this.assertSession(scope, id, expectedSessionId);
    if (this.closed) throw new Error("STALE");
    if (this.sessionWatches.size >= 16) throw new Error("CAPACITY");
    const controller = new AbortController();
    let checking = false;
    const dispose = () => {
      clearInterval(timer);
      this.sessionWatches.delete(stop);
    };
    const stop = () => {
      controller.abort();
      dispose();
    };
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.assertSession(scope, id, expectedSessionId)
        .catch(stop)
        .finally(() => {
          checking = false;
        });
    }, 500);
    timer.unref();
    this.sessionWatches.add(stop);
    return { signal: controller.signal, dispose };
  }
  /** Recheck current access and serialize publication with unbinding and Connector revocation. */
  async withCurrentReadScope<T>(
    scope: Omit<Scope, "connectorId">,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.withScope(scope, operation);
  }
  constructor(
    private readonly store: ScopeSourceLookup,
    private readonly registry: QueryConnector,
    private readonly sessions: SessionAccess,
    private readonly journal?: QueryJournal,
    readonly coordinator = new ScopeCoordinator(store, registry),
  ) {
    if (journal) {
      this.journalTimer = setInterval(() => {
        void this.flushHistory();
      }, 1000);
      this.journalTimer.unref();
    }
  }

  async trackExecution(scope: Scope, id: string): Promise<void> {
    if (!this.journal) {
      diagnostics.info("query.registered", {
        taskId: id,
        sourceId: scope.sourceId,
        connectorId: scope.connectorId,
        workspaceId: scope.workspaceId,
      });
      return;
    }
    const identity = this.jobs.executionIdentity(scope, id);
    const existing = this.tracked.get(id);
    if (identity === null || (existing && existing.identity !== identity)) {
      this.jobs.cancel(scope, id);
      throw new Error("CONFLICT");
    }
    if (existing) return;
    if (this.tracked.size >= 2048) {
      this.jobs.cancel(scope, id);
      throw new Error("CAPACITY");
    }
    try {
      const persisted = await this.journal.begin(scope, id, this.instanceId);
      const memory = this.jobs.executionState(scope, id);
      if (
        !persisted.created &&
        !["queued", "running"].includes(persisted.state) &&
        memory &&
        ["queued", "running"].includes(memory.state)
      )
        throw new Error("CONFLICT");
      if (!persisted.created && !["queued", "running"].includes(persisted.state)) return;
    } catch (error) {
      this.jobs.cancel(scope, id);
      throw error;
    }
    this.tracked.set(id, { scope, identity, started: Date.now(), last: "queued" });
    diagnostics.info("query.registered", {
      taskId: id,
      sourceId: scope.sourceId,
      connectorId: scope.connectorId,
      workspaceId: scope.workspaceId,
    });
  }

  /** Retry metadata writes in order; a lost platform process is recovered as unknown on startup. */
  async flushHistory(): Promise<void> {
    if (!this.journal || this.flushing) return;
    this.flushing = true;
    try {
      for (const [id, item] of this.tracked) {
        const current = item.terminal ??
          this.jobs.executionState(item.scope, id) ?? {
            state: "outcome_unknown" as const,
            summary: {},
          };
        const terminal = !["queued", "running"].includes(current.state);
        if (terminal && !item.terminal)
          item.terminal = {
            state: current.state,
            summary: { ...current.summary, durationMs: Math.max(0, Date.now() - item.started) },
          };
        const actual = item.terminal ?? current;
        if (actual.state === item.last && !terminal) continue;
        try {
          await this.journal.update(item.scope, id, actual.state, actual.summary);
          item.last = actual.state;
          if (terminal) this.tracked.delete(id);
        } catch (error) {
          diagnostics.warn("query.history_unavailable", { taskId: id }, error);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  close(): void {
    this.closed = true;
    for (const stop of this.sessionWatches) stop();
    this.sessionWatches.clear();
    if (this.journalTimer) clearInterval(this.journalTimer);
    this.jobs.close();
    this.bindingTokens.clear();
    for (const watchers of this.bindingWatchers.values())
      for (const watcher of watchers) watcher.abort();
    this.bindingWatchers.clear();
  }

  private bindingKey(scope: Pick<Scope, "ownerId" | "workspaceId" | "sourceId">): string {
    return JSON.stringify([scope.ownerId, scope.workspaceId, scope.sourceId]);
  }
  private validIntent(submittedAt: unknown): submittedAt is number {
    const now = Date.now();
    return (
      typeof submittedAt === "number" &&
      Number.isSafeInteger(submittedAt) &&
      submittedAt >= now - 120_000 &&
      submittedAt <= now + 30_000
    );
  }
  /** Must run under the workspace/connector authorization locks. */
  issueScope(scope: Scope): { instanceId: string; scopeToken: string } {
    const key = this.bindingKey(scope);
    let item = this.bindingTokens.get(key);
    if (item && item.connectorId !== scope.connectorId) {
      this.invalidateBinding(scope.ownerId, scope.workspaceId, scope.sourceId);
      item = undefined;
    }
    if (!item) {
      if (this.bindingTokens.size >= 2048) {
        const oldest = this.bindingTokens.keys().next().value;
        if (oldest !== undefined) this.invalidateKey(oldest);
      }
      item = { connectorId: scope.connectorId, token: randomBytes(32).toString("base64url") };
      this.bindingTokens.set(key, item);
    }
    return { instanceId: this.instanceId, scopeToken: item.token };
  }
  validScope(
    scope: Scope,
    instanceId: unknown,
    scopeToken: unknown,
    submittedAt: unknown,
  ): boolean {
    const item = this.bindingTokens.get(this.bindingKey(scope));
    return (
      this.validIntent(submittedAt) &&
      instanceId === this.instanceId &&
      typeof scopeToken === "string" &&
      item?.connectorId === scope.connectorId &&
      item.token === scopeToken
    );
  }
  invalidateBinding(ownerId: string, workspaceId: string, sourceId: string): void {
    const key = this.bindingKey({ ownerId, workspaceId, sourceId });
    this.invalidateKey(key);
  }
  private invalidateKey(key: string): void {
    this.bindingTokens.delete(key);
    this.abortModelWatchers(key);
  }
  private abortModelWatchers(key: string): void {
    const watchers = this.bindingWatchers.get(key);
    if (watchers) for (const watcher of watchers) watcher.abort();
    this.bindingWatchers.delete(key);
  }
  /** Semantic edits invalidate model disclosures without revoking read authorization. */
  invalidateModelContext(ownerId: string, workspaceId: string, sourceId: string): void {
    this.abortModelWatchers(this.bindingKey({ ownerId, workspaceId, sourceId }));
    this.jobs.cancelModelMatching(ownerId, workspaceId, sourceId);
  }
  /** Register while holding the workspace authorization lock. */
  watchBinding(scope: Scope): { signal: AbortSignal; dispose: () => void } {
    const key = this.bindingKey(scope);
    const watcher = new AbortController();
    let watchers = this.bindingWatchers.get(key);
    if (watchers?.size || this.bindingWatchers.size >= 16) throw new Error("CAPACITY");
    if (!watchers) {
      watchers = new Set();
      this.bindingWatchers.set(key, watchers);
    }
    watchers.add(watcher);
    return {
      signal: watcher.signal,
      dispose: () => {
        watchers?.delete(watcher);
        if (watchers?.size === 0 && this.bindingWatchers.get(key) === watchers)
          this.bindingWatchers.delete(key);
      },
    };
  }
  invalidateWorkspace(ownerId: string, workspaceId: string): void {
    for (const [key] of this.bindingTokens) {
      const scope = JSON.parse(key) as string[];
      if (scope[0] === ownerId && scope[1] === workspaceId) this.invalidateKey(key);
    }
  }
  invalidateConnector(ownerId: string, connectorId: string): void {
    for (const [key, item] of this.bindingTokens) {
      if (item.connectorId !== connectorId) continue;
      const scope = JSON.parse(key) as string[];
      if (scope[0] === ownerId && scope[1] && scope[2])
        this.invalidateBinding(ownerId, scope[1], scope[2]);
    }
  }

  /** Serialize authorization changes with publication in the same workspace. */
  async inWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.inWorkspace(workspaceId, operation);
  }

  private scope(task: {
    actorId: string;
    connectorId: string;
    workspaceId: string;
    sourceId: string;
  }): Scope {
    return {
      ownerId: task.actorId,
      connectorId: task.connectorId,
      workspaceId: task.workspaceId,
      sourceId: task.sourceId,
    };
  }

  async next(connectorId: string): Promise<ReadTask | CancelTask | null> {
    const work = this.jobs.claim(connectorId);
    if (!work) return null;
    const scope = this.scope(work.task);
    if (work.type === "cancel") {
      try {
        const cancel = await this.registry.issueReadCancel(work.task);
        return {
          id: cancel.taskId,
          connectorId: cancel.connectorId,
          actorId: cancel.actorId,
          workspaceId: cancel.workspaceId,
          sourceId: cancel.sourceId,
          operation: "cancel_read",
          issuedAt: cancel.issuedAt,
          expiresAt: cancel.expiresAt,
          nonce: cancel.nonce,
          protocol: 1,
          signature: cancel.signature,
        };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "DENIED")
          this.jobs.clearCancellation(scope, work.task.taskId);
        throw error;
      }
    }
    return this.inWorkspace(scope.workspaceId, async () => {
      // Transient database/signing errors leave the task available for retry.
      const source = await this.store.boundSource(scope.ownerId, scope.workspaceId, scope.sourceId);
      if (
        !source ||
        source.connectorId !== connectorId ||
        this.jobs.status(scope, work.task.id)?.state !== "running"
      ) {
        this.jobs.reject(scope, work.task.id, work.task.nonce);
        return null;
      }
      if (!(await this.sessionActive(scope, work.task.id, work.task.nonce))) {
        this.jobs.reject(scope, work.task.id, work.task.nonce);
        return null;
      }
      const signed = await this.registry.issueReadTask(work.task);
      await this.flushHistory();
      if (!(await this.sessionActive(scope, work.task.id, work.task.nonce))) {
        this.jobs.reject(scope, work.task.id, work.task.nonce);
        return null;
      }
      if (!this.jobs.markDispatched(scope, work.task.id, work.task.nonce)) return null;
      diagnostics.info("query.dispatched", {
        taskId: work.task.id,
        sourceId: scope.sourceId,
        connectorId: scope.connectorId,
        operation: work.task.operation,
      });
      return signed;
    });
  }

  async result(input: ReadResult): Promise<string> {
    const scope = this.scope(input);
    // Authenticate before taking the workspace lock, then verify again while
    // committing so forged traffic cannot stall another user's workspace.
    await this.registry.preflightReadResult(input);
    return this.inWorkspace(scope.workspaceId, async () => {
      await this.registry.verifyReadResult(input, async () => {
        // Reject stale results before changing cancellation state or bindings.
        if (!this.jobs.matchesResultNonce(scope, input.taskId, input.taskNonce)) return;
        const source = await this.store.boundSource(
          scope.ownerId,
          scope.workspaceId,
          scope.sourceId,
        );
        if (!source || source.connectorId !== scope.connectorId) {
          this.jobs.cancelMatching(
            scope.ownerId,
            scope.workspaceId,
            scope.sourceId,
            scope.connectorId,
          );
          this.jobs.clearCancellation(scope, input.taskId);
          return;
        }
        try {
          this.jobs.complete(scope, input.taskId, input.outcome, input.payload);
        } catch {
          throw new ConnectorError("INVALID");
        }
      });
      await this.flushHistory();
      diagnostics.info("query.result_received", {
        taskId: input.taskId,
        sourceId: scope.sourceId,
        connectorId: scope.connectorId,
        state: input.outcome,
      });
      return this.registry.readResultAcknowledgement(input);
    });
  }
}
