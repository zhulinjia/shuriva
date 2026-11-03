import { lookup } from "node:dns/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
  specTypeSchemas,
  type Transport,
  type McpSubscription,
  type JSONRPCMessage,
  isJSONRPCRequest,
} from "@modelcontextprotocol/client";
import type { SessionIdentity } from "../auth/public.js";
import { diagnostics } from "../logging/public.js";
import type { ExternalConfig } from "./config.js";
import type { ExternalLease } from "./lease.js";
import {
  type AvailableTool,
  type Connection,
  ExternalMcpError,
  safeUrl,
  type ToolSnapshot,
} from "./model.js";
import { Discovery, ToolRevision } from "./discovery.js";
import { type Address, clientFetch, type NetworkPolicy } from "./network.js";
import type { ProgramCatalog } from "./programs.js";
import { ownedStdio } from "./stdio.js";
import { digest, schemaValidator, validateSchema } from "./tool-policy.js";
import { validatedTransport } from "./transport.js";
import type { ClientVault } from "./vault.js";

type Proof = Connection["approvedTools"][number];
type Operation = { who: SessionIdentity; signal: AbortSignal; proof?: Proof; check: () => void };
function transportError(error: unknown, code = "EXTERNAL_MCP_NETWORK_FAILED") {
  return error instanceof ExternalMcpError ? error : new ExternalMcpError(code, 502);
}
/** Late DNS continues to own its physical slot even after the caller times out. */
export class ResolverBudget {
  private active = 0;
  async resolve(host: string): Promise<Address[]> {
    if (this.active >= 16) throw new ExternalMcpError("EXTERNAL_MCP_DNS_CAPACITY", 503);
    this.active++;
    try {
      return await lookup(host, { all: true, verbatim: true });
    } finally {
      this.active--;
    }
  }
}
export function networkPolicy(c: Connection, config: ExternalConfig, oauth = false): NetworkPolicy {
  if (c.config.kind !== "http") throw new ExternalMcpError("EXTERNAL_MCP_TRANSPORT_REJECTED");
  const p = c.config.oauth;
  return {
    destinations:
      oauth && p
        ? [p.resourceMetadataUrl, p.metadataUrl, p.tokenEndpoint]
        : [safeUrl(c.config.resource).href],
    privateApprovals: c.config.privateApprovals,
    blockedOrigins: [new URL(config.origin).origin],
    controlPorts: config.controlPorts,
    credentialDestinations: oauth && p ? [p.tokenEndpoint] : [safeUrl(c.config.resource).href],
  };
}
export class ExternalDriver {
  readonly client: Client;
  private readonly abort = new AbortController();
  private op?: Operation;
  private readonly dispatchContext = new AsyncLocalStorage<{
    op: Operation;
    open: boolean;
    method?: string;
  }>();
  private readonly sending = new Set<Promise<unknown>>();
  private sendFailure?: { op: Operation; error: unknown };
  private accepting = false;
  private closer?: () => Promise<void>;
  private connected = false;
  private closing?: Promise<void>;
  private connecting?: Promise<void>;
  private discovery?: Discovery;
  private readonly toolRevision = new ToolRevision();
  private snapshotValidity = new AbortController();
  private verifiedToolRevision?: symbol;
  private verifiedSnapshotHash?: string;
  private callRevision?: symbol;
  private transportFault?: ExternalMcpError;
  private cleanupFailure = false;
  private subscription?: McpSubscription;
  private callPermit?: {
    name: string;
    argumentsHash: string;
    used: boolean;
    onHandoff: () => void;
  };
  private callAbort?: AbortController;
  installationHash: string | null = null;
  get isConnected() {
    return this.connected && !this.closing;
  }
  constructor(
    readonly connection: Connection,
    private readonly config: ExternalConfig,
    private readonly vault: ClientVault,
    private readonly lease: ExternalLease,
    private readonly resolver: ResolverBudget,
    private readonly catalog: ProgramCatalog,
  ) {
    this.client = new Client(
      { name: "Shuriva", version: "0.1.0" },
      {
        capabilities: {},
        jsonSchemaValidator: schemaValidator(),
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        listMaxPages: 5,
        enforceStrictCapabilities: true,
      },
    );
    this.client.onclose = () => {
      this.connected = false;
      if (!this.abort.signal.aborted) this.recordTransportFault();
    };
    this.client.onerror = () => this.recordTransportFault();
  }
  private recordTransportFault() {
    if (this.transportFault) return;
    this.transportFault = new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502);
    this.discovery?.invalidate();
    this.abort.abort();
    diagnostics.error(
      "mcp.external_failed",
      { externalConnectionId: this.connection.id },
      this.transportFault,
    );
  }
  assertHealthy() {
    if (this.transportFault) throw this.transportFault;
    if (this.abort.signal.aborted || !this.connected)
      throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
  }
  private toolListChanged() {
    this.toolRevision.changed();
    const previous = this.snapshotValidity;
    this.snapshotValidity = new AbortController();
    previous.abort();
    this.discovery?.invalidate();
    this.callAbort?.abort();
  }
  private subscriptionCurrent() {
    this.assertHealthy();
    if (this.subscription?.honoredFilter.toolsListChanged !== true)
      throw new ExternalMcpError("EXTERNAL_MCP_SUBSCRIPTION_UNAVAILABLE", 503);
  }
  verifySnapshot(hash: string | null) {
    this.subscriptionCurrent();
    this.toolRevision.check(this.verifiedToolRevision);
    if (!hash || hash !== this.verifiedSnapshotHash)
      throw new ExternalMcpError("EXTERNAL_MCP_SNAPSHOT_CHANGED", 409);
  }
  /** Retain this exact observed generation; a later rediscovery cannot revive it. */
  retainSnapshot(hash: string) {
    this.verifySnapshot(hash);
    const revision = this.verifiedToolRevision;
    const subscription = this.subscription;
    return {
      signal: AbortSignal.any([this.abort.signal, this.snapshotValidity.signal]),
      check: () => {
        this.subscriptionCurrent();
        this.toolRevision.check(revision);
        if (this.subscription !== subscription || this.verifiedSnapshotHash !== hash)
          throw new ExternalMcpError("EXTERNAL_MCP_SNAPSHOT_CHANGED", 409);
      },
    };
  }
  private async ensureSubscription() {
    if (this.subscription) {
      this.subscriptionCurrent();
      return;
    }
    const op = this.op;
    if (!op) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION", 403);
    const subscription = await this.client.listen(
      { toolsListChanged: true },
      {
        signal: this.abort.signal,
        timeout: this.connection.config.connectTimeoutMs,
      },
    );
    if (subscription.honoredFilter.toolsListChanged !== true) {
      this.recordTransportFault();
      throw new ExternalMcpError("EXTERNAL_MCP_SUBSCRIPTION_UNAVAILABLE", 503);
    }
    this.subscription = subscription;
    void subscription.closed.then(() => {
      if (this.subscription !== subscription) return;
      this.subscription = undefined;
      this.toolListChanged();
      if (!this.abort.signal.aborted) this.recordTransportFault();
    });
    this.subscriptionCurrent();
    op.check();
  }
  private authorizeCallMessage(message: JSONRPCMessage) {
    const permit = this.callPermit;
    this.subscriptionCurrent();
    this.toolRevision.check(this.callRevision);
    if (
      !permit ||
      permit.used ||
      !isJSONRPCRequest(message) ||
      message.method !== "tools/call" ||
      message.params?.name !== permit.name ||
      digest(message.params?.arguments ?? {}) !== permit.argumentsHash
    )
      throw new ExternalMcpError("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
    permit.used = true;
  }
  private noteHandoff() {
    if (this.dispatchContext.getStore()?.method !== "tools/call") return;
    this.subscriptionCurrent();
    this.toolRevision.check(this.callRevision);
    this.callAbort?.signal.throwIfAborted();
    const permit = this.callPermit;
    if (!permit?.used) throw new ExternalMcpError("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
    // This is the locally observable transfer to Node/OS or the owned stdio
    // host, not evidence that a remote side effect has happened.
    permit.onHandoff();
  }
  private track<T>(work: () => Promise<T>, nested = false, method?: string): Promise<T> {
    const parent = nested ? this.dispatchContext.getStore() : undefined;
    const op = parent?.op ?? this.op;
    if (!op || this.op !== op || (parent ? !parent.open : !this.accepting))
      return Promise.reject(new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION", 403));
    const context = parent ?? { op, open: true, method };
    const pending = this.dispatchContext.run(context, () =>
      Promise.resolve().then(async () => {
        try {
          if (this.op !== op) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION", 403);
          try {
            return await work();
          } catch (error) {
            throw transportError(error);
          }
        } finally {
          if (!parent) context.open = false;
        }
      }),
    );
    this.sending.add(pending);
    void pending.then(
      () => this.sending.delete(pending),
      (error) => {
        if (this.op === op && !this.sendFailure) this.sendFailure = { op, error };
        this.sending.delete(pending);
      },
    );
    return pending;
  }
  private guard(
    send: (check: () => void, signal: AbortSignal, remainingMs: () => number) => Promise<void>,
  ) {
    const op = this.op;
    if (!op) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION", 403);
    const work = this.lease
      .run(
        this.connection,
        op.who,
        async (check, signal, remainingMs) => {
          const assert = () => {
            if (this.callRevision !== undefined) this.toolRevision.check(this.callRevision);
            op.signal.throwIfAborted();
            this.abort.signal.throwIfAborted();
            signal.throwIfAborted();
            this.callAbort?.signal.throwIfAborted();
            check();
            op.check();
          };
          assert();
          await send(
            assert,
            AbortSignal.any([
              signal,
              op.signal,
              this.abort.signal,
              ...(this.callAbort ? [this.callAbort.signal] : []),
            ]),
            remainingMs,
          );
          assert();
        },
        op.proof,
      )
      .catch((error) => {
        throw transportError(error);
      });
    this.sending.add(work);
    void work.then(
      () => this.sending.delete(work),
      (error) => {
        if (this.op === op && !this.sendFailure) this.sendFailure = { op, error };
        this.sending.delete(work);
      },
    );
    return work;
  }
  private async drain() {
    let failure: { error: unknown } | undefined =
      this.sendFailure?.op === this.op ? this.sendFailure : undefined;
    while (this.sending.size) {
      const results = await Promise.allSettled([...this.sending]);
      if (this.sendFailure?.op === this.op) failure ??= this.sendFailure;
      for (const result of results)
        if (result.status === "rejected") failure ??= { error: result.reason };
      try {
        this.op?.check();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (this.sendFailure?.op === this.op) failure ??= this.sendFailure;
    if (failure) throw failure.error;
  }
  async seal() {
    this.accepting = false;
    await this.drain();
    this.assertHealthy();
  }
  async within<T>(
    op: Operation,
    work: () => Promise<T>,
    failed: (error: unknown) => Promise<void>,
  ): Promise<T> {
    if (this.op || this.closing) throw new ExternalMcpError("EXTERNAL_MCP_CONNECTION_BUSY", 409);
    const stopped = new AbortController();
    this.op = { ...op, signal: AbortSignal.any([op.signal, stopped.signal]) };
    this.accepting = true;
    this.sendFailure = undefined;
    try {
      op.check();
      op.signal.throwIfAborted();
      const value = await work();
      await this.drain();
      return value;
    } catch (error) {
      this.accepting = false;
      stopped.abort();
      let failure = transportError(error);
      try {
        await failed(transportError(error));
      } catch (cleanupError) {
        failure = transportError(cleanupError);
      }
      try {
        await this.drain();
      } catch {
        /* Preserve the primary/cleanup failure after all sends settle. */
      }
      throw failure;
    } finally {
      this.op = undefined;
      this.accepting = false;
      this.sendFailure = undefined;
    }
  }
  async connect() {
    if (this.closing || this.abort.signal.aborted)
      throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOwned();
    try {
      await this.connecting;
    } catch (error) {
      throw transportError(error);
    } finally {
      this.connecting = undefined;
    }
  }
  private async closeOwned() {
    try {
      await this.closer?.();
    } catch {
      this.cleanupFailure = true;
      throw new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
    }
  }
  private async connectOwned() {
    if (this.connected) return;
    if (this.closer) throw new ExternalMcpError("EXTERNAL_MCP_RECONNECT_REQUIRED", 409);
    const c = this.connection,
      op = this.op;
    if (!op) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION");
    if (!this.vault.has(c.credentialRef))
      throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_REQUIRED", 409);
    let transport: Transport;
    if (c.config.kind === "http") {
      const policy = networkPolicy(c, this.config);
      const guardedFetch = clientFetch(
        policy,
        (send) => this.guard(send),
        this.abort.signal,
        (h) => this.resolver.resolve(h),
        () => this.noteHandoff(),
      );
      const wrapped: typeof fetch = (input, init) =>
        this.track(async () => {
          const current = this.op;
          if (!current) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION");
          const subscription = this.dispatchContext.getStore()?.method === "subscriptions/listen";
          const signal = AbortSignal.any([
            this.abort.signal,
            ...(init?.signal ? [init.signal] : []),
            ...(subscription ? [] : [current.signal]),
          ]);
          const headers = new Headers(init?.headers),
            secret = this.vault.get(c.credentialRef);
          if (c.config.kind !== "http")
            throw new ExternalMcpError("EXTERNAL_MCP_TRANSPORT_REJECTED");
          if (c.config.authentication === "bearer") {
            if (!secret.bearer) throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_REQUIRED");
            headers.set("authorization", `Bearer ${secret.bearer}`);
          }
          if (c.config.authentication === "api_key") {
            if (!secret.apiKey) throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_REQUIRED");
            headers.set("x-api-key", secret.apiKey);
          }
          if (c.config.authentication === "oauth") {
            if (!secret.tokens || Date.now() >= (secret.tokenExpiresAt ?? 0))
              throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_REQUIRED", 401);
            headers.set("authorization", `Bearer ${secret.tokens.access_token}`);
          }
          return guardedFetch(input, { ...init, headers, signal });
        }, true);
      const http = new StreamableHTTPClientTransport(new URL(c.config.resource), {
        fetch: wrapped,
        requestInit: { redirect: "error" },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
      transport = http;
      this.closer = () => http.close();
    } else {
      const program = await this.catalog.inspect(c.config.programId);
      op.check();
      this.abort.signal.throwIfAborted();
      op.signal.throwIfAborted();
      this.installationHash = program.installationHash;
      if (c.installationHash !== program.installationHash)
        throw new ExternalMcpError("EXTERNAL_MCP_PROGRAM_APPROVAL_REQUIRED", 409);
      // Launch itself is privileged work: retain the real connection/session lease
      // until the official transport has spawned the already-owned host.
      let owned: Awaited<ReturnType<typeof ownedStdio>>;
      try {
        owned = await ownedStdio(
          program,
          this.vault.get(c.credentialRef),
          this.config.runRoot,
          (send) => this.guard(send),
          (message) => {
            if ("method" in message && message.method === "tools/call") this.noteHandoff();
          },
        );
      } catch {
        // A rejected setup is not evidence that every native helper exited.
        // Keep physical capacity until explicit cleanup can be proved.
        this.cleanupFailure = true;
        throw new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
      }
      transport = owned.transport;
      this.closer = owned.close;
    }
    if (this.abort.signal.aborted || op.signal.aborted) {
      await this.closeOwned();
      throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
    }
    await this.client.connect(
      validatedTransport(
        transport,
        (work, method) => this.track(work, false, method),
        () => this.discovery,
        () => this.toolListChanged(),
        () => {
          this.cleanupFailure = true;
        },
        (message) => this.authorizeCallMessage(message),
      ),
      {
        signal: AbortSignal.any([op.signal, this.abort.signal]),
        timeout: this.connection.config.connectTimeoutMs,
      },
    );
    await this.drain();
    this.connected = true;
  }
  async discover(): Promise<ToolSnapshot[]> {
    await this.connect();
    await this.ensureSubscription();
    const op = this.op;
    if (!op) throw new ExternalMcpError("EXTERNAL_MCP_NO_ACTIVE_OPERATION");
    if (this.discovery) throw new ExternalMcpError("EXTERNAL_MCP_CONNECTION_BUSY", 409);
    const discovery = new Discovery();
    const revision = this.toolRevision.capture();
    this.discovery = discovery;
    discovery.begin();
    try {
      const result = await this.client.listTools(undefined, {
        cacheMode: "refresh",
        signal: op.signal,
        timeout: this.connection.config.connectTimeoutMs,
      });
      await this.drain();
      op.check();
      const tools = discovery.complete(result.tools);
      this.toolRevision.check(revision);
      this.verifiedToolRevision = revision;
      this.verifiedSnapshotHash = digest(tools);
      return tools;
    } finally {
      this.discovery = undefined;
    }
  }
  async call(
    tool: AvailableTool,
    args: Record<string, unknown>,
    progress?: (value: { progress: number; total?: number }) => void,
    onHandoff: () => void = () => {},
  ): Promise<CallToolResult> {
    if (!this.connected || !this.op) throw new ExternalMcpError("EXTERNAL_MCP_NOT_CONNECTED", 409);
    if (tool.status !== "available")
      throw new ExternalMcpError("EXTERNAL_MCP_TOOL_NOT_APPROVED", 403);
    this.toolRevision.check(this.verifiedToolRevision);
    this.subscriptionCurrent();
    validateSchema(tool.inputSchema);
    if (tool.outputSchema) validateSchema(tool.outputSchema);
    const definition = specTypeSchemas.Tool["~standard"].validate({
      name: tool.name,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    });
    if (definition.issues) throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
    this.callRevision = this.verifiedToolRevision;
    this.callAbort = new AbortController();
    this.callPermit = { name: tool.name, argumentsHash: digest(args), used: false, onHandoff };
    try {
      const result = await this.client.callTool(
        { name: tool.name, arguments: args },
        {
          signal: AbortSignal.any([this.op.signal, this.callAbort.signal]),
          timeout: this.connection.config.callTimeoutMs,
          resetTimeoutOnProgress: false,
          // An explicit definition disables SDK HEADER_MISMATCH refetch/replay.
          toolDefinition: definition.value,
          onprogress: progress,
        },
      );
      await this.drain();
      return result;
    } finally {
      this.callRevision = undefined;
      this.callPermit = undefined;
      this.callAbort = undefined;
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.abort.abort();
      // Setup owns any eventual helper and transport even if cancellation was
      // observed while filesystem/catalog work was still pending.
      if (this.connecting) {
        try {
          await this.connecting;
        } catch {
          /* closeOwned below owns cleanup */
        }
      }
      let cleanupFailed = false;
      try {
        await this.closeOwned();
      } catch {
        cleanupFailed = true;
      } finally {
        try {
          await this.client.close();
        } catch {
          cleanupFailed = true;
        }
        this.connected = false;
      }
      if (cleanupFailed || this.cleanupFailure)
        throw new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
    })();
    return this.closing;
  }
}
