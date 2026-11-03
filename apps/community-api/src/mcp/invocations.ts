import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { SessionIdentity } from "../auth/public.js";
import type { ScopeCoordinator } from "../datasources/public.js";
import { diagnostics } from "../logging/public.js";
import { type DelegatedRead, validateDelegatedRead } from "../queries/public.js";
import { createApprovalHandoff } from "./approval-handoff.js";
import { validateChangeInput } from "./change-input.js";
import { ChangeOrigins } from "./change-origins.js";
import type { AuthorizedMcpGrant, HandoffReceipt } from "./grant-authority.js";
import {
  InvocationCleanup,
  type InvocationCleanupIntent,
  type PendingTerminal,
} from "./invocation-cleanup.js";
import {
  type GrantView,
  type McpAudit,
  McpError,
  type McpTool,
  queryInput,
  requestIdSchema,
} from "./model.js";
import type { McpStore } from "./store.js";

type Scope = {
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
  bindingGeneration?: string | null;
};
type Live = {
  headers: IncomingHttpHeaders;
  scope: Scope;
  until: number;
  monotonicUntil: number;
  discard?: () => void;
  taskId?: string;
  cleanupRequired?: boolean;
  ready?: boolean;
  abort: AbortController;
  approvalSessionId?: string;
  taskNonce?: string;
  anchor: Pick<InvocationCleanupIntent, "grantId" | "generation" | "commitment">;
  registering: boolean;
  cleanupIntent?: InvocationCleanupIntent;
  cleanupQueued?: boolean;
  approvalClaimed?: boolean;
  ownsGuard?: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  registrationDone: Promise<void>;
  finishRegistration: () => void;
};
type Invocation = {
  id: string;
  grantId: string;
  generation: number;
  commitment: string;
  bootId: string;
  state: string;
  tool: string;
  taskId: string | null;
  taskNonce: string | null;
  approvalSessionId: string | null;
};
export class McpInvocations {
  private readonly boot = randomUUID();
  private readonly handoff: ReturnType<typeof createApprovalHandoff>;
  private readonly live = new Map<string, Live>();
  private readonly origins = new ChangeOrigins();
  private readonly receipts = new Map<
    string,
    {
      ownerId: string;
      sessionId: string;
      grantId: string;
      generation: number;
      commitment: string;
      digest: Buffer;
      until: number;
      monotonicUntil: number;
      headers: IncomingHttpHeaders;
      workspaceId: string;
      sourceId: string;
      connectorId: string;
      bindingGeneration: string;
      planCommitment: Buffer;
      ackClaimed?: boolean;
    }
  >();
  private readonly disclosures = new WeakMap<
    object,
    {
      id: string;
      live: Live;
      taskId: string;
      taskNonce: string;
      sessionId: string;
      payload: string;
    }
  >();
  private readonly cleanup: InvocationCleanup;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly checking = new Set<string>();
  private sweepCursor = 0;
  private closed = false;
  private nextPrune = 0;
  private pruning = false;
  constructor(
    private readonly store: McpStore,
    key: Buffer,
    private readonly reads: DelegatedRead,
    private readonly coordinator: ScopeCoordinator,
    private readonly authorize: (headers: IncomingHttpHeaders) => Promise<AuthorizedMcpGrant>,
    private readonly origin: string,
    private readonly withAuthorization: <T>(
      headers: IncomingHttpHeaders,
      action: (
        grant: AuthorizedMcpGrant,
        assertActive: () => void,
        signal: AbortSignal,
        receipt?: HandoffReceipt,
      ) => Promise<T>,
      approvalSession?: string,
    ) => Promise<T>,
    private readonly audit: McpAudit,
    private readonly pruneIdentity: () => Promise<void>,
    private readonly changeEnabled = false,
  ) {
    this.handoff = createApprovalHandoff(key);
    this.cleanup = new InvocationCleanup((intent) => this.store.finishInvocation(intent));
    this.timer = setInterval(() => {
      this.cleanup.tick();
      void this.sweep();
      void this.maintain();
    }, 1000);
    this.timer.unref();
  }
  async initialize() {
    await this.store.recoverInvocations(this.boot);
    await this.store.pruneMetadata();
    await this.pruneIdentity();
  }
  cleanupHealth() {
    return this.cleanup.health();
  }
  settleCleanup() {
    const registrations = [...this.live.values()]
      .filter((l) => l.registering)
      .map((l) => l.registrationDone);
    return this.cleanup.settle(1000, registrations);
  }
  private projected(owner: string, id: string, state: string) {
    const intent = this.live.get(id)?.cleanupIntent;
    if (intent?.ownerId === owner)
      return state === "pending_approval"
        ? intent.pending
        : state === "running"
          ? intent.running
          : state;
    return this.cleanup.project(owner, id, state);
  }
  async list(owner: string) {
    return this.cleanup.read(
      () => this.store.invocations(owner),
      (rows) =>
        rows.map((row) => ({
          id: String(row.id),
          grantId: String(row.grantId),
          generation: Number(row.generation),
          tool: String(row.tool),
          createdAt: new Date(row.createdAt).toISOString(),
          expiresAt: new Date(row.expiresAt).toISOString(),
          state: this.projected(owner, String(row.id), String(row.state)),
        })),
    );
  }
  private invocation(owner: string, id: string) {
    return this.cleanup.read(
      () => this.store.invocation(owner, id),
      (row) => {
        if (row) row.state = this.projected(owner, id, String(row.state));
        return row;
      },
    );
  }
  private registrationSettled(id: string, live: Live) {
    live.registering = false;
    this.flushCleanup(id, live);
    live.finishRegistration();
  }
  private eraseUnreserved(id: string, live: Live) {
    live.abort.abort();
    live.headers.authorization = undefined;
    live.discard?.();
    live.discard = undefined;
    if (live.deadlineTimer) clearTimeout(live.deadlineTimer);
    if (this.live.get(id) === live) this.live.delete(id);
    this.registrationSettled(id, live);
  }
  private binding(
    r: Pick<Invocation, "grantId" | "generation" | "id">,
    tool: "query_prepare" | "change_propose" = "query_prepare",
  ) {
    return {
      grantId: r.grantId,
      generation: r.generation,
      requestId: r.id,
      toolVersion: tool === "query_prepare" ? "query_prepare_v1" : "change_propose_v1",
    };
  }
  private match(s: AuthorizedMcpGrant, g: GrantView) {
    if (
      s.id !== g.id ||
      s.ownerId !== g.ownerId ||
      s.clientId !== g.clientId ||
      s.generation !== g.generation ||
      s.approvalSessionId !== g.approvalSessionId ||
      s.validUntil <= Date.now()
    )
      throw new McpError("MCP_GRANT_CHANGED", 403);
  }
  async current(s: AuthorizedMcpGrant, permission?: string): Promise<GrantView> {
    const g = await this.store.active(s.ownerId, s.id);
    this.match(s, g);
    if (permission && (!g.scopes.includes(permission) || !s.scopes.includes(permission)))
      throw new McpError("MCP_SCOPE_REJECTED", 403);
    await this.coordinator.withScope(g, async (b) => {
      if (b.connectorId !== g.connectorId) throw new McpError("MCP_BINDING_CHANGED", 403);
    });
    return g;
  }
  async recipient(s: AuthorizedMcpGrant) {
    const c = await this.store.client(s.ownerId, s.clientId);
    if (!c) throw new McpError("MCP_CLIENT_NOT_APPROVED", 403);
    return { mode: c.mode, clientId: c.clientId };
  }
  recordCall(s: AuthorizedMcpGrant, tool: McpTool, id?: string, invocationId?: string) {
    return this.audit(s.ownerId, id ?? randomUUID(), {
      name: tool,
      phase: "requested",
      grantId: s.id,
      clientId: s.clientId,
      ...(invocationId ? { invocationId } : {}),
    });
  }
  /** Workspace binding, grant generation and both real sessions remain locked
   * until the HTTP response finishes or disconnects. No post-check lock gap. */
  async publish<T>(
    s: AuthorizedMcpGrant,
    headers: IncomingHttpHeaders,
    permission: string,
    id: string | undefined,
    send: (assertActive: () => void, signal: AbortSignal) => Promise<T>,
    tool: McpTool,
    callId = id ?? randomUUID(),
    result?: unknown,
  ) {
    const g = await this.current(s, permission);
    const row = id ? await this.owned(g.ownerId, id) : undefined;
    if (row && (row.grantId !== g.id || row.generation !== g.generation))
      throw new McpError("MCP_INVOCATION_NOT_FOUND", 404);
    return this.coordinator.withScope(g, async (binding) => {
      if (binding.connectorId !== g.connectorId) throw new McpError("MCP_BINDING_CHANGED", 403);
      return this.withAuthorization(
        headers,
        async (fresh, assertActive, signal) => {
          this.match(fresh, g);
          if (!fresh.scopes.includes(permission)) throw new McpError("MCP_SCOPE_REJECTED", 403);
          const retained =
            result && typeof result === "object" ? this.disclosures.get(result) : undefined;
          const check = () => {
            assertActive();
            if (retained) {
              if (retained.id !== id) throw new McpError("MCP_RESULT_EXPIRED", 410);
              this.assertLive(retained.id, retained.live);
              const identity = this.reads.jobs.sessionIdentity(
                retained.live.scope,
                retained.taskId,
              );
              const current = this.reads.jobs.status(retained.live.scope, retained.taskId);
              if (
                identity?.taskNonce !== retained.taskNonce ||
                identity.sessionId !== retained.sessionId ||
                current?.state !== "completed" ||
                current.payload !== retained.payload
              )
                throw new McpError("MCP_RESULT_EXPIRED", 410);
            }
          };
          check();
          await this.audit(g.ownerId, callId, {
            name: tool,
            phase: "disclosure_authorized",
            grantId: g.id,
            clientId: g.clientId,
            ...(id ? { invocationId: id } : {}),
          });
          check();
          if (retained) {
            if (retained.id !== id) throw new McpError("MCP_RESULT_EXPIRED", 410);
            return send(
              check,
              AbortSignal.any([
                signal,
                retained.live.abort.signal,
                AbortSignal.timeout(Math.max(1, this.remaining(retained.live))),
              ]),
            );
          }
          return send(assertActive, signal);
        },
        row?.approvalSessionId ?? undefined,
      );
    });
  }
  private retain(
    id: string,
    s: AuthorizedMcpGrant,
    h: IncomingHttpHeaders,
    g: GrantView,
    anchor: Live["anchor"],
  ): Live {
    if (this.closed) throw new McpError("MCP_UNAVAILABLE", 503);
    if (this.live.has(id) || this.cleanup.has(id)) throw new McpError("MCP_REQUEST_CONFLICT", 409);
    if (this.live.size + this.cleanup.size >= 128)
      throw new McpError("MCP_INVOCATION_CAPACITY", 429);
    let finishRegistration!: () => void;
    const registrationDone = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const live: Live = {
      headers: { authorization: h.authorization },
      abort: new AbortController(),
      scope: {
        ownerId: g.ownerId,
        workspaceId: g.workspaceId,
        sourceId: g.sourceId,
        connectorId: g.connectorId,
      },
      until: Math.min(s.validUntil, Date.now() + 120000),
      monotonicUntil: performance.now() + Math.max(0, Math.min(s.validUntil - Date.now(), 120000)),
      anchor,
      registering: true,
      registrationDone,
      finishRegistration,
    };
    this.live.set(id, live);
    live.deadlineTimer = setTimeout(
      () => {
        if (this.live.get(id) === live) this.requestCleanup(id, live, "expired");
      },
      Math.max(1, this.remaining(live)),
    );
    live.deadlineTimer.unref();
    return live;
  }
  async prepare(s: AuthorizedMcpGrant, h: IncomingHttpHeaders, input: unknown) {
    if (this.closed) throw new McpError("MCP_UNAVAILABLE", 503);
    const g = await this.current(s, "query:prepare"),
      recipient = await this.recipient(s);
    const prepared = this.stageQuery(s, h, g, input, recipient);
    input = undefined;
    return this.recordPrepared(g, prepared);
  }
  /** Explicitly disabled unless an isolated composition supplies the capability. */
  async prepareChange(s: AuthorizedMcpGrant, h: IncomingHttpHeaders, input: unknown) {
    if (!this.changeEnabled || this.closed) throw new McpError("MCP_WRITES_DISABLED", 403);
    const g = await this.current(s, "change:propose"),
      recipient = await this.recipient(s);
    const prepared = await this.coordinator.withBoundIdentity(g, async (binding) => {
      if (binding.connectorId !== g.connectorId || !binding.bindingGeneration)
        throw new McpError("MCP_CHANGE_BINDING_UNVERIFIED", 503);
      return this.stageChange(s, h, g, input, recipient, binding.bindingGeneration);
    });
    input = undefined;
    return this.recordPrepared(g, prepared, "change_propose");
  }
  private stageChange(
    s: AuthorizedMcpGrant,
    h: IncomingHttpHeaders,
    g: GrantView,
    input: unknown,
    recipient: Awaited<ReturnType<McpInvocations["recipient"]>>,
    bindingGeneration: string,
  ) {
    const q = validateChangeInput(input, g);
    const bytes = Buffer.from(JSON.stringify({ change: q, recipient, bindingGeneration }));
    const binding = this.binding(
      { grantId: g.id, generation: g.generation, id: q.requestId },
      "change_propose",
    );
    try {
      const commitment = this.handoff.commitment(binding, bytes),
        id = q.requestId;
      if (this.live.has(id) || this.cleanup.has(id)) return { id, commitment };
      const live = this.retain(id, s, h, g, {
        grantId: g.id,
        generation: g.generation,
        commitment,
      });
      live.scope.bindingGeneration = bindingGeneration;
      try {
        live.discard = this.handoff.stage(binding, bytes).discard;
      } catch (error) {
        this.eraseUnreserved(id, live);
        throw error;
      }
      return { id, commitment, live };
    } finally {
      bytes.fill(0);
    }
  }
  /** Synchronous sensitive-input frame: no parsed SQL/parameter object or
   * original encoding is retained across reservation/audit IO. */
  private stageQuery(
    s: AuthorizedMcpGrant,
    h: IncomingHttpHeaders,
    g: GrantView,
    input: unknown,
    recipient: Awaited<ReturnType<McpInvocations["recipient"]>>,
  ) {
    const q = queryInput.parse(input);
    if (q.workspaceId !== g.workspaceId || q.sourceId !== g.sourceId)
      throw new McpError("MCP_SCOPE_REJECTED", 403);
    try {
      validateDelegatedRead(q, g.tables);
    } catch {
      throw new McpError("MCP_PLAN_INVALID");
    }
    const bytes = Buffer.from(
      JSON.stringify({
        query: q,
        recipient,
        tables: g.tables,
        connectorId: g.connectorId,
      }),
    );
    const binding = this.binding({ grantId: g.id, generation: g.generation, id: q.requestId });
    try {
      const commitment = this.handoff.commitment(binding, bytes),
        id = q.requestId;
      if (this.live.has(id) || this.cleanup.has(id)) return { id, commitment };
      const live = this.retain(id, s, h, g, {
        grantId: g.id,
        generation: g.generation,
        commitment,
      });
      try {
        live.discard = this.handoff.stage(binding, bytes).discard;
      } catch (error) {
        this.eraseUnreserved(id, live);
        throw error;
      }
      return { id, commitment, live };
    } finally {
      bytes.fill(0);
    }
  }
  private async recordPrepared(
    g: GrantView,
    prepared: { id: string; commitment: string; live?: Live },
    tool: "query_prepare" | "change_propose" = "query_prepare",
  ) {
    const { id, commitment, live } = prepared;
    try {
      const old = await this.invocation(g.ownerId, id);
      if (old) {
        if (
          old.grantId !== g.id ||
          old.tool !== tool ||
          Number(old.generation) !== g.generation ||
          old.commitment !== commitment
        )
          throw new McpError("MCP_REQUEST_CONFLICT", 409);
        if (live) this.eraseUnreserved(id, live);
        return { id, state: this.projected(g.ownerId, id, String(old.state)) };
      }
      if (!live) throw new McpError("MCP_REQUEST_CONFLICT", 409);
      this.assertLive(id, live);
      try {
        await this.store.reserve(g.ownerId, g.id, g.generation, id, commitment, this.boot, tool);
      } finally {
        this.registrationSettled(id, live);
      }
      this.assertLive(id, live);
      await this.audit(g.ownerId, id);
      this.assertLive(id, live);
      return {
        id,
        state: "approval_required",
        approvalUrl: `${this.origin}/?${tool === "query_prepare" ? "mcpApproval" : "mcpChange"}=${id}`,
      };
    } catch (error) {
      if (live) {
        this.registrationSettled(id, live);
        this.requestCleanup(id, live, "failed");
      }
      throw error;
    }
  }
  private async owned(owner: string, id: string): Promise<Invocation> {
    requestIdSchema.parse(id);
    const r = await this.invocation(owner, id);
    if (!r) throw new McpError("MCP_INVOCATION_NOT_FOUND", 404);
    return {
      id: String(r.id),
      grantId: String(r.grantId),
      generation: Number(r.generation),
      commitment: String(r.commitment),
      bootId: String(r.bootId),
      state: String(r.state),
      tool: String(r.tool),
      taskId: r.taskId === null ? null : String(r.taskId),
      taskNonce: r.taskNonce === null ? null : String(r.taskNonce),
      approvalSessionId: r.approvalSessionId === null ? null : String(r.approvalSessionId),
    };
  }
  /** Keeps both the actual grant and administrator session locked while the
   * application-supplied response writer owns the sensitive handoff. */
  private async withChangeLease<T>(
    who: SessionIdentity,
    id: string,
    work: (
      row: Invocation,
      live: Live,
      grant: GrantView,
      check: () => void,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    if (!this.changeEnabled || this.closed) throw new McpError("MCP_WRITES_DISABLED", 403);
    const row = await this.owned(who.ownerId, id),
      live = this.live.get(id);
    if (!live || row.tool !== "change_propose" || row.bootId !== this.boot)
      throw new McpError("MCP_APPROVAL_EXPIRED", 410);
    this.assertLive(id, live);
    const s = await this.authorize(live.headers),
      g = await this.current(s, "change:propose");
    this.assertLive(id, live);
    if (row.grantId !== g.id || row.generation !== g.generation)
      throw new McpError("MCP_APPROVAL_STALE", 409);
    return this.coordinator.withBoundIdentity(g, async (binding) => {
      if (
        binding.connectorId !== g.connectorId ||
        !live.scope.bindingGeneration ||
        binding.bindingGeneration !== live.scope.bindingGeneration
      )
        throw new McpError("MCP_BINDING_CHANGED", 403);
      return this.withAuthorization(
        live.headers,
        async (fresh, assertActive, signal) => {
          this.match(fresh, g);
          if (!fresh.scopes.includes("change:propose"))
            throw new McpError("MCP_SCOPE_REJECTED", 403);
          const check = () => {
            assertActive();
            this.assertLive(id, live);
          };
          check();
          return work(
            row,
            live,
            g,
            check,
            AbortSignal.any([
              signal,
              live.abort.signal,
              AbortSignal.timeout(Math.max(1, this.remaining(live))),
            ]),
          );
        },
        who.sessionId,
      );
    });
  }
  async reviewChange(
    who: SessionIdentity,
    id: string,
    send: (value: unknown, check: () => void, signal: AbortSignal) => Promise<void>,
  ) {
    await this.withChangeLease(who, id, async (row, live, g, check, signal) => {
      if (row.state !== "pending_approval") throw new McpError("MCP_APPROVAL_STALE", 409);
      const bytes = this.handoff.inspect(this.binding(row, "change_propose"), row.commitment);
      if (!bytes) throw new McpError("MCP_APPROVAL_EXPIRED", 410);
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          !("change" in value) ||
          !("recipient" in value) ||
          !("bindingGeneration" in value) ||
          value.bindingGeneration !== live.scope.bindingGeneration
        )
          throw new McpError("MCP_APPROVAL_INVALID", 503);
        const change = validateChangeInput(value.change, g);
        check();
        await send(
          { id, change, recipient: value.recipient, grant: g, commitment: row.commitment },
          check,
          signal,
        );
      } finally {
        bytes.fill(0);
      }
    });
  }
  /** Claim is recorded as unknown before bytes leave; process/response loss
   * never fabricates a successful handoff or permits replay. */
  async claimChange(
    who: SessionIdentity,
    id: string,
    commitment: string,
    send: (value: unknown, check: () => void, signal: AbortSignal) => Promise<void>,
  ) {
    let claimed: Live | undefined;
    try {
      await this.withChangeLease(who, id, async (row, current, g, check, signal) => {
        if (
          row.state !== "pending_approval" ||
          row.commitment !== commitment ||
          current.approvalClaimed ||
          this.receipts.size >= 128
        )
          throw new McpError("MCP_APPROVAL_STALE", 409);
        current.approvalClaimed = true;
        claimed = current;
        await this.audit(g.ownerId, id, {
          name: "change_propose",
          phase: "disclosure_authorized",
          grantId: g.id,
          clientId: g.clientId,
          invocationId: id,
        });
        check();
        if (
          !(await this.store.transition(
            g.ownerId,
            id,
            "pending_approval",
            "handoff_unknown",
            who.sessionId,
          ))
        )
          throw new McpError("MCP_APPROVAL_STALE", 409);
        check();
        const bytes = this.handoff.take(this.binding(row, "change_propose"), row.commitment);
        if (!bytes) throw new McpError("MCP_APPROVAL_EXPIRED", 410);
        try {
          const value: unknown = JSON.parse(bytes.toString("utf8"));
          if (
            !value ||
            typeof value !== "object" ||
            !("change" in value) ||
            !("bindingGeneration" in value) ||
            value.bindingGeneration !== current.scope.bindingGeneration ||
            !current.scope.bindingGeneration
          )
            throw new McpError("MCP_APPROVAL_INVALID", 503);
          const change = validateChangeInput(value.change, g);
          check();
          if (this.receipts.size >= 128) throw new McpError("MCP_INVOCATION_CAPACITY", 429);
          const receipt = randomBytes(32).toString("hex");
          this.receipts.set(id, {
            ownerId: who.ownerId,
            sessionId: who.sessionId,
            grantId: g.id,
            generation: g.generation,
            commitment: row.commitment,
            digest: createHash("sha256").update(receipt).digest(),
            until: current.until,
            monotonicUntil: current.monotonicUntil,
            headers: { authorization: current.headers.authorization },
            workspaceId: change.workspaceId,
            sourceId: change.sourceId,
            connectorId: current.scope.connectorId,
            bindingGeneration: current.scope.bindingGeneration,
            planCommitment: this.origins.commitment(change.plan),
          });
          await send(
            { id, change, grantId: g.id, receipt, state: "handoff_unknown" },
            check,
            signal,
          );
        } finally {
          bytes.fill(0);
        }
      });
    } catch (error) {
      if (claimed) this.requestCleanup(id, claimed, "failed");
      throw error;
    }
    if (claimed) this.requestCleanup(id, claimed, "expired");
  }
  /** A receipt proves that the authenticated browser obtained the payload; it
   * does not prove that a human reviewed it or that any mutation took place. */
  async acknowledgeChange(who: SessionIdentity, id: string, receipt: string) {
    if (!this.changeEnabled || this.closed) throw new McpError("MCP_WRITES_DISABLED", 403);
    const entry = this.receipts.get(id);
    if (
      !entry ||
      entry.until <= Date.now() ||
      entry.monotonicUntil <= performance.now() ||
      entry.ownerId !== who.ownerId ||
      entry.sessionId !== who.sessionId ||
      entry.ackClaimed ||
      !/^[0-9a-f]{64}$/.test(receipt)
    )
      throw new McpError("MCP_RECEIPT_REJECTED", 403);
    const digest = createHash("sha256").update(receipt).digest();
    if (!timingSafeEqual(entry.digest, digest)) throw new McpError("MCP_RECEIPT_REJECTED", 403);
    entry.ackClaimed = true;
    let transferred = false;
    const checkReceipt = () => {
      if (
        this.closed ||
        this.receipts.get(id) !== entry ||
        entry.until <= Date.now() ||
        entry.monotonicUntil <= performance.now()
      )
        throw new McpError("MCP_RECEIPT_REJECTED", 403);
    };
    try {
      const row = await this.owned(who.ownerId, id);
      checkReceipt();
      if (
        row.bootId !== this.boot ||
        row.state !== "handoff_unknown" ||
        row.tool !== "change_propose" ||
        row.grantId !== entry.grantId ||
        row.generation !== entry.generation ||
        row.commitment !== entry.commitment ||
        row.approvalSessionId !== who.sessionId ||
        entry.until <= Date.now() ||
        entry.monotonicUntil <= performance.now()
      )
        throw new McpError("MCP_RECEIPT_REJECTED", 403);
      const subject = await this.authorize(entry.headers);
      const grant = await this.current(subject, "change:propose");
      if (grant.id !== entry.grantId || grant.generation !== entry.generation)
        throw new McpError("MCP_RECEIPT_REJECTED", 403);
      await this.coordinator.withBoundIdentity(grant, async (binding) => {
        if (
          binding.connectorId !== grant.connectorId ||
          binding.connectorId !== entry.connectorId ||
          binding.bindingGeneration !== entry.bindingGeneration
        )
          throw new McpError("MCP_BINDING_CHANGED", 403);
        await this.withAuthorization(
          entry.headers,
          async (fresh, check, signal, acknowledgeHandoff) => {
            this.match(fresh, grant);
            if (
              !fresh.scopes.includes("change:propose") ||
              entry.until <= Date.now() ||
              entry.monotonicUntil <= performance.now()
            )
              throw new McpError("MCP_RECEIPT_REJECTED", 403);
            signal.throwIfAborted();
            check();
            checkReceipt();
            if (!acknowledgeHandoff) throw new McpError("MCP_AUTHORIZATION_UNAVAILABLE", 503);
            if (
              !(await acknowledgeHandoff({
                ownerId: who.ownerId,
                id,
                grantId: entry.grantId,
                generation: entry.generation,
                commitment: entry.commitment,
                bootId: this.boot,
                sessionId: who.sessionId,
              }))
            )
              throw new McpError("MCP_RECEIPT_REJECTED", 403);
            signal.throwIfAborted();
            check();
            checkReceipt();
          },
          who.sessionId,
        );
      });
      checkReceipt();
      this.origins.add(id, {
        ownerId: entry.ownerId,
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        sourceId: entry.sourceId,
        connectorId: entry.connectorId,
        bindingGeneration: entry.bindingGeneration,
        plan: entry.planCommitment,
      });
      transferred = true;
    } finally {
      entry.digest.fill(0);
      entry.headers.authorization = undefined;
      if (!transferred) entry.planCommitment.fill(0);
      if (this.receipts.get(id) === entry) this.receipts.delete(id);
    }
  }
  verifyChangeOrigin(input: {
    id: string;
    ownerId: string;
    sessionId: string;
    workspaceId: string;
    sourceId: string;
    plan: unknown;
  }): {
    invocationId: string;
    planChanged: boolean;
    connectorId: string;
    bindingGeneration: string;
  } {
    if (!this.changeEnabled || this.closed) throw new McpError("MCP_WRITES_DISABLED", 403);
    return this.origins.verify(input);
  }
  private guard(taskId: string, live: Live, g: GrantView) {
    this.reads.guardExecution(
      taskId,
      async () =>
        live.ready === true &&
        live.taskId === taskId &&
        this.authorize(live.headers).then(
          (s) => {
            this.match(s, g);
            return true;
          },
          () => false,
        ),
      (action) =>
        this.withAuthorization(
          live.headers,
          async (s, assertActive, signal) => {
            this.match(s, g);
            if (live.taskId !== taskId || this.remaining(live) <= 0)
              throw new McpError("MCP_APPROVAL_STALE", 409);
            const check = () => {
              assertActive();
              if (
                !live.ready ||
                live.cleanupRequired ||
                live.abort.signal.aborted ||
                this.remaining(live) <= 0
              )
                throw new McpError("MCP_APPROVAL_STALE", 409);
            };
            check();
            return action(
              check,
              AbortSignal.any([
                signal,
                live.abort.signal,
                AbortSignal.timeout(Math.max(1, this.remaining(live))),
              ]),
            );
          },
          live.approvalSessionId,
        ),
    );
  }
  /** Decode only inside final authorization, then leave the synchronous frame
   * before binding IO. Awaiting a workspace lock must not retain parsed SQL. */
  private createPreparedRead(
    row: Invocation,
    g: GrantView,
    binding: Scope,
    taskId: string,
    session: string,
  ) {
    const bytes = this.handoff.take(this.binding(row), row.commitment);
    if (!bytes) throw new McpError("MCP_APPROVAL_EXPIRED", 410);
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || !("query" in value))
        throw new McpError("MCP_APPROVAL_INVALID", 503);
      const q = queryInput.parse(value.query);
      this.reads.jobs.createDelegated(
        { ...binding, sessionId: session },
        taskId,
        q.sql,
        q.parameters,
        q.maxRows,
        q.schemaVersion,
        g.tables,
      );
    } finally {
      bytes.fill(0);
    }
  }
  private async start(row: Invocation, live: Live, g: GrantView, session: string, query = false) {
    await this.coordinator.withScope(g, async (binding) => {
      if (binding.connectorId !== g.connectorId || live.until <= Date.now())
        throw new McpError("MCP_BINDING_CHANGED", 403);
      await this.withAuthorization(
        live.headers,
        async (s, assertActive) => {
          this.match(s, g);
          assertActive();
          this.assertLive(row.id, live);
          if (live.taskId) throw new McpError("MCP_APPROVAL_STALE", 409);
          live.approvalSessionId = session;
          const taskId = randomUUID();
          live.taskId = taskId;
          live.ready = false;
          let created = false;
          try {
            this.guard(taskId, live, g);
            live.ownsGuard = true;
            if (query) this.createPreparedRead(row, g, binding, taskId, session);
            else
              this.reads.jobs.createDelegatedModelSchema(
                { ...binding, sessionId: session },
                taskId,
                g.tables,
              );
            created = true;
            const identity = this.reads.jobs.sessionIdentity(binding, taskId);
            live.taskNonce = identity?.taskNonce;
            if (
              !identity ||
              !(await this.store.bindJob(g.ownerId, row.id, session, taskId, identity.taskNonce))
            )
              throw new McpError("MCP_APPROVAL_STALE", 409);
            assertActive();
            this.assertLive(row.id, live);
            const status = this.reads.jobs.status(binding, taskId);
            if (!status || !["queued", "running"].includes(status.state))
              throw new McpError("MCP_APPROVAL_STALE", 409);
            live.ready = true;
            if (query) await this.reads.trackExecution(binding, taskId);
          } catch (error) {
            if (created && this.reads.jobs.sessionIdentity(binding, taskId))
              this.reads.jobs.cancel(binding, taskId);
            if (live.ownsGuard) {
              this.reads.clearExecutionGuard(taskId);
              live.ownsGuard = false;
            }
            throw error;
          }
        },
        session,
      );
    });
  }
  async schema(s: AuthorizedMcpGrant, h: IncomingHttpHeaders, id: string) {
    if (this.closed) throw new McpError("MCP_UNAVAILABLE", 503);
    requestIdSchema.parse(id);
    const g = await this.current(s, "metadata:read"),
      old = await this.invocation(g.ownerId, id);
    if (old) {
      if (
        old.grantId !== g.id ||
        Number(old.generation) !== g.generation ||
        old.tool !== "schema_get"
      )
        throw new McpError("MCP_REQUEST_CONFLICT", 409);
      return { id, state: this.projected(g.ownerId, id, String(old.state)) };
    }
    const bytes = Buffer.from(JSON.stringify(g.tables));
    let commitment: string;
    try {
      commitment = this.handoff.commitment(
        { grantId: g.id, generation: g.generation, requestId: id, toolVersion: "schema_get_v1" },
        bytes,
      );
    } finally {
      bytes.fill(0);
    }
    const live = this.retain(id, s, h, g, { grantId: g.id, generation: g.generation, commitment });
    try {
      try {
        await this.store.reserve(
          g.ownerId,
          g.id,
          g.generation,
          id,
          commitment,
          this.boot,
          "schema_get",
        );
      } finally {
        this.registrationSettled(id, live);
      }
      this.assertLive(id, live);
      await this.audit(g.ownerId, id);
      this.assertLive(id, live);
      await this.start(await this.owned(g.ownerId, id), live, g, g.approvalSessionId);
    } catch (error) {
      this.registrationSettled(id, live);
      this.requestCleanup(id, live, "failed");
      throw error;
    }
    return { id, state: "running" };
  }
  async review(who: SessionIdentity, id: string) {
    const row = await this.owned(who.ownerId, id),
      live = this.live.get(id);
    if (
      !live ||
      row.bootId !== this.boot ||
      this.remaining(live) <= 0 ||
      live.cleanupRequired ||
      this.closed
    ) {
      if (live) this.requestCleanup(id, live, "expired");
      throw new McpError("MCP_APPROVAL_EXPIRED", 410);
    }
    const s = await this.authorize(live.headers),
      g = await this.current(s, "query:prepare");
    if (
      row.grantId !== g.id ||
      row.generation !== g.generation ||
      row.state !== "pending_approval" ||
      row.tool !== "query_prepare"
    )
      throw new McpError("MCP_APPROVAL_STALE", 409);
    const bytes = this.handoff.inspect(this.binding(row), row.commitment);
    if (!bytes) throw new McpError("MCP_APPROVAL_EXPIRED", 410);
    try {
      const v: unknown = JSON.parse(bytes.toString("utf8"));
      if (!v || typeof v !== "object" || !("query" in v) || !("recipient" in v))
        throw new McpError("MCP_APPROVAL_INVALID", 503);
      return {
        id,
        query: queryInput.parse(v.query),
        recipient: v.recipient,
        grant: g,
        commitment: row.commitment,
      };
    } finally {
      bytes.fill(0);
    }
  }
  private flushCleanup(id: string, live: Live) {
    if (live.registering || !live.cleanupIntent || live.cleanupQueued) return;
    live.cleanupQueued = true;
    this.cleanup.enqueue(live.cleanupIntent);
    if (this.live.get(id) === live) this.live.delete(id);
  }
  /** Latch the terminal intent synchronously. Erasure/cancellation never waits
   * for metadata IO; retries own only bounded, non-sensitive identity data. */
  private requestCleanup(id: string, live: Live, pending: PendingTerminal) {
    if (live.cleanupIntent) {
      this.flushCleanup(id, live);
      return;
    }
    live.cleanupRequired = true;
    live.ready = false;
    live.abort.abort();
    if (live.deadlineTimer) clearTimeout(live.deadlineTimer);
    live.headers.authorization = undefined;
    live.discard?.();
    live.discard = undefined;
    let running: string = pending;
    if (live.taskId) {
      const identity = this.reads.jobs.sessionIdentity(live.scope, live.taskId);
      if (identity && live.taskNonce && identity.taskNonce === live.taskNonce) {
        this.reads.jobs.cancel(live.scope, live.taskId);
        running =
          this.reads.jobs.executionState(live.scope, live.taskId)?.state ?? "outcome_unknown";
      } else running = "outcome_unknown";
      if (live.ownsGuard) {
        this.reads.clearExecutionGuard(live.taskId);
        live.ownsGuard = false;
      }
    }
    live.cleanupIntent = {
      ownerId: live.scope.ownerId,
      id,
      ...live.anchor,
      bootId: this.boot,
      pending,
      running,
      approvalSessionId: live.approvalSessionId ?? null,
    };
    this.flushCleanup(id, live);
  }
  async approve(who: SessionIdentity, id: string, commitment: string, accept: boolean) {
    const { commitment: checked, grant } = await this.review(who, id);
    if (commitment !== checked) throw new McpError("MCP_APPROVAL_STALE", 409);
    const retained = this.live.get(id);
    if (!retained) throw new McpError("MCP_APPROVAL_EXPIRED", 410);
    this.assertLive(id, retained);
    if (retained.approvalClaimed) throw new McpError("MCP_APPROVAL_STALE", 409);
    // Single synchronous winner, before any later row lookup or workspace wait.
    // A losing approval must never cancel or replace the winner's job.
    retained.approvalClaimed = true;
    if (!accept) {
      retained.approvalSessionId = who.sessionId;
      this.requestCleanup(id, retained, "cancelled");
      return;
    }
    try {
      const row = await this.owned(who.ownerId, id);
      this.assertLive(id, retained);
      await this.start(row, retained, grant, who.sessionId, true);
    } catch (error) {
      this.requestCleanup(id, retained, "failed");
      throw error;
    }
  }
  private job(live: Live, row: Invocation) {
    if (!row.taskId || !row.taskNonce || !row.approvalSessionId || live.taskId !== row.taskId)
      return null;
    const identity = this.reads.jobs.sessionIdentity(live.scope, row.taskId);
    if (identity?.taskNonce !== row.taskNonce || identity.sessionId !== row.approvalSessionId)
      return null;
    const status = this.reads.jobs.status(live.scope, row.taskId);
    if (!status) return null;
    return {
      state: this.reads.jobs.executionState(live.scope, row.taskId)?.state ?? status.state,
    };
  }
  /** Sensitive data is captured only after all asynchronous checks/writes. */
  private retainedJob(live: Live, row: Invocation) {
    const state = this.job(live, row);
    if (!state || !row.taskId) return null;
    return { ...state, payload: this.reads.jobs.status(live.scope, row.taskId)?.payload };
  }
  async status(s: AuthorizedMcpGrant, id: string) {
    const permission = s.scopes.includes("operation:read") ? "operation:read" : "metadata:read";
    const g = await this.current(s, permission),
      row = await this.owned(g.ownerId, id);
    if (permission === "metadata:read" && row.tool !== "schema_get")
      throw new McpError("MCP_SCOPE_REJECTED", 403);
    if (row.grantId !== g.id || row.generation !== g.generation)
      throw new McpError("MCP_INVOCATION_NOT_FOUND", 404);
    const live = this.live.get(id);
    if (!live || !row.taskId || !row.approvalSessionId)
      return { id, state: this.projected(g.ownerId, id, row.state), resultAvailable: false };
    // Terminal metadata needs no retained credential or result lease. Erasure
    // by the background monitor must not race a legitimate terminal poll.
    const terminal = this.job(live, row);
    if (terminal && !["queued", "running", "completed"].includes(terminal.state)) {
      this.requestCleanup(id, live, "failed");
      return { id, state: terminal.state, resultAvailable: false };
    }
    const headers = { authorization: live.headers.authorization };
    const erase = () => {
      headers.authorization = undefined;
    };
    live.abort.signal.addEventListener("abort", erase, { once: true });
    if (live.abort.signal.aborted) erase();
    const taskId = row.taskId,
      sessionId = row.approvalSessionId;
    try {
      const observed = await this.coordinator.withScope(g, async (binding) => {
        if (binding.connectorId !== g.connectorId) throw new McpError("MCP_BINDING_CHANGED", 403);
        return this.withAuthorization(headers, async (fresh) => {
          this.match(fresh, g);
          const result = this.job(live, row);
          if (!result) return { id, state: row.state, resultAvailable: false };
          if (!["queued", "running", "completed"].includes(result.state)) {
            this.requestCleanup(id, live, "failed");
            return { id, state: result.state, resultAvailable: false };
          }
          if (!(await this.reads.sessionIsActive(binding, taskId, sessionId))) {
            this.requestCleanup(id, live, "expired");
            throw new McpError("MCP_APPROVAL_EXPIRED", 410);
          }
          this.assertLive(id, live);
          if (!["queued", "running"].includes(result.state))
            await this.store.transition(g.ownerId, id, "running", result.state);
          this.assertLive(id, live);
          return { id, state: result.state, resultAvailable: false };
        });
      });
      // Both authorization commit and scope wrappers have fully settled. Only
      // metadata crossed those awaits; capture/decoding below is synchronous.
      this.assertLive(id, live);
      if (observed.state !== "completed") return observed;
      const retained = this.retainedJob(live, row);
      if (!retained)
        return { id, state: this.projected(g.ownerId, id, row.state), resultAvailable: false };
      if (!["queued", "running", "completed"].includes(retained.state)) {
        this.requestCleanup(id, live, "failed");
        return { id, state: retained.state, resultAvailable: false };
      }
      const value = {
        id,
        state: retained.state,
        resultAvailable: retained.state === "completed" && !!retained.payload,
        ...(retained.state === "completed" && retained.payload
          ? {
              result: JSON.parse(
                Buffer.from(retained.payload, "base64url").toString("utf8"),
              ) as unknown,
            }
          : {}),
      };
      this.assertLive(id, live);
      if (value.resultAvailable && row.taskNonce && retained.payload)
        this.disclosures.set(value, {
          id,
          live,
          taskId,
          taskNonce: row.taskNonce,
          sessionId,
          payload: retained.payload,
        });
      return value;
    } catch (error) {
      if (live.cleanupIntent)
        return {
          id,
          state:
            row.state === "pending_approval"
              ? live.cleanupIntent.pending
              : row.state === "running"
                ? live.cleanupIntent.running
                : row.state,
          resultAvailable: false,
        };
      throw error;
    } finally {
      erase();
      live.abort.signal.removeEventListener("abort", erase);
    }
  }
  async cancel(s: AuthorizedMcpGrant, id: string) {
    const g = await this.current(s, "operation:cancel");
    return this.coordinator.withScope(g, async () => {
      const row = await this.owned(g.ownerId, id);
      if (row.grantId !== g.id || row.generation !== g.generation)
        throw new McpError("MCP_INVOCATION_NOT_FOUND", 404);
      const live = this.live.get(id),
        before = live ? this.job(live, row) : null;
      if (!live || !["pending_approval", "running"].includes(row.state))
        return { id, state: this.projected(g.ownerId, id, row.state) };
      if (before && !["queued", "running"].includes(before.state)) {
        if (before.state === "completed")
          await this.store.transition(g.ownerId, id, "running", before.state);
        else this.requestCleanup(id, live, "failed");
        return { id, state: before.state };
      }
      this.requestCleanup(id, live, "cancelled");
      return { id, state: "cancel_requested" };
    });
  }
  private async sweep() {
    if (this.closed) return;
    for (const [id, receipt] of this.receipts) {
      if (receipt.until <= Date.now() || receipt.monotonicUntil <= performance.now()) {
        receipt.digest.fill(0);
        receipt.planCommitment.fill(0);
        receipt.headers.authorization = undefined;
        this.receipts.delete(id);
      }
    }
    // Expiry cannot be queued behind session/authorization IO.
    for (const [id, live] of this.live) {
      if (this.remaining(live) <= 0) this.requestCleanup(id, live, "expired");
      else if (live.taskId) {
        const state = this.reads.jobs.executionState(live.scope, live.taskId)?.state;
        if (state && !["queued", "running", "completed"].includes(state))
          this.requestCleanup(id, live, "failed");
      }
    }
    const entries = [...this.live],
      start = this.sweepCursor % Math.max(1, entries.length);
    for (let offset = 0; offset < entries.length && this.checking.size < 8; offset++) {
      const index = (start + offset) % entries.length,
        entry = entries[index];
      this.sweepCursor = (index + 1) % entries.length;
      if (!entry || this.checking.has(entry[0])) continue;
      this.checking.add(entry[0]);
      void this.sweepOne(...entry)
        .catch((error) => diagnostics.error("mcp.authorization_unavailable", {}, error))
        .finally(() => this.checking.delete(entry[0]));
    }
  }
  private async sweepOne(id: string, live: Live) {
    if (this.live.get(id) !== live) return;
    if (live.taskId) {
      const state = this.reads.jobs.executionState(live.scope, live.taskId)?.state;
      if (state && !["queued", "running", "completed"].includes(state)) {
        this.requestCleanup(id, live, "failed");
        return;
      }
    }
    let active = !live.cleanupRequired && this.remaining(live) > 0;
    if (active && live.taskId)
      active = await this.reads
        .sessionIsActive(live.scope, live.taskId, live.approvalSessionId)
        .then(
          (value) => value,
          () => false,
        );
    if (active)
      active = await this.authorize(live.headers).then(
        () => true,
        () => false,
      );
    if (this.closed || this.live.get(id) !== live) return;
    if (active && this.remaining(live) > 0 && !live.cleanupRequired) return;
    this.requestCleanup(id, live, "expired");
  }
  private async maintain() {
    if (this.pruning || Date.now() < this.nextPrune) return;
    this.pruning = true;
    this.nextPrune = Date.now() + 60000;
    try {
      await this.store.pruneMetadata();
      await this.pruneIdentity();
    } catch (error) {
      diagnostics.error("mcp.authorization_unavailable", {}, error);
    } finally {
      this.pruning = false;
    }
  }
  private assertLive(id: string, live: Live) {
    if (
      this.closed ||
      this.live.get(id) !== live ||
      live.cleanupRequired ||
      live.abort.signal.aborted ||
      this.remaining(live) <= 0
    )
      throw new McpError("MCP_RESULT_EXPIRED", 410);
  }
  private remaining(live: Live) {
    return Math.floor(Math.min(live.until - Date.now(), live.monotonicUntil - performance.now()));
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [id, live] of this.live) this.requestCleanup(id, live, "expired");
    for (const receipt of this.receipts.values()) {
      receipt.digest.fill(0);
      receipt.planCommitment.fill(0);
      receipt.headers.authorization = undefined;
    }
    this.receipts.clear();
    this.origins.close();
    this.handoff.close();
  }
}
