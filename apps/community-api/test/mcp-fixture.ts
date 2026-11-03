import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";

import express from "express";
import { mutationFixture } from "./mutation-fixture.js";
import { isolatedMysql } from "./isolated-mysql.js";
import { createAuth, authSessionAccess, authMutationIdentity } from "../src/auth.js";
import { migrateMcpSchema, verifyMcpSchema } from "../src/mcp/migration.js";
import { createMcpRuntime } from "../src/mcp/runtime.js";
import { mountMcpManagement, mountMcpOAuth, type McpManagement } from "../src/mcp/routes.js";
import { ScopeCoordinator } from "../src/datasources/public.js";
import { ReadService } from "../src/queries/service.js";
import type { QueryConnector } from "../src/connectors/public.js";
import { mountProductRoutes } from "../src/product-routes.js";
import type { McpAudit } from "../src/mcp/model.js";

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const address = s.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((r) => s.close(() => r()));
  return address.port;
}
export async function mcpFixture(
  mode: "http" | "local_domain" = "http",
  audit: McpAudit = async () => {},
  configure?: (app: express.Express, auth: ReturnType<typeof createAuth>, origin: string) => void,
  changeDrafts = false,
) {
  const f = await mutationFixture({ completeSchema: true });
  const isolated = await isolatedMysql();
  const pools = {
    sdk: isolated.pool(f.database),
    observation: isolated.pool(f.database),
    storage: isolated.pool(f.database),
  };
  let runtime: Awaited<ReturnType<typeof createMcpRuntime>> | undefined;
  let http: ReturnType<typeof createServer> | undefined;
  let reads: ReadService | undefined;
  try {
    await migrateMcpSchema(f.pool);
    await verifyMcpSchema(f.pool);
    await migrateMcpSchema(f.pool);
    const port = await freePort(),
      resourcePort = await freePort(),
      origin = `http://127.0.0.1:${port}`;
    const config = {
      databaseUrl: "mysql://unused:unused@127.0.0.1:13308/unused",
      secret: randomBytes(32).toString("hex"),
      origin,
    };
    const auth = createAuth(config, f.pool);
    const password = randomBytes(24).toString("hex"),
      username = `mcp${randomBytes(6).toString("hex")}`;
    const signed = await auth.api.signUpEmail({
      body: { name: "MCP isolated", username, email: `${randomUUID()}@example.invalid`, password },
    });
    const who = signed.user.id;
    await f.pool.execute("UPDATE workspace SET createdByAccountId=? WHERE id=?", [
      who,
      f.binding.workspaceId,
    ]);
    await f.pool.execute("UPDATE data_source SET ownerId=? WHERE id=?", [who, f.binding.sourceId]);
    f.binding.ownerId = who;
    const login = await auth.api.signInUsername({
      body: { username, password },
      returnHeaders: true,
    });
    const cookie = login.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    const identity = await authMutationIdentity(auth)({ cookie });
    assert.ok(identity);
    const coordinator = new ScopeCoordinator(f.sources, {
      withActiveOwner: async (owner, connector, work) =>
        owner === who && connector === f.binding.connectorId ? work() : undefined,
    });
    // Authentication/storage and real protocol are exercised here. Connector
    // execution has a separate signed Go integration test; never connect the original DB.
    const connector = {
      withActiveOwner: async (_o: string, _c: string, work: () => unknown) => work(),
      issueReadTask: async (task: Parameters<QueryConnector["issueReadTask"]>[0]) => ({
        ...task,
        protocol: 1 as const,
        signature: "fixture-signature",
      }),
    } as unknown as QueryConnector;
    reads = new ReadService(
      f.sources,
      connector,
      authSessionAccess(auth, f.pool),
      undefined,
      coordinator,
    );
    const resource = `http://127.0.0.1:${resourcePort}/mcp`;
    runtime = await createMcpRuntime({
      config: { resource, host: "127.0.0.1", port: resourcePort },
      auth: config,
      pools,
      coordinator,
      reads,
      key: randomBytes(32),
      audit,
      changeDraftsEnabled: changeDrafts,
    });
    const app = express();
    const management = () =>
      runtime
        ? ({ ...runtime, authenticate: authMutationIdentity(auth) } satisfies McpManagement)
        : undefined;
    mountMcpOAuth(app, origin, management);
    mountMcpManagement(app, origin, management);
    configure?.(app, auth, origin);
    mountProductRoutes(app, auth, f.pool, origin);
    http = createServer(app);
    await new Promise<void>((r) => http?.listen(port, "127.0.0.1", r));
    const headers = { cookie, origin, "content-type": "application/json" };
    const request = async (path: string, data?: unknown, h = headers) =>
      fetch(`${origin}${path}`, {
        method: data === undefined ? "GET" : "POST",
        headers: h,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    const c = await request("/api/mcp/clients", {
      name: "isolated fixture",
      redirectUri: "http://127.0.0.1:19492/callback",
      mode,
    });
    assert.equal(c.status, 201, await c.clone().text());
    const client: { clientId: string } = await c.json();
    const scope = {
      clientId: client.clientId,
      workspaceId: f.binding.workspaceId,
      sourceId: f.binding.sourceId,
      tables: [["customers", ["id"]]],
      scopes: [
        "metadata:read",
        "query:prepare",
        "operation:read",
        "operation:cancel",
        ...(changeDrafts ? ["change:propose"] : []),
      ],
      durationMinutes: 60,
    };
    const g = await request("/api/mcp/grants", scope);
    assert.equal(g.status, 201, await g.clone().text());
    const grant: { id: string } = await g.json();
    async function token() {
      const verifier = randomBytes(32).toString("base64url"),
        state = randomBytes(24).toString("base64url");
      const query = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: "http://127.0.0.1:19492/callback",
        response_type: "code",
        scope: scope.scopes.join(" "),
        state,
        resource,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      const response = await fetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
        headers,
        redirect: "manual",
      });
      assert.equal(response.status, 302, await response.clone().text());
      const id = new URL(response.headers.get("location") as string).searchParams.get("mcpConsent");
      assert.ok(id);
      const review = await request(`/api/mcp/consents/${id}`);
      assert.equal(review.status, 200, await review.clone().text());
      const approved = await request(`/api/mcp/consents/${id}`, { accept: true });
      assert.equal(approved.status, 200, await approved.clone().text());
      const result: { redirectUrl: string } = await approved.json(),
        code = new URL(result.redirectUrl).searchParams.get("code");
      assert.ok(code);
      assert.equal(new URL(result.redirectUrl).searchParams.get("state"), state);
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: client.clientId,
        redirect_uri: "http://127.0.0.1:19492/callback",
        resource,
      });
      const exchanged = await fetch(`${origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      });
      assert.equal(exchanged.status, 200, await exchanged.clone().text());
      const tokens: { access_token: string; refresh_token?: string } = await exchanged.json();
      assert.equal(tokens.refresh_token, undefined);
      return tokens.access_token;
    }
    return {
      ...f,
      app,
      runtime,
      reads,
      setSigner: (sign: QueryConnector["issueReadTask"]) => {
        connector.issueReadTask = sign;
      },
      auth,
      origin,
      resource,
      client,
      grant,
      scope,
      identity,
      cookie,
      username,
      password,
      headers,
      request,
      token,
      close: async () => {
        await runtime?.close();
        reads?.close();
        http?.closeAllConnections();
        if (http) await new Promise<void>((r) => http?.close(() => r()));
        await Promise.all(Object.values(pools).map((p) => p.end()));
        await f.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    reads?.close();
    http?.closeAllConnections();
    if (http) await new Promise<void>((r) => http?.close(() => r()));
    await Promise.all(Object.values(pools).map((p) => p.end()));
    await f.close();
    throw error;
  }
}
