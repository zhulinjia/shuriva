import { randomUUID } from "node:crypto";
import type { SessionIdentity } from "../auth/public.js";
import { diagnostics } from "../logging/public.js";
import type { WorkspaceStore } from "../workspaces.js";
import { ExternalCalls } from "./calls.js";
import type { ExternalConfig } from "./config.js";
import { ExternalDriver, networkPolicy, ResolverBudget } from "./driver.js";
import type { ExternalLease } from "./lease.js";
import {
  type ClientAudit,
  type Connection,
  type ConnectionReference,
  type Credentials,
  connectionInput,
  credentialsInput,
  ExternalMcpError,
  safeUrl,
} from "./model.js";
import {
  abortableAddresses,
  clientFetch,
  loopbackAddress,
  validateDestination,
} from "./network.js";
import { ExternalOAuth } from "./oauth.js";
import { ProgramCatalog } from "./programs.js";
import { RateBudget, takeRate } from "./rate.js";
import type { ExternalMcpStore } from "./store.js";
import type { ClientVault } from "./vault.js";
import { digest } from "./tool-policy.js";
/** Coordinates facts/approvals; transports and OS credentials stay behind ports.
 * No argument or result is persisted, including on recovery. */
export class ExternalMcpService {
  readonly oauth: ExternalOAuth;
  readonly catalog: ProgramCatalog;
  readonly invocations: ExternalCalls;
  private readonly drivers = new Map<
    string,
    { driver: ExternalDriver; who: SessionIdentity; idle: ReturnType<typeof setTimeout> }
  >();
  private readonly resolver = new ResolverBudget();
  private closed = false;
  private shutdown?: Promise<void>;
  private physical = 0;
  private readonly cleanupUnknown = new Set<string>();
  private readonly disconnecting = new Map<string, Promise<void>>();
  private readonly monitor: ReturnType<typeof setInterval>;
  private monitoring = false;
  private readonly discoveryRate = new RateBudget(10, 2);
  private readonly oauthRate = new RateBudget(5, 2);
  private cleaning?: Promise<void>;
  constructor(
    readonly store: ExternalMcpStore,
    readonly lease: ExternalLease,
    private readonly workspaces: WorkspaceStore,
    private readonly vault: ClientVault,
    readonly config: ExternalConfig & { executionHostId: string },
    key: Buffer,
    private readonly audit: ClientAudit,
  ) {
    this.invocations = new ExternalCalls(store, lease, key, audit, {
      active: (c, w) => this.active(c, w),
      driver: (c, w) => this.driver(c, w),
      disconnect: (id, driver) => this.disconnect(id, driver),
      check: () => this.check(),
      ready: (c, who) => this.ready(c, who),
    });
    this.catalog = new ProgramCatalog(config.programRoot, config.hostExecutable);
    this.oauth = new ExternalOAuth(
      config.origin,
      (c, w) => this.active(c, w),
      (c, w, signal) =>
        clientFetch(
          networkPolicy(c, config, true),
          (send) =>
            this.lease.run(c, w, async (check, s) => {
              s.throwIfAborted();
              signal.throwIfAborted();
              check();
              await send(check, s);
              check();
            }),
          signal,
          (h) => this.resolver.resolve(h),
        ),
      (ref) => vault.get(ref),
      async (c, w, attemptId, change, checkAttempt, published) => {
        const value = await this.lease.run(c, w, async (check) => {
          check();
          const current = vault.get(c.credentialRef);
          check();
          return change(current);
        });
        await this.replaceCredentials(c, w, value, attemptId, checkAttempt, published);
      },
      async (c, signal) => {
        if (c.config.kind !== "http" || !c.config.oauth) this.fail("EXTERNAL_MCP_OAUTH_CONFIG");
        const p = networkPolicy(c, config, true),
          url = c.config.oauth.authorizationEndpoint;
        const endpoint = safeUrl(url);
        const host = endpoint.hostname.replace(/^\[|\]$/g, "");
        // Browser redirects cannot pin the platform's DNS resolution.
        if (endpoint.protocol === "http:" && host !== "localhost" && !loopbackAddress(host))
          this.fail("EXTERNAL_MCP_HTTPS_REQUIRED", 403);
        validateDestination(
          url,
          { ...p, destinations: [url] },
          await abortableAddresses(this.resolver.resolve(host), signal),
        );
      },
    );
    this.monitor = setInterval(() => {
      this.invocations.terminals.tick();
      void this.cleanupCredentials();
      if (this.monitoring || this.closed) return;
      this.monitoring = true;
      void this.monitorSessions().finally(() => {
        this.monitoring = false;
      });
    }, 1000);
    this.monitor.unref();
  }
  async initialize() {
    await this.invocations.initialize();
  }
  health() {
    return {
      admission: this.lease.health(),
      connections: this.drivers.size,
      physical: this.physical,
      capacity: 8,
      cleanupUnknown: this.physical > this.drivers.size,
      metadata: this.store.metadata.health(),
      terminalUpdates: this.invocations.terminals.health(),
    };
  }
  private fail(code: string, status = 409): never {
    throw new ExternalMcpError(code, status);
  }
  private check() {
    if (this.closed) this.fail("EXTERNAL_MCP_CLOSED", 503);
  }
  async connection(who: SessionIdentity, workspace: string, id: string) {
    this.check();
    const c = await this.store.connection(who.ownerId, id);
    if (c.workspaceId !== workspace) this.fail("EXTERNAL_MCP_NOT_FOUND", 404);
    await this.active(c, who);
    return c;
  }
  async managementConnection(who: SessionIdentity, workspace: string, id: string) {
    this.check();
    const c = await this.store.connectionReference(who.ownerId, id);
    if (c.workspaceId !== workspace) this.fail("EXTERNAL_MCP_NOT_FOUND", 404);
    await this.lease.metadata(c, who);
    return c;
  }
  private async active(c: Connection, who: SessionIdentity) {
    this.check();
    await this.lease.run(c, who, async (check) => check());
  }
  async create(who: SessionIdentity, input: unknown) {
    this.check();
    const v = connectionInput.parse(input);
    if (!(await this.workspaces.active(who.ownerId, v.workspaceId)))
      this.fail("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
    if (v.config.kind === "http") {
      const urls = [
        v.config.resource,
        ...(v.config.oauth
          ? [
              v.config.oauth.resourceMetadataUrl,
              v.config.oauth.metadataUrl,
              v.config.oauth.authorizationEndpoint,
              v.config.oauth.tokenEndpoint,
            ]
          : []),
      ];
      if (urls.some((u) => safeUrl(u).href !== u))
        this.fail("EXTERNAL_MCP_URL_CANONICAL_REQUIRED", 400);
    } else await this.catalog.inspect(v.config.programId);
    const id = randomUUID();
    await this.audit(who.ownerId, "connection_save_requested", v.workspaceId, id);
    const initialRef = randomUUID();
    await this.store.stageCredential(who.ownerId, initialRef, this.config.executionHostId);
    this.check();
    this.vault.set(initialRef, {}); // Explicitly credential-free, distinct from failed publication.
    return {
      id: await this.store.create(
        who.ownerId,
        v.workspaceId,
        v.name,
        v.config,
        this.config.executionHostId,
        id,
        initialRef,
      ),
    };
  }
  summary(c: Connection, who: SessionIdentity) {
    let toolsVerified = false;
    if (!this.disconnecting.has(c.id) && !this.cleanupUnknown.has(c.id)) {
      try {
        this.ready(c, who);
        toolsVerified = true;
      } catch {
        /* No live verified snapshot. */
      }
    }
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      config: c.config,
      version: c.version,
      disabled: c.disabled,
      snapshot: c.snapshot,
      snapshotHash: c.snapshotHash,
      approvedTools: c.approvedTools
        .filter((v) => v.sessionId === who.sessionId)
        .map((v) => ({ name: v.name, hash: v.hash })),
      installationHash: c.installationHash,
      toolsVerified,
      executionHostChanged: c.executionHostId !== this.config.executionHostId,
      credentialConfigured:
        c.executionHostId === this.config.executionHostId &&
        Object.keys(this.vault.get(c.credentialRef)).length > 0,
      connected:
        this.disconnecting.has(c.id) || this.cleanupUnknown.has(c.id)
          ? null
          : (this.drivers.get(c.id)?.driver.isConnected ?? false),
      lifecycle: this.cleanupUnknown.has(c.id)
        ? "cleanup_unknown"
        : this.disconnecting.has(c.id)
          ? "closing"
          : this.drivers.get(c.id)?.driver.isConnected
            ? "connected"
            : "disconnected",
    };
  }
  async list(who: SessionIdentity, workspace: string) {
    this.check();
    if (!(await this.workspaces.active(who.ownerId, workspace)))
      this.fail("EXTERNAL_MCP_WORKSPACE_REJECTED", 403);
    return (await this.store.list(who.ownerId, workspace)).map((c) =>
      c.config === null
        ? {
            id: c.id,
            workspaceId: c.workspaceId,
            name: c.name,
            disabled: c.disabled,
            config: null,
            cleanupRequired: c.cleanupRequired,
          }
        : this.summary(c, who),
    );
  }
  async credentials(c: Connection, who: SessionIdentity, input: unknown) {
    const value = credentialsInput.parse(input);
    if (c.config.kind === "http") {
      if (
        value.environment ||
        c.config.authentication === "none" ||
        (c.config.authentication === "bearer" &&
          (!value.bearer || value.apiKey || value.clientSecret)) ||
        (c.config.authentication === "api_key" &&
          (!value.apiKey || value.bearer || value.clientSecret)) ||
        (c.config.authentication === "oauth" && (value.bearer || value.apiKey))
      )
        this.fail("EXTERNAL_MCP_CREDENTIAL_PROFILE", 400);
    } else {
      const p = await this.catalog.inspect(c.config.programId);
      if (
        value.bearer ||
        value.apiKey ||
        value.clientSecret ||
        Object.keys(value.environment ?? {}).some((k) => !p.secretEnvironment.includes(k))
      )
        this.fail("EXTERNAL_MCP_CREDENTIAL_PROFILE", 400);
    }
    await this.active(c, who);
    await this.audit(who.ownerId, "credential_change_requested", c.workspaceId, c.id);
    await this.replaceCredentials(c, who, value);
  }
  private async replaceCredentials(
    c: Connection,
    who: SessionIdentity,
    value: Credentials,
    oauthAttempt?: string,
    assert: () => void = () => {},
    published: () => void = () => {},
  ) {
    assert();
    this.check();
    await this.cleanupCredentials();
    const ref = randomUUID();
    await this.store.stageCredential(who.ownerId, ref, this.config.executionHostId);
    assert();
    this.check();
    try {
      await this.store.changedCredential(who.ownerId, c.id, c.version, ref, who, () => {
        this.check();
        assert();
      });
    } finally {
      this.oauth.revoke(c.id, oauthAttempt, c.version);
      this.invocations.invalidate(c.id, c.version);
      const old = this.drivers.get(c.id);
      if (old && old.driver.connection.version <= c.version) void this.disconnect(c.id, old.driver);
    }
    const next = await this.store.connection(who.ownerId, c.id);
    if (next.credentialRef !== ref || next.version !== c.version + 1)
      throw new ExternalMcpError("EXTERNAL_MCP_VERSION_CHANGED", 409);
    await this.lease.run(next, who, async (check) => {
      check();
      this.check();
      assert();
      this.vault.set(ref, value);
      published();
    });
    await this.cleanupCredentials();
  }
  private cleanupCredentials() {
    if (this.cleaning) return this.cleaning;
    if (this.closed) return Promise.resolve();
    this.cleaning = this.store
      .cleanupCredentials(
        this.config.executionHostId,
        (ref) => this.vault.remove(ref),
        (ref) => this.vault.has(ref),
      )
      .catch((error) => diagnostics.error("mcp.external_failed", {}, error))
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }
  private invalidate(id: string) {
    this.oauth.revoke(id);
    void this.disconnect(id);
    this.invocations.invalidate(id);
  }
  async disable(c: ConnectionReference, who: SessionIdentity) {
    await this.audit(who.ownerId, "connection_disable_requested", c.workspaceId, c.id);
    await this.store.disable(c, who);
    this.invalidate(c.id);
    await this.cleanupCredentials();
  }
  async startOAuth(c: Connection, who: SessionIdentity) {
    takeRate(this.oauthRate, c.id);
    await this.audit(who.ownerId, "authorization_requested", c.workspaceId, c.id);
    return this.oauth.begin(c, who);
  }
  async finishOAuth(who: SessionIdentity, id: string) {
    const pending = this.oauth.view(who, id);
    const c = await this.connection(who, pending.workspaceId, pending.connectionId);
    await this.audit(who.ownerId, "authorization_requested", c.workspaceId, c.id);
    const result = await this.oauth.finish(who, id);
    await this.audit(who.ownerId, "authorization_finished", c.workspaceId, c.id);
    return result;
  }
  async approveProgram(c: Connection, who: SessionIdentity, hash: string) {
    if (c.config.kind !== "stdio") this.fail("EXTERNAL_MCP_PROGRAM_REJECTED", 400);
    const p = await this.catalog.inspect(c.config.programId);
    if (p.installationHash !== hash) this.fail("EXTERNAL_MCP_PROGRAM_CHANGED");
    await this.audit(who.ownerId, "tool_approval_requested", c.workspaceId, c.id);
    await this.store.discovery(who.ownerId, c.id, c.version, [], hash, who, () => this.check());
    this.invalidate(c.id);
  }
  private driver(c: Connection, who: SessionIdentity) {
    this.executionLifecycle(c.id);
    const old = this.drivers.get(c.id);
    if (old) {
      if (old.driver.connection.version !== c.version || old.who.sessionId !== who.sessionId)
        this.fail("EXTERNAL_MCP_RECONNECT_REQUIRED");
      clearTimeout(old.idle);
      old.idle = this.idle(c.id);
      return old.driver;
    }
    if (this.physical >= 8) this.fail("EXTERNAL_MCP_CONNECTION_CAPACITY", 503);
    this.physical++;
    const driver = new ExternalDriver(
      c,
      this.config,
      this.vault,
      this.lease,
      this.resolver,
      this.catalog,
    );
    this.drivers.set(c.id, { driver, who, idle: this.idle(c.id) });
    return driver;
  }
  private ready(c: Connection, who: SessionIdentity) {
    this.executionLifecycle(c.id);
    const current = this.drivers.get(c.id);
    if (
      !current ||
      current.who.sessionId !== who.sessionId ||
      current.driver.connection.version !== c.version
    )
      this.fail("EXTERNAL_MCP_RECONNECT_REQUIRED", 409);
    current.driver.verifySnapshot(c.snapshotHash);
  }
  private executionLifecycle(id: string) {
    this.check();
    if (this.cleanupUnknown.has(id)) this.fail("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
    if (this.disconnecting.has(id)) this.fail("EXTERNAL_MCP_CONNECTION_BUSY", 409);
  }
  private idle(id: string) {
    const timer = setTimeout(() => {
      const active = this.invocations.busy(id);
      if (active) {
        const d = this.drivers.get(id);
        if (d) d.idle = this.idle(id);
      } else void this.disconnect(id);
    }, 240000);
    timer.unref();
    return timer;
  }
  async disconnect(id: string, expected?: ExternalDriver) {
    const pending = this.disconnecting.get(id);
    if (pending) {
      await pending;
      if (!expected && this.drivers.has(id)) await this.disconnect(id);
      return;
    }
    const d = this.drivers.get(id);
    if (expected && d?.driver !== expected) return;
    if (!d) {
      this.invocations.invalidate(id, expected?.connection.version);
      return;
    }
    this.drivers.delete(id);
    clearTimeout(d.idle);
    // Register closing before invoking any cleanup or invalidation callback.
    const closing = Promise.resolve().then(async () => {
      try {
        await d.driver.close();
        this.physical--;
      } catch {
        this.cleanupUnknown.add(id);
        diagnostics.error(
          "mcp.external_failed",
          { externalConnectionId: id },
          new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503),
        ); /* Unproven process cleanup keeps its physical capacity. */
      }
    });
    this.disconnecting.set(id, closing);
    this.invocations.invalidate(id, expected?.connection.version);
    try {
      await closing;
    } finally {
      if (this.disconnecting.get(id) === closing) this.disconnecting.delete(id);
    }
  }
  async disconnectForUser(id: string) {
    await this.disconnect(id);
    if (this.cleanupUnknown.has(id)) this.fail("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
  }
  async discover(c: Connection, who: SessionIdentity) {
    this.executionLifecycle(c.id);
    takeRate(this.discoveryRate, c.id);
    if (this.invocations.busy(c.id)) this.fail("EXTERNAL_MCP_CONNECTION_BUSY");
    await this.audit(who.ownerId, "discovery_requested", c.workspaceId, c.id);
    const driver = this.driver(c, who),
      signal = AbortSignal.timeout(c.config.connectTimeoutMs);
    return driver.within(
      {
        who,
        signal,
        check: () => {
          this.check();
          signal.throwIfAborted();
        },
      },
      async () => {
        const tools = await driver.discover();
        const hash = digest(tools);
        driver.verifySnapshot(hash);
        await this.active(c, who);
        await driver.seal();
        await this.store.discovery(
          who.ownerId,
          c.id,
          c.version,
          tools,
          driver.installationHash,
          who,
          () => {
            this.check();
            signal.throwIfAborted();
            driver.verifySnapshot(hash);
          },
        );
        this.invocations.invalidate(c.id);
        return tools;
      },
      () => this.disconnect(c.id, driver),
    );
  }
  async approve(c: Connection, who: SessionIdentity, hash: string, names: string[]) {
    if (names.length === 0) {
      await this.audit(who.ownerId, "tool_approval_revocation_requested", c.workspaceId, c.id);
      await this.store.revokeTools(who.ownerId, c.id, c.version, who);
      await this.disconnect(c.id);
      return;
    }
    this.ready(c, who);
    if (
      hash !== c.snapshotHash ||
      new Set(names).size !== names.length ||
      names.some((n) => !c.snapshot.some((t) => t.name === n && t.status === "available"))
    )
      this.fail("EXTERNAL_MCP_SNAPSHOT_CHANGED");
    await this.audit(who.ownerId, "tool_approval_requested", c.workspaceId, c.id);
    await this.store.approveTools(
      who.ownerId,
      c.id,
      c.version,
      hash,
      c.snapshot
        .filter((t) => names.includes(t.name))
        .map((t) => ({ name: t.name, hash: t.hash, sessionId: who.sessionId })),
      who,
      () => this.ready(c, who),
    );
    const wasBusy = this.invocations.busy(c.id);
    this.invocations.invalidate(c.id);
    if (wasBusy || this.drivers.get(c.id)?.who.sessionId !== who.sessionId)
      await this.disconnect(c.id);
  }
  private async monitorSessions() {
    for (const [id, d] of this.drivers) {
      try {
        await this.active(d.driver.connection, d.who);
      } catch {
        if (this.drivers.get(id) === d) this.invalidate(id);
      }
    }
    for (const call of this.invocations.references()) {
      try {
        await this.active(call.connection, call.who);
      } catch {
        const driver = this.invocations.invalidateReference(call.id);
        if (driver) void this.disconnect(call.connection.id, driver);
      }
    }
  }
  close() {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    clearInterval(this.monitor);
    this.oauth.close();
    this.shutdown = (async () => {
      const settle = this.invocations.close();
      const results = await Promise.allSettled([
        settle,
        ...[...this.drivers.keys()].map((id) => this.disconnect(id)),
        ...this.disconnecting.values(),
      ]);
      await this.cleaning;
      await this.lease.close();
      if (results.some((result) => result.status === "rejected") || this.cleanupUnknown.size)
        throw new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
    })();
    return this.shutdown;
  }
}
