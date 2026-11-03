import { randomUUID } from "node:crypto";
import type { SessionIdentity } from "../auth/public.js";
import { diagnostics } from "../logging/public.js";
import { createApprovalHandoff } from "../mcp/public.js";
import type { ExternalDriver } from "./driver.js";
import type { ExternalLease } from "./lease.js";
import { decodeJson, inspectJson } from "./limits.js";
import {
  type CallRecord,
  type CallState,
  type ClientAudit,
  type Connection,
  ExternalMcpError,
} from "./model.js";
import { RateBudget, takeRate } from "./rate.js";
import type { ExternalMcpStore } from "./store.js";
import { TerminalUpdates } from "./terminals.js";
import { digest, validateArguments } from "./tool-policy.js";

type MemoryCall = {
  record: Omit<CallRecord, "state" | "createdAt" | "updatedAt" | "acknowledged">;
  ready: boolean;
  connection: Connection;
  who: SessionIdentity;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  wall: number;
  claimed: boolean;
  handed: boolean;
  state: CallState;
  discard: () => void;
  result?: {
    bytes: Buffer;
    proof: ReturnType<ExternalDriver["retainSnapshot"]>;
    abort: AbortController;
    remove: () => void;
    published: boolean;
  };
  acknowledged?: boolean;
  driver?: ExternalDriver;
  error?: string;
  phase?: "verifying_tools" | "validating_approval" | "waiting_result";
  progress?: { progress: number; total?: number };
};
const binding = (c: Pick<CallRecord, "connectionId" | "version" | "id">) => ({
  grantId: c.connectionId,
  generation: c.version,
  requestId: c.id,
  toolVersion: "external_call_v1",
});
const activeStates = new Set<CallState>(["pending_approval", "running", "cancel_requested"]);
export class ExternalCalls {
  readonly bootId = randomUUID();
  private readonly handoff;
  private closed = false;
  readonly terminals: TerminalUpdates;
  private readonly calls = new Map<string, MemoryCall>();
  private readonly rate = new RateBudget(60, 16);
  constructor(
    private readonly store: ExternalMcpStore,
    private readonly lease: ExternalLease,
    key: Buffer,
    private readonly audit: ClientAudit,
    private readonly access: {
      active(c: Connection, w: SessionIdentity): Promise<void>;
      driver(c: Connection, w: SessionIdentity): ExternalDriver;
      disconnect(id: string, driver?: ExternalDriver): Promise<void>;
      check(): void;
      ready(c: Connection, who: SessionIdentity): void;
    },
  ) {
    this.handoff = createApprovalHandoff(key);
    this.terminals = new TerminalUpdates((v) => this.store.terminal(v.owner, v.id, v.state));
  }
  async initialize() {
    await this.store.recover(this.bootId);
  }
  private fail(code: string, status = 409): never {
    throw new ExternalMcpError(code, status);
  }
  busy(id: string) {
    return [...this.calls.values()].some(
      (c) => c.connection.id === id && activeStates.has(c.state),
    );
  }
  references() {
    return [...this.calls.values()]
      .filter((c) => activeStates.has(c.state) || !!c.result)
      .map((c) => ({ id: c.record.id, connection: c.connection, who: c.who }));
  }
  private eraseResult(call: MemoryCall) {
    const result = call.result;
    if (!result) return;
    call.result = undefined;
    result.remove();
    result.abort.abort();
    result.bytes.fill(0);
  }
  private invalidateResult(call: MemoryCall, error: string) {
    const unpublished = !!call.result && !call.result.published;
    this.eraseResult(call);
    if (!unpublished || activeStates.has(call.state)) return;
    call.state = "outcome_unknown";
    call.error = error;
    call.acknowledged = false;
    this.terminals.revise({ owner: call.record.ownerId, id: call.record.id, state: call.state });
    this.auditTerminal(call);
  }
  private assertNoUnknown(connectionId: string) {
    if (
      [...this.calls.values()].some(
        (call) =>
          call.record.connectionId === connectionId &&
          call.state === "outcome_unknown" &&
          !call.acknowledged,
      )
    )
      this.fail("EXTERNAL_MCP_UNKNOWN_CALL_PENDING");
  }
  private finalizeResult(call: MemoryCall) {
    if (!call.result || call.result.published) return;
    call.result.published = true;
    this.terminals.revise({ owner: call.record.ownerId, id: call.record.id, state: call.state });
  }
  invalidate(id: string, throughVersion = Number.POSITIVE_INFINITY) {
    for (const c of this.calls.values())
      if (c.connection.id === id && c.record.version <= throughVersion) {
        this.invalidateResult(c, "EXTERNAL_MCP_AUTHORIZATION_CHANGED");
        if (activeStates.has(c.state))
          this.finish(
            c,
            c.handed ? "outcome_unknown" : "cancelled",
            "EXTERNAL_MCP_AUTHORIZATION_CHANGED",
          );
      }
  }
  invalidateReference(id: string) {
    const call = this.calls.get(id);
    if (!call) return;
    const driver = call.driver;
    this.invalidateResult(call, "EXTERNAL_MCP_AUTHORIZATION_CHANGED");
    if (activeStates.has(call.state))
      this.finish(
        call,
        call.handed ? "outcome_unknown" : "cancelled",
        "EXTERNAL_MCP_AUTHORIZATION_CHANGED",
      );
    return driver;
  }
  prepare(
    c: Connection,
    who: SessionIdentity,
    name: string,
    args: unknown,
  ): Promise<{ id: string }> {
    try {
      this.access.check();
      if (this.closed) this.fail("EXTERNAL_MCP_CLOSED", 503);
      this.assertNoUnknown(c.id);
      if (new Set([...this.calls.keys(), ...this.terminals.ids()]).size >= 64)
        this.fail("EXTERNAL_MCP_CALL_CAPACITY", 429);
      const tool = c.snapshot.find((t) => t.name === name),
        proof = c.approvedTools.find(
          (t) => t.name === name && t.hash === tool?.hash && t.sessionId === who.sessionId,
        );
      if (tool?.status !== "available" || !proof) this.fail("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
      this.access.ready(c, who);
      validateArguments(tool, args);
      const row = {
        id: randomUUID(),
        ownerId: who.ownerId,
        connectionId: c.id,
        version: c.version,
        tool: name,
        toolHash: tool.hash,
        sessionId: who.sessionId,
        bootId: this.bootId,
        commitment: "",
      };
      const bytes = Buffer.from(JSON.stringify(args));
      let staged: ReturnType<ReturnType<typeof createApprovalHandoff>["stage"]>;
      try {
        staged = this.handoff.stage(binding(row), bytes);
      } finally {
        bytes.fill(0);
      }
      row.commitment = staged.commitment;
      const call: MemoryCall = {
        record: row,
        ready: false,
        connection: c,
        who,
        abort: new AbortController(),
        timer: setTimeout(() => {}, 1),
        deadline: performance.now() + 120000,
        wall: Date.now() + 120000,
        claimed: false,
        handed: false,
        state: "pending_approval",
        discard: staged.discard,
      };
      clearTimeout(call.timer);
      call.timer = setTimeout(() => this.finish(call, "expired"), 120000);
      call.timer.unref();
      this.calls.set(row.id, call);
      return this.register(call, proof);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async register(call: MemoryCall, proof: Connection["approvedTools"][number]) {
    try {
      const { connection: c, who, record: row } = call;
      this.checkCall(call);
      await this.lease.run(
        c,
        who,
        async (check) => {
          check();
          this.checkCall(call);
        },
        proof,
      );
      this.checkCall(call);
      await this.audit(who.ownerId, "call_prepare_requested", c.workspaceId, c.id, row.id);
      this.checkCall(call);
      await this.store.prepareCall(row, () => this.checkCall(call));
      this.checkCall(call);
      const retained = this.handoff.inspect(binding(row), row.commitment);
      if (!retained) this.fail("EXTERNAL_MCP_CALL_EXPIRED", 410);
      retained.fill(0);
      call.ready = true;
      return { id: row.id };
    } catch (error) {
      this.finish(call, "failed", "EXTERNAL_MCP_PREPARE_FAILED");
      throw error;
    }
  }
  private checkCall(call: MemoryCall) {
    this.access.check();
    if (
      this.closed ||
      this.calls.get(call.record.id) !== call ||
      !activeStates.has(call.state) ||
      call.abort.signal.aborted ||
      Date.now() >= call.wall ||
      performance.now() >= call.deadline
    )
      this.fail("EXTERNAL_MCP_CALL_EXPIRED", 410);
    this.assertNoUnknown(call.connection.id);
  }
  private owned(c: Connection, who: SessionIdentity, id: string) {
    const call = this.calls.get(id);
    if (
      !call ||
      call.record.ownerId !== who.ownerId ||
      call.record.connectionId !== c.id ||
      call.who.sessionId !== who.sessionId ||
      call.connection.version !== c.version
    )
      this.fail("EXTERNAL_MCP_CALL_NOT_FOUND", 404);
    if (!call.ready) this.fail("EXTERNAL_MCP_CALL_NOT_READY", 409);
    return call;
  }
  async review(
    c: Connection,
    who: SessionIdentity,
    id: string,
    send: (body: unknown, check: () => void, signal: AbortSignal) => Promise<void>,
  ) {
    const call = this.owned(c, who, id),
      proof = call.connection.approvedTools.find(
        (t) => t.name === call.record.tool && t.hash === call.record.toolHash,
      );
    if (!proof) this.fail("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
    await this.lease.run(
      c,
      who,
      async (check, signal) => {
        this.checkCall(call);
        const bytes = this.handoff.inspect(binding(call.record), call.record.commitment);
        if (!bytes) this.fail("EXTERNAL_MCP_CALL_EXPIRED", 410);
        try {
          const args = decodeJson(bytes, 32768);
          check();
          this.checkCall(call);
          await send(
            {
              id,
              tool: call.record.tool,
              arguments: args,
              destination: c.config.kind === "http" ? c.config.resource : c.config.programId,
              version: c.version,
              toolHash: call.record.toolHash,
              expiresAt: new Date(call.wall).toISOString(),
            },
            () => {
              check();
              this.checkCall(call);
            },
            signal,
          );
        } finally {
          bytes.fill(0);
        }
      },
      proof,
    );
  }
  async confirm(c: Connection, who: SessionIdentity, id: string) {
    takeRate(this.rate, who.ownerId);
    const call = this.owned(c, who, id);
    this.checkCall(call);
    this.access.ready(c, who);
    if (call.claimed || call.state !== "pending_approval")
      this.fail("EXTERNAL_MCP_CALL_ALREADY_CLAIMED");
    call.claimed = true;
    try {
      await this.audit(who.ownerId, "call_approval_requested", c.workspaceId, c.id, id);
      this.checkCall(call);
      if (!(await this.store.start(who.ownerId, id, c.version)))
        this.fail("EXTERNAL_MCP_CALL_ALREADY_CLAIMED");
      this.checkCall(call);
      call.state = "running";
      clearTimeout(call.timer);
      call.deadline = performance.now() + c.config.callTimeoutMs;
      call.wall = Date.now() + c.config.callTimeoutMs;
      call.timer = setTimeout(
        () =>
          this.finish(
            call,
            call.handed ? "outcome_unknown" : "failed",
            "EXTERNAL_MCP_CALL_TIMEOUT",
          ),
        c.config.callTimeoutMs,
      );
      call.timer.unref();
      void this.execute(call);
    } catch (e) {
      this.finish(call, "failed", "EXTERNAL_MCP_APPROVAL_FAILED");
      throw e;
    }
    return { id, state: call.state };
  }
  private async execute(call: MemoryCall) {
    const c = call.connection,
      who = call.who;
    try {
      const proof = c.approvedTools.find(
        (t) => t.name === call.record.tool && t.hash === call.record.toolHash,
      );
      if (!proof) this.fail("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
      const driver = this.access.driver(c, who);
      await driver.within(
        { who, signal: call.abort.signal, proof, check: () => this.checkCall(call) },
        async () => {
          call.driver = driver;
          call.phase = "verifying_tools";
          const fresh = await driver.discover();
          this.checkCall(call);
          const freshHash = digest(fresh);
          if (freshHash !== c.snapshotHash || driver.installationHash !== c.installationHash) {
            await driver.seal();
            await this.store.discovery(
              who.ownerId,
              c.id,
              c.version,
              fresh,
              driver.installationHash,
              who,
              () => {
                this.checkCall(call);
                driver.verifySnapshot(freshHash);
              },
            );
            this.fail("EXTERNAL_MCP_SNAPSHOT_CHANGED");
          }
          const bytes = this.handoff.take(binding(call.record), call.record.commitment);
          call.phase = "validating_approval";
          if (!bytes) this.fail("EXTERNAL_MCP_CALL_EXPIRED", 410);
          let args: unknown;
          try {
            args = decodeJson(bytes, 32768);
          } finally {
            bytes.fill(0);
          }
          const tool = fresh.find((t) => t.name === call.record.tool);
          if (tool?.status !== "available") this.fail("EXTERNAL_MCP_SNAPSHOT_CHANGED");
          validateArguments(tool, args);
          await this.audit(
            who.ownerId,
            "call_dispatch_requested",
            c.workspaceId,
            c.id,
            call.record.id,
          );
          this.checkCall(call);
          call.phase = "waiting_result";
          const result = await driver.call(
            tool,
            args,
            (p) => {
              if (
                activeStates.has(call.state) &&
                Number.isFinite(p.progress) &&
                p.progress >= 0 &&
                p.progress <= 1e9
              ) {
                call.progress = {
                  progress: p.progress,
                  ...(p.total !== undefined &&
                  Number.isFinite(p.total) &&
                  p.total >= p.progress &&
                  p.total <= 1e9
                    ? { total: p.total }
                    : {}),
                };
              }
            },
            () => {
              this.checkCall(call);
              call.handed = true;
            },
          );
          this.checkCall(call);
          inspectJson(result);
          await this.access.active(c, who);
          this.checkCall(call);
          await driver.seal();
          this.checkCall(call);
          driver.verifySnapshot(freshHash);
          const encoded = Buffer.from(JSON.stringify(result));
          const proof = driver.retainSnapshot(freshHash);
          const invalidated = () => this.invalidateResult(call, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
          call.result = {
            bytes: encoded,
            proof,
            abort: new AbortController(),
            published: false,
            remove: () => proof.signal.removeEventListener("abort", invalidated),
          };
          proof.signal.addEventListener("abort", invalidated, { once: true });
          this.finish(call, result.isError === true ? "failed" : "succeeded");
          if (proof.signal.aborted) invalidated();
        },
        async (error) => {
          if (activeStates.has(call.state))
            this.finish(
              call,
              call.handed ? "outcome_unknown" : "failed",
              error instanceof ExternalMcpError ? error.code : "EXTERNAL_MCP_CALL_FAILED",
            );
          await this.access.disconnect(c.id, driver);
        },
      );
    } catch (error) {
      if (activeStates.has(call.state))
        this.finish(
          call,
          call.handed ? "outcome_unknown" : "failed",
          error instanceof ExternalMcpError ? error.code : "EXTERNAL_MCP_CALL_FAILED",
        );
      diagnostics.error(
        "mcp.external_failed",
        {
          ownerId: who.ownerId,
          workspaceId: c.workspaceId,
          externalConnectionId: c.id,
          externalCallId: call.record.id,
          state: call.state,
        },
        error instanceof ExternalMcpError
          ? error
          : new ExternalMcpError("EXTERNAL_MCP_CALL_FAILED"),
      );
    }
  }
  private finish(call: MemoryCall, state: CallState, error?: string) {
    if (!activeStates.has(call.state)) return;
    call.state = state;
    call.driver = undefined;
    call.error = error;
    call.abort.abort();
    call.discard();
    clearTimeout(call.timer);
    this.terminals.enqueue({
      owner: call.record.ownerId,
      id: call.record.id,
      state: call.result ? "result_retained" : state,
    });
    this.auditTerminal(call);
    call.deadline = performance.now() + 120000;
    call.wall = Date.now() + 120000;
    call.timer = setTimeout(() => {
      if (call.result && !call.result.published) {
        try {
          call.result.proof.check();
          this.finalizeResult(call);
        } catch {
          this.invalidateResult(call, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
        }
      }
      this.eraseResult(call);
      if (call.state !== "outcome_unknown" || call.acknowledged) this.calls.delete(call.record.id);
    }, 120000);
    call.timer.unref();
  }
  private auditTerminal(call: MemoryCall) {
    void this.audit(
      call.record.ownerId,
      "call_finished",
      call.connection.workspaceId,
      call.connection.id,
      call.record.id,
      call.state,
    ).catch(() => diagnostics.error("mcp.external_failed"));
  }
  async history(c: Connection, who: SessionIdentity) {
    return this.terminals.read(
      () => this.store.calls(who.ownerId, c.id),
      (rows) =>
        rows.map((r) => {
          const m = this.calls.get(r.id);
          if (m?.result) {
            try {
              m.result.proof.check();
            } catch {
              this.invalidateResult(m, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
            }
          }
          const state = m?.state ?? this.terminals.get(r.id)?.state ?? r.state;
          if (state === "result_retained") this.fail("EXTERNAL_MCP_STORAGE_INVALID", 503);
          return {
            id: r.id,
            tool: r.tool,
            state,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            acknowledged: r.acknowledged,
            resultAvailable: !!m?.result && m.who.sessionId === who.sessionId,
            error: m?.error ?? null,
            phase: m?.phase ?? null,
            progress: m?.progress ?? null,
          };
        }),
    );
  }
  async result(
    c: Connection,
    who: SessionIdentity,
    id: string,
    send: (body: unknown, check: () => void, signal: AbortSignal) => Promise<void>,
  ) {
    const call = this.owned(c, who, id),
      expected = call.result,
      proof = call.connection.approvedTools.find(
        (t) => t.name === call.record.tool && t.hash === call.record.toolHash,
      );
    if (!proof) this.fail("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
    if (!expected) this.fail("EXTERNAL_MCP_RESULT_EXPIRED", 410);
    await this.lease.run(
      c,
      who,
      async (check, signal) => {
        const assert = () => {
          check();
          if (
            !expected ||
            call.result !== expected ||
            Date.now() >= call.wall ||
            performance.now() >= call.deadline
          )
            this.fail("EXTERNAL_MCP_RESULT_EXPIRED", 410);
          try {
            expected.proof.check();
            this.access.ready(call.connection, call.who);
          } catch {
            this.invalidateResult(call, "EXTERNAL_MCP_SNAPSHOT_CHANGED");
            this.fail("EXTERNAL_MCP_RESULT_EXPIRED", 410);
          }
        };
        assert();
        await send(
          {
            result: decodeJson(expected.bytes),
            untrusted: true,
            expiresAt: new Date(call.wall).toISOString(),
          },
          assert,
          AbortSignal.any([signal, expected.abort.signal, expected.proof.signal]),
        );
        assert();
        this.finalizeResult(call);
      },
      proof,
      [call.who.sessionId],
    );
  }
  async cancel(c: Connection, who: SessionIdentity, id: string) {
    const call = this.owned(c, who, id);
    await this.audit(who.ownerId, "call_cancel_requested", c.workspaceId, c.id, id);
    if (!activeStates.has(call.state)) return { state: call.state };
    const driver = call.driver;
    this.finish(call, call.handed ? "outcome_unknown" : "cancelled");
    if (driver) await this.access.disconnect(c.id, driver);
    return { state: call.state };
  }
  async acknowledge(c: Connection, who: SessionIdentity, id: string) {
    await this.terminals.settle();
    const r = await this.store.call(who.ownerId, id);
    if (!r || r.connectionId !== c.id || r.state !== "outcome_unknown")
      this.fail("EXTERNAL_MCP_UNKNOWN_CALL_NOT_FOUND", 404);
    await this.audit(who.ownerId, "unknown_acknowledgment_requested", c.workspaceId, c.id, id);
    await this.store.acknowledge(who.ownerId, id);
    const memory = this.calls.get(id);
    if (memory) {
      memory.acknowledged = true;
      clearTimeout(memory.timer);
      this.calls.delete(id);
    }
  }
  async close() {
    this.closed = true;
    this.handoff.close();
    for (const c of this.calls.values()) {
      if (activeStates.has(c.state)) this.finish(c, c.handed ? "outcome_unknown" : "cancelled");
      clearTimeout(c.timer);
      this.invalidateResult(c, "EXTERNAL_MCP_CLOSED");
    }
    await this.terminals.settle();
    this.calls.clear();
  }
}
