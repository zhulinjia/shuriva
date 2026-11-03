import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authMutationIdentity } from "../src/auth.js";
import { ExternalLease } from "../src/mcp-client/lease.js";
import { migrateExternalSchema, verifyExternalSchema } from "../src/mcp-client/migration.js";
import type { ClientAudit } from "../src/mcp-client/model.js";
import type { Pool } from "mysql2/promise";
import { RuntimeOwnership } from "../src/mcp-client/ownership.js";
import { mountExternalMcp } from "../src/mcp-client/routes.js";
import { ExternalMcpService } from "../src/mcp-client/service.js";
import { ExternalMcpStore } from "../src/mcp-client/store.js";
import { systemClientVault, type ClientVault } from "../src/mcp-client/vault.js";
import { WorkspaceStore } from "../src/workspaces.js";
import { isolatedMysql } from "./isolated-mysql.js";
import { mcpFixture } from "./mcp-fixture.js";
export async function externalFixture(
  audit: ClientAudit = async () => {},
  storage: (pool: Pool) => Pool = (pool) => pool,
  credentials: (vault: ClientVault) => ClientVault = (vault) => vault,
  withUnsupportedTool = false,
) {
  let service: ExternalMcpService | undefined;
  const f = await mcpFixture(
    "http",
    async () => {},
    (app, auth, origin) => {
      mountExternalMcp(app, origin, () =>
        service ? { service, authenticate: authMutationIdentity(auth) } : undefined,
      );
    },
  );
  const isolated = await isolatedMysql(),
    admission = isolated.pool(f.database),
    root = resolve(".cache", `external-mcp-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  let version = 1,
    calls = 0,
    delay = 0,
    received: unknown,
    authorization: string | undefined,
    exchanges = 0,
    required = false,
    authorizationOverride = "",
    headerMismatch = false,
    unsupportedVersion = 1;
  const handler = createMcpHandler(
    () => {
      const s = new McpServer({ name: "isolated-external", version: String(version) });
      s.registerTool(
        "echo",
        {
          description: `Echo revision ${version}`,
          inputSchema: z.strictObject({ text: z.string().max(200) }),
        },
        async (args) => {
          calls++;
          received = args;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          return { content: [{ type: "text", text: args.text }] };
        },
      );
      if (withUnsupportedTool)
        s.registerTool(
          "unsupported_uri",
          {
            description: `Unsupported revision ${unsupportedVersion}`,
            inputSchema: z.object({ url: z.url() }),
          },
          async () => {
            calls++;
            return { content: [{ type: "text", text: "unexpected" }] };
          },
        );
      return s;
    },
    { legacy: "reject", maxRequestBodySize: 65536 },
  );
  let resource = "",
    issuer = "";
  const external = createServer((req, res) => {
    const path = req.url?.split("?")[0],
      json = (v: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(v));
      };
    if (path === "/.well-known/oauth-protected-resource") {
      json({ resource, authorization_servers: [issuer] });
      return;
    }
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      json({
        issuer,
        authorization_endpoint: authorizationOverride || `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    if (path === "/token") {
      exchanges++;
      void (async () => {
        let raw = "";
        for await (const part of req) raw += part;
        if (raw.length > 8192) {
          res.writeHead(413).end();
          return;
        }
        const b = new URLSearchParams(raw);
        if (
          b.get("code") !== "synthetic-code" ||
          !b.get("code_verifier") ||
          b.get("resource") !== resource
        ) {
          res.writeHead(400);
          json({ error: "invalid_grant" });
          return;
        }
        json({
          access_token: "synthetic-oauth-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "tools:call",
        });
      })();
      return;
    }
    authorization = req.headers.authorization;
    if (headerMismatch && req.headers["mcp-method"] === "tools/call") {
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        calls++;
        json({
          jsonrpc: "2.0",
          id: b.id,
          error: { code: -32020, message: "synthetic header mismatch after side effect" },
        });
      })();
      return;
    }
    if (required && authorization !== "Bearer synthetic-oauth-token") {
      res.writeHead(401);
      json({ error: "unauthorized" });
      return;
    }
    void toNodeHandler(handler)(req, res);
  });
  await new Promise<void>((r) => external.listen(0, "127.0.0.1", r));
  const address = external.address();
  if (!address || typeof address === "string") throw Error();
  issuer = `http://127.0.0.1:${address.port}`;
  resource = `${issuer}/mcp`;
  await migrateExternalSchema(f.pool);
  await verifyExternalSchema(f.pool);
  await migrateExternalSchema(f.pool);
  const vault = systemClientVault(`shuriva-external-fixture-${randomUUID()}`),
    refs = new Set<string>();
  const executionHostId = randomBytes(32).toString("hex");
  service = new ExternalMcpService(
    new ExternalMcpStore(storage(f.pool)),
    new ExternalLease(admission, await RuntimeOwnership.claim(f.pool), executionHostId),
    new WorkspaceStore(f.pool),
    credentials({
      get: (r) => vault.get(r),
      has: (r) => vault.has(r),
      set: (r, v) => {
        refs.add(r);
        vault.set(r, v);
      },
      remove: (r) => {
        vault.remove(r);
        refs.delete(r);
      },
    }),
    {
      origin: f.origin,
      executionHostId,
      controlPorts: [Number(new URL(f.origin).port)],
      programRoot: resolve(root, "programs"),
      runRoot: resolve(root, "runs"),
      hostExecutable: resolve("apps/community-api/bin/mcp-host.exe"),
    },
    randomBytes(32),
    audit,
  );
  await service.initialize();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    f.request(path, body, { ...f.headers, ...headers });
  const base = `/api/external-mcp/workspaces/${f.binding.workspaceId}/connections`;
  return {
    ...f,
    service,
    root,
    resource,
    issuer,
    base,
    request,
    stats: () => ({ calls, received, authorization, exchanges }),
    hasCredential: (ref: string) => vault.has(ref),
    requireOAuth: () => {
      required = true;
    },
    authorizeAt: (url: string) => {
      authorizationOverride = url;
    },
    mismatchAfterDispatch: () => {
      headerMismatch = true;
    },
    oauthConfig: {
      issuer,
      resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource`,
      metadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      clientId: "synthetic-client",
      scopes: ["tools:call"],
    },
    change: () => {
      version++;
    },
    changeUnsupported: () => {
      unsupportedVersion++;
    },
    delay: (n: number) => {
      delay = n;
    },
    notifyToolsChanged: () => handler.notify.toolsChanged(),
    closeSubscriptions: () => handler.close(),
    httpConfig: {
      kind: "http",
      resource,
      authentication: "none",
      privateApprovals: [{ origin: new URL(resource).origin, addresses: ["127.0.0.1"] }],
      oauth: null,
    },
    close: async () => {
      let failure: unknown;
      const settle = async (cleanup: () => unknown) => {
        try {
          await cleanup();
        } catch (error) {
          failure ??= error;
        }
      };
      await settle(() => service.close());
      for (const r of refs) await settle(() => vault.remove(r));
      await settle(() => admission.end());
      await settle(async () => {
        external.closeAllConnections();
        await new Promise<void>((r) => external.close(() => r()));
      });
      await settle(() => f.close());
      await settle(async () => {
        if (dirname(await realpath(root)).toLowerCase() !== resolve(".cache").toLowerCase())
          throw Error("fixture cleanup path rejected");
        await rm(root, { recursive: true, force: true });
      });
      if (failure) throw failure;
    },
  };
}
