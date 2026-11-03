import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { createMcpIdentityProvider, SessionIdentity } from "../auth/public.js";
import { McpError } from "./model.js";
import { mcpOAuthScopes } from "./oauth-config.js";
import type { McpStore } from "./store.js";
import { RateBudget } from "./admission.js";
import { AuthorizationWork } from "./authorization-work.js";

type Provider = ReturnType<typeof createMcpIdentityProvider>;
type Consent = {
  owner: string;
  session: string;
  grant: string;
  generation: number;
  query: string;
  expiresAt: number;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  state: string;
};
/** Only these application-controlled flows expose the SDK's OAuth endpoints.
 * The raw consent, registration and token verifier endpoints stay unreachable. */
export class McpOAuthFlow {
  private readonly pending = new Map<string, Consent>();
  private readonly loginIntents = new Map<string, { query: string; expiresAt: number }>();
  private readonly loginRate = new RateBudget(10, 4, undefined, 1);
  private readonly tokenRate = new RateBudget(10, 2);
  private readonly exchanges = new AuthorizationWork();
  constructor(
    readonly provider: Provider,
    private readonly store: McpStore,
    readonly origin: string,
    readonly resource: string,
  ) {}
  private prune() {
    for (const [id, c] of this.pending) if (c.expiresAt <= Date.now()) this.pending.delete(id);
    for (const [id, c] of this.loginIntents)
      if (c.expiresAt <= Date.now()) this.loginIntents.delete(id);
  }
  async login(rawQuery: string) {
    this.prune();
    this.loginRate.take("process");
    const q = this.validQuery(rawQuery);
    if (!(await this.store.approvedCallback(q.get("client_id") ?? "", q.get("redirect_uri") ?? "")))
      throw new McpError("MCP_CLIENT_NOT_APPROVED", 403);
    if (rawQuery.length > 4096 || this.loginIntents.size >= 128)
      throw new McpError("MCP_LOGIN_CAPACITY", 429);
    const id = randomUUID();
    this.loginIntents.set(id, { query: rawQuery, expiresAt: Date.now() + 120000 });
    return `${this.origin}/?mcpLogin=${id}`;
  }
  resumeLogin(id: string) {
    this.prune();
    const item = this.loginIntents.get(id);
    if (!item) throw new McpError("MCP_LOGIN_EXPIRED", 410);
    this.loginIntents.delete(id);
    return `${this.origin}/api/auth/oauth2/authorize?${item.query}`;
  }
  async register(
    identity: SessionIdentity,
    headers: Headers,
    input: { name: string; redirectUri: string; mode: string },
  ) {
    const clients = await this.store.clients(identity.ownerId);
    if (
      clients.filter((c) => !c.disabled).length >= 100 ||
      (input.mode === "local_domain" &&
        clients.some((c) => c.mode === "local_domain" && !c.disabled))
    )
      throw new McpError("MCP_CLIENT_CAPACITY", 409);
    const client = await this.provider.api.createOAuthClient({
      headers,
      body: {
        client_name: input.name,
        redirect_uris: [input.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        application_type: "native",
        response_types: ["code"],
        scope: mcpOAuthScopes.join(" "),
      },
    });
    await this.store.registerClient(identity.ownerId, { ...input, clientId: client.client_id });
    return { clientId: client.client_id };
  }
  async authorize(identity: SessionIdentity, headers: Headers, rawQuery: string) {
    this.prune();
    if (this.pending.size >= 128 || rawQuery.length > 4096)
      throw new McpError("MCP_CONSENT_CAPACITY", 429);
    const q = this.validQuery(rawQuery);
    const client = await this.store.client(identity.ownerId, q.get("client_id") ?? "");
    if (!client || client.redirectUri !== q.get("redirect_uri"))
      throw new McpError("MCP_CLIENT_NOT_APPROVED", 403);
    const grant = (await this.store.grants(identity.ownerId)).find(
      (g) =>
        g.clientId === client.clientId &&
        !g.revoked &&
        g.expiresAt > Date.now() &&
        g.approvalSessionId === identity.sessionId,
    );
    const scopes = (q.get("scope") ?? "").split(" ");
    if (
      !grant ||
      !scopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((s) => !grant.scopes.includes(s))
    )
      throw new McpError("MCP_SCOPE_NOT_APPROVED", 403);
    q.set("prompt", "consent");
    return this.beginConsent(identity, headers, q, grant, client, scopes);
  }
  private validQuery(rawQuery: string) {
    if (rawQuery.length > 4096) throw new McpError("MCP_OAUTH_REQUEST_INVALID");
    const q = new URLSearchParams(rawQuery);
    const allowed = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
      "resource",
      "code_challenge_method",
      "code_challenge",
      "prompt",
    ];
    if (
      [...q.keys()].some((k) => !allowed.includes(k) || q.getAll(k).length !== 1) ||
      q.get("response_type") !== "code" ||
      q.get("resource") !== this.resource ||
      q.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? "") ||
      !/^[A-Za-z0-9._~-]{16,256}$/.test(q.get("state") ?? "")
    )
      throw new McpError("MCP_OAUTH_REQUEST_INVALID");
    return q;
  }
  private async beginConsent(
    identity: SessionIdentity,
    headers: Headers,
    q: URLSearchParams,
    grant: { id: string; generation: number },
    client: { clientId: string; redirectUri: string },
    scopes: string[],
  ) {
    const response = await this.provider.handler(
      new Request(`${this.origin}/api/auth/oauth2/authorize?${q}`, { headers }),
    );
    let location = response.headers.get("location");
    if (response.status === 200) {
      const redirect: unknown = await response.json();
      if (
        redirect &&
        typeof redirect === "object" &&
        "redirect" in redirect &&
        redirect.redirect === true &&
        "url" in redirect &&
        typeof redirect.url === "string"
      )
        location = redirect.url;
    }
    if (![200, 302].includes(response.status) || !location)
      throw new McpError("MCP_CONSENT_UNAVAILABLE", 503);
    const destination = new URL(location, this.origin);
    if (
      destination.origin !== this.origin ||
      destination.pathname !== "/mcp-consent" ||
      destination.searchParams.has("code")
    )
      throw new McpError("MCP_CONSENT_UNAVAILABLE", 503);
    const id = randomUUID();
    this.pending.set(id, {
      owner: identity.ownerId,
      session: identity.sessionId,
      grant: grant.id,
      generation: grant.generation,
      query: destination.searchParams.toString(),
      expiresAt: Date.now() + 120000,
      redirectUri: client.redirectUri,
      clientId: client.clientId,
      scopes,
      state: q.get("state") as string,
    });
    return `${this.origin}/?mcpConsent=${id}`;
  }
  private current(identity: SessionIdentity, id: string) {
    this.prune();
    const consent = this.pending.get(id);
    if (!consent || consent.owner !== identity.ownerId || consent.session !== identity.sessionId)
      throw new McpError("MCP_CONSENT_EXPIRED", 404);
    return consent;
  }
  async review(identity: SessionIdentity, id: string) {
    const item = this.current(identity, id),
      grant = await this.store.active(identity.ownerId, item.grant);
    if (grant.generation !== item.generation) throw new McpError("MCP_GRANT_CHANGED", 403);
    const client = await this.store.client(identity.ownerId, item.clientId);
    if (!client) throw new McpError("MCP_CLIENT_NOT_APPROVED", 403);
    return { id, client, grant, scopes: item.scopes, expiresAt: item.expiresAt };
  }
  async consent(identity: SessionIdentity, headers: Headers, id: string, accept: boolean) {
    await this.review(identity, id);
    const item = this.current(identity, id);
    this.pending.delete(id);
    const response = await this.provider.handler(
      new Request(`${this.origin}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: new Headers({
          cookie: headers.get("cookie") ?? "",
          origin: this.origin,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ accept, oauth_query: item.query }),
      }),
    );
    if (!response.ok) throw new McpError("MCP_CONSENT_REJECTED", 403);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string")
      throw new McpError("MCP_CONSENT_UNAVAILABLE", 503);
    const redirect = new URL(value.url),
      expected = new URL(item.redirectUri);
    if (
      redirect.origin !== expected.origin ||
      redirect.pathname !== expected.pathname ||
      redirect.searchParams.get("state") !== item.state ||
      (accept
        ? !redirect.searchParams.get("code")
        : redirect.searchParams.get("error") !== "access_denied")
    )
      throw new McpError("MCP_CALLBACK_REJECTED", 503);
    if (accept)
      await this.store.bindCode(
        identity.ownerId,
        item.grant,
        item.generation,
        redirect.searchParams.get("code") as string,
      );
    return { redirectUrl: redirect.href };
  }
  async token(raw: string) {
    return this.exchanges.settle(() => this.exchange(raw));
  }
  private async exchange(raw: string) {
    if (Buffer.byteLength(raw) > 8192) throw new McpError("MCP_OAUTH_REQUEST_INVALID", 413);
    const q = new URLSearchParams(raw);
    if (
      [...q.keys()].some(
        (k) =>
          ![
            "grant_type",
            "code",
            "code_verifier",
            "client_id",
            "redirect_uri",
            "resource",
          ].includes(k) || q.getAll(k).length !== 1,
      ) ||
      q.get("grant_type") !== "authorization_code" ||
      q.get("resource") !== this.resource ||
      !q.get("code") ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(q.get("code_verifier") ?? "")
    )
      throw new McpError("MCP_OAUTH_REQUEST_INVALID");
    const binding = await this.store.claimCode(q.get("code") as string, (b) =>
      this.tokenRate.take(b.grantId),
    );
    const response = await this.provider.handler(
      new Request(`${this.origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: raw,
      }),
    );
    if (!response.ok) return response;
    const data: unknown = await response.clone().json();
    if (
      !data ||
      typeof data !== "object" ||
      !("access_token" in data) ||
      typeof data.access_token !== "string" ||
      "refresh_token" in data
    )
      throw new McpError("MCP_TOKEN_UNAVAILABLE", 503);
    await this.store.bindToken(data.access_token, binding);
    return response;
  }
  async verify(headers: IncomingHttpHeaders) {
    const authorization = headers.authorization;
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._~-]{1,4096}$/.test(authorization)
    )
      throw new McpError("MCP_UNAUTHENTICATED", 401);
    return this.provider.api.verifyMcpResourceToken({ body: { token: authorization.slice(7) } });
  }
}
