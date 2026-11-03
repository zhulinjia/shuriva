import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  buildDiscoveryUrls,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthErrorCode,
  auth as sdkAuth,
} from "@modelcontextprotocol/client";
import type { SessionIdentity } from "../auth/public.js";
import { type Connection, type Credentials, ExternalMcpError } from "./model.js";

type Pending = {
  id: string;
  state: string;
  connection: Connection;
  who: SessionIdentity;
  until: number;
  monotonic: number;
  verifier?: string;
  code?: string;
  iss?: string;
  denied?: boolean;
  discovery: OAuthDiscoveryState;
  authorizationUrl?: string;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  returned?: boolean;
  published?: boolean;
};
export class ExternalOAuth {
  private readonly pending = new Map<string, Pending>();
  private starting = 0;
  private closed = false;
  private sdkFetch(c: Connection, w: SessionIdentity, signal: AbortSignal): typeof fetch {
    const run = this.fetchFor(c, w, signal);
    return async (input, init) => {
      const response = await run(input, init);
      if (response.status < 400) return response;
      let code = "server_error";
      try {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string" &&
          Object.values(OAuthErrorCode).some((value) => value === body.error)
        )
          code = body.error;
      } catch {}
      return new Response(JSON.stringify({ error: code }), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
  }
  constructor(
    private readonly origin: string,
    private readonly active: (c: Connection, who: SessionIdentity) => Promise<void>,
    private readonly fetchFor: (
      c: Connection,
      who: SessionIdentity,
      signal: AbortSignal,
    ) => typeof fetch,
    private readonly load: (ref: string) => Credentials,
    private readonly save: (
      connection: Connection,
      who: SessionIdentity,
      attemptId: string,
      change: (current: Credentials) => Credentials,
      check: () => void,
      published: () => void,
    ) => Promise<void>,
    private readonly authorizeDestination: (c: Connection, signal: AbortSignal) => Promise<void>,
  ) {}
  private check(p: Pending) {
    // A verified vault publication is an observed fact; later timeout/close
    // cannot turn that completed publication into a failed authorization.
    if (p.published) return;
    if (
      this.closed ||
      this.pending.get(p.id) !== p ||
      p.abort.signal.aborted ||
      Date.now() >= p.until ||
      performance.now() >= p.monotonic
    )
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_EXPIRED", 410);
  }
  private discard(p: Pending) {
    p.abort.abort();
    p.verifier = undefined;
    p.code = undefined;
    p.state = "";
    clearTimeout(p.timer);
    this.pending.delete(p.id);
  }
  private profile(c: Connection) {
    if (c.config.kind !== "http" || !c.config.oauth || c.config.authentication !== "oauth")
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CONFIG");
    return c.config.oauth;
  }
  async begin(c: Connection, who: SessionIdentity) {
    if (this.closed) throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
    if (this.pending.size + this.starting >= 16)
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CAPACITY", 429);
    this.starting++;
    try {
      return await this.beginWork(c, who);
    } finally {
      this.starting--;
    }
  }
  private async beginWork(c: Connection, who: SessionIdentity) {
    await this.active(c, who);
    const config = this.profile(c),
      abort = new AbortController(),
      signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      fetchFn = this.sdkFetch(c, who, signal);
    if (!buildDiscoveryUrls(config.issuer).some((v) => v.url.href === config.metadataUrl))
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_METADATA_URL_REJECTED");
    const resource = await discoverOAuthProtectedResourceMetadata(
      c.config.kind === "http" ? c.config.resource : "",
      { resourceMetadataUrl: config.resourceMetadataUrl },
      fetchFn,
    );
    const first = buildDiscoveryUrls(config.issuer)[0]?.url.href;
    const metadata = await discoverAuthorizationServerMetadata(config.issuer, {
      fetchFn: (input, init) => {
        const raw = input instanceof Request ? input.url : input.toString();
        if (raw !== first) throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_METADATA_URL_REJECTED");
        return fetchFn(config.metadataUrl, init);
      },
    });
    if (
      !metadata ||
      metadata.issuer !== config.issuer ||
      metadata.authorization_endpoint !== config.authorizationEndpoint ||
      metadata.token_endpoint !== config.tokenEndpoint ||
      !resource.authorization_servers?.includes(config.issuer) ||
      c.config.kind !== "http" ||
      resource.resource !== c.config.resource
    )
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_METADATA_CHANGED", 403);
    await this.active(c, who);
    await this.authorizeDestination(c, signal);
    await this.active(c, who);
    if (this.closed) throw new ExternalMcpError("EXTERNAL_MCP_CLOSED", 503);
    const id = randomUUID(),
      p: Pending = {
        id,
        state: randomBytes(32).toString("base64url"),
        connection: c,
        who,
        until: Date.now() + 120000,
        monotonic: performance.now() + 120000,
        discovery: {
          authorizationServerUrl: config.issuer,
          authorizationServerMetadata: metadata,
          resourceMetadata: resource,
          resourceMetadataUrl: config.resourceMetadataUrl,
        },
        abort,
        timer: setTimeout(() => {}, 1),
        claimed: false,
      };
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.discard(p), 120000);
    p.timer.unref();
    this.pending.set(id, p);
    try {
      await sdkAuth(this.provider(p), {
        serverUrl: c.config.resource,
        scope: config.scopes.join(" "),
        fetchFn: this.sdkFetch(c, who, AbortSignal.any([abort.signal, AbortSignal.timeout(10000)])),
        forceReauthorization: true,
      });
      this.check(p);
      if (!p.authorizationUrl || !p.verifier)
        throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_UNAVAILABLE", 503);
      return { id, authorizationUrl: p.authorizationUrl };
    } catch (error) {
      this.discard(p);
      throw error;
    }
  }
  private provider(p: Pending): OAuthClientProvider {
    const c = p.connection,
      config = this.profile(c),
      redirect = `${this.origin}/api/external-mcp/oauth/callback`;
    return {
      redirectUrl: redirect,
      clientMetadata: {
        redirect_uris: [redirect],
        token_endpoint_auth_method: this.load(c.credentialRef).clientSecret
          ? "client_secret_basic"
          : "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        application_type: "web",
        scope: config.scopes.join(" "),
      },
      clientInformation: (ctx) => {
        this.check(p);
        if (ctx && ctx.issuer !== config.issuer)
          throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_ISSUER_REJECTED");
        const secret = this.load(c.credentialRef).clientSecret;
        return {
          client_id: config.clientId,
          ...(secret ? { client_secret: secret } : {}),
          issuer: config.issuer,
        };
      },
      tokens: () => undefined,
      state: () => p.state,
      redirectToAuthorization: (u) => {
        this.check(p);
        if (
          `${u.origin}${u.pathname}` !== config.authorizationEndpoint ||
          u.searchParams.get("state") !== p.state ||
          u.searchParams.get("resource") !== (c.config.kind === "http" ? c.config.resource : "") ||
          u.searchParams.get("code_challenge_method") !== "S256"
        )
          throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_REDIRECT_REJECTED");
        p.authorizationUrl = u.href;
      },
      saveCodeVerifier: (value) => {
        this.check(p);
        p.verifier = value;
      },
      codeVerifier: () => {
        this.check(p);
        if (!p.verifier) throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_EXPIRED");
        return p.verifier;
      },
      discoveryState: () => p.discovery,
      saveDiscoveryState: (value) => {
        this.check(p);
        if (
          value.authorizationServerUrl !== config.issuer ||
          value.resourceMetadata?.resource !== (c.config.kind === "http" ? c.config.resource : "")
        )
          throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_ISSUER_REJECTED");
        p.discovery = value;
      },
      validateResourceURL: async (u, resource) => {
        const expected = c.config.kind === "http" ? c.config.resource : "";
        if (new URL(u).href !== new URL(expected).href || resource !== expected)
          throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_RESOURCE_REJECTED");
        return new URL(expected);
      },
      saveTokens: async (tokens) => {
        this.check(p);
        await this.active(c, p.who);
        this.check(p);
        if (
          tokens.token_type.toLowerCase() !== "bearer" ||
          tokens.issuer !== config.issuer ||
          tokens.access_token.length > 4096 ||
          tokens.scope?.split(" ").some((s) => !config.scopes.includes(s))
        )
          throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_TOKEN_REJECTED");
        await this.save(
          c,
          p.who,
          p.id,
          (saved) => {
            this.check(p);
            return {
              ...saved,
              tokens,
              tokenExpiresAt: Date.now() + Math.min(300000, (tokens.expires_in ?? 300) * 1000),
            };
          },
          () => this.check(p),
          () => {
            p.published = true;
            clearTimeout(p.timer);
          },
        );
      },
    };
  }
  async callback(query: Record<string, string>) {
    const state = query.state ?? "",
      hash = (v: string) => createHash("sha256").update(v).digest("hex");
    const p = [...this.pending.values()].find((v) => hash(v.state) === hash(state));
    if (!p || p.claimed || p.returned || p.code || p.denied)
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CALLBACK_REJECTED", 403);
    this.check(p);
    p.returned = true;
    const config = this.profile(p.connection);
    if (
      (query.iss && query.iss !== config.issuer) ||
      (p.discovery.authorizationServerMetadata?.authorization_response_iss_parameter_supported ===
        true &&
        query.iss !== config.issuer) ||
      !(query.code || query.error) ||
      (query.code && query.error) ||
      (query.code && query.code.length > 4096)
    ) {
      this.discard(p);
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CALLBACK_REJECTED", 403);
    }
    await this.active(p.connection, p.who);
    this.check(p);
    if (query.error) {
      p.denied = true;
      p.verifier = undefined;
    } else {
      p.code = query.code;
      p.iss = query.iss;
    }
    return p.id;
  }
  view(who: SessionIdentity, id: string) {
    const p = this.pending.get(id);
    if (!p || p.who.ownerId !== who.ownerId || p.who.sessionId !== who.sessionId)
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_NOT_FOUND", 404);
    this.check(p);
    return {
      id,
      connectionId: p.connection.id,
      workspaceId: p.connection.workspaceId,
      denied: !!p.denied,
      ready: !!p.code,
    };
  }
  async finish(who: SessionIdentity, id: string) {
    const p = this.pending.get(id);
    this.view(who, id);
    if (!p || p.claimed || !p.code || p.denied)
      throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_NOT_READY", 409);
    p.claimed = true;
    try {
      await this.active(p.connection, who);
      this.check(p);
      const c = p.connection;
      if (c.config.kind !== "http") throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_CONFIG");
      const config = this.profile(c);
      const result = await sdkAuth(this.provider(p), {
        serverUrl: c.config.resource,
        authorizationCode: p.code,
        iss: p.iss,
        scope: config.scopes.join(" "),
        fetchFn: this.sdkFetch(
          c,
          who,
          AbortSignal.any([p.abort.signal, AbortSignal.timeout(10000)]),
        ),
      });
      this.check(p);
      if (result !== "AUTHORIZED")
        throw new ExternalMcpError("EXTERNAL_MCP_OAUTH_UNAVAILABLE", 503);
      return { authorized: true };
    } catch (error) {
      if (p.published) return { authorized: true };
      throw error;
    } finally {
      this.discard(p);
    }
  }
  revoke(id: string, keepAttempt?: string, throughVersion = Number.POSITIVE_INFINITY) {
    for (const p of this.pending.values())
      if (p.connection.id === id && p.id !== keepAttempt && p.connection.version <= throughVersion)
        this.discard(p);
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) this.discard(p);
  }
}
