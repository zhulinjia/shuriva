import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";
import type { Pool } from "mysql2/promise";
import {
  authSessionReferenceDeadline,
  createMcpIdentityProvider,
  pruneMcpIdentityMetadata,
} from "../auth/public.js";
import type { AuthConfig } from "../auth.js";
import { bindingIdentitiesAvailable, type ScopeCoordinator } from "../datasources/public.js";
import type { DelegatedRead } from "../queries/public.js";
import type { AuthorizedMcpGrant, HandoffReceipt } from "./grant-authority.js";
import { createMcpGrantAuthority } from "./grant-authority.js";
import { McpInvocations } from "./invocations.js";
import { startLocalChannel } from "./local-channel.js";
import { verifyMcpSchema } from "./migration.js";
import type { McpAudit } from "./model.js";
import { mysqlMcpGrantObservation } from "./mysql-grant-observation.js";
import { createMcpOAuthOptions } from "./oauth-config.js";
import { McpOAuthFlow } from "./oauth-flow.js";
import { startMcpServer } from "./server.js";
import { McpStore } from "./store.js";

export interface McpConfig {
  resource: string;
  host: string;
  port: number;
}
export function readMcpConfig(env: NodeJS.ProcessEnv): McpConfig | undefined {
  const flag = env.ENABLE_STAGE9_MCP ?? "0";
  if (flag === "0") return;
  if (flag !== "1" || env.ENABLE_STAGE7_HISTORY !== "1") throw new Error("MCP_CONFIG_INVALID");
  const resource = env.MCP_RESOURCE?.trim() ?? "";
  createMcpOAuthOptions({ resource, loginPage: "/", consentPage: "/mcp-consent" });
  const u = new URL(resource),
    port = Number(env.MCP_PORT ?? "3001");
  if (
    u.pathname !== "/mcp" ||
    !/^[0-9]+$/.test(env.MCP_PORT ?? "3001") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("MCP_CONFIG_INVALID");
  if (u.protocol === "http:" && u.port !== String(port)) throw new Error("MCP_CONFIG_INVALID");
  return {
    resource,
    host: u.protocol === "http:" && u.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port,
  };
}
export async function createMcpRuntime(input: {
  config: McpConfig;
  auth: AuthConfig;
  pools: { sdk: Pool; observation: Pool; storage: Pool };
  coordinator: ScopeCoordinator;
  reads: DelegatedRead;
  key: Buffer;
  audit: McpAudit;
  /** Internal composition only. The production entry point never enables it. */
  changeDraftsEnabled?: boolean;
}) {
  await verifyMcpSchema(input.pools.storage);
  if (input.changeDraftsEnabled === true) {
    const c = await input.pools.storage.getConnection();
    try {
      if (!(await bindingIdentitiesAvailable(c))) throw new Error("MCP_CHANGE_BINDING_UNVERIFIED");
    } finally {
      c.release();
    }
  }
  const options = createMcpOAuthOptions({
    resource: input.config.resource,
    loginPage: "/",
    consentPage: "/mcp-consent",
  });
  const disclosureSession = new AsyncLocalStorage<string | undefined>();
  const observe = mysqlMcpGrantObservation(
    input.pools.observation,
    async (c, owner, session, assertActive = () => {}) => {
      assertActive();
      const first = await authSessionReferenceDeadline(c, owner, session),
        extra = disclosureSession.getStore();
      assertActive();
      if (first === undefined || !extra || extra === session) return first;
      const second = await authSessionReferenceDeadline(c, owner, extra);
      assertActive();
      return second === undefined ? undefined : Math.min(first, second);
    },
  );
  const grantAuthority = createMcpGrantAuthority(
    observe,
    `${input.auth.origin}/api/auth`,
    input.config.resource,
  );
  const held = new AsyncLocalStorage<
    | ((
        grant: AuthorizedMcpGrant,
        assertActive: () => void,
        signal: AbortSignal,
        receipt?: HandoffReceipt,
      ) => Promise<void>)
    | undefined
  >();
  const authority: typeof grantAuthority = (token, initial, confirm) =>
    grantAuthority(token, initial, confirm, held.getStore());
  const provider = createMcpIdentityProvider(input.auth, input.pools.sdk, options, authority);
  await provider.$context;
  const store = new McpStore(input.pools.storage, authSessionReferenceDeadline);
  const oauth = new McpOAuthFlow(provider, store, input.auth.origin, input.config.resource);
  const withAuthorization = async <T>(
    headers: IncomingHttpHeaders,
    action: (
      grant: AuthorizedMcpGrant,
      assertActive: () => void,
      signal: AbortSignal,
      receipt?: HandoffReceipt,
    ) => Promise<T>,
    approvalSession?: string,
  ): Promise<T> => {
    let completed = false;
    let value: T | undefined;
    await disclosureSession.run(approvalSession, () =>
      held.run(
        async (grant, assertActive, signal, receipt) => {
          value = await held.run(undefined, () => action(grant, assertActive, signal, receipt));
          completed = true;
        },
        () => oauth.verify(headers),
      ),
    );
    if (!completed) throw new Error("MCP_AUTHORIZATION_UNAVAILABLE");
    return value as T;
  };
  const invocations = new McpInvocations(
    store,
    input.key,
    input.reads,
    input.coordinator,
    (headers) => oauth.verify(headers),
    input.auth.origin,
    withAuthorization,
    input.audit,
    () => pruneMcpIdentityMetadata(input.pools.sdk),
    input.changeDraftsEnabled === true,
  );
  try {
    await invocations.initialize();
    const server = await startMcpServer({
      ...input.config,
      authorize: (headers) => oauth.verify(headers),
      invocations,
      changeDraftsEnabled: input.changeDraftsEnabled === true,
      discovery: (r) => provider.handler(r),
    });
    let channel: Awaited<ReturnType<typeof startLocalChannel>>;
    try {
      channel = await startLocalChannel(
        input.config.resource,
        `${input.auth.origin}/api/auth`,
        async (req, res) => {
          // No arbitrary destination or proxy URL is accepted from a local caller.
          const paths: Record<string, string> = {
            "/_local/oauth-discovery": "/.well-known/oauth-authorization-server/api/auth",
            "/_local/openid-discovery": "/.well-known/openid-configuration/api/auth",
          };
          if (req.method === "GET" && req.url && paths[req.url]) {
            const response = await provider.handler(
              new Request(`${input.auth.origin}${paths[req.url]}`),
            );
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(await response.text());
            return;
          }
          if (req.method === "POST" && req.url === "/_local/token") {
            try {
              const parts: Buffer[] = [];
              let size = 0;
              for await (const part of req) {
                size += part.length;
                if (size > 8192) throw Error("MCP_INPUT_LIMIT");
                parts.push(Buffer.from(part));
              }
              const response = await oauth.token(Buffer.concat(parts, size).toString("utf8"));
              res.writeHead(response.status, Object.fromEntries(response.headers));
              res.end(await response.text());
            } catch {
              res.writeHead(400).end();
            }
            return;
          }
          req.headers.host = new URL(input.config.resource).host;
          await server.handle(req, res);
        },
      );
    } catch (error) {
      await server.close();
      throw error;
    }
    return {
      store,
      oauth,
      invocations,
      coordinator: input.coordinator,
      changeDraftsEnabled: input.changeDraftsEnabled === true,
      health: () => ({ observation: observe.health?.(), cleanup: invocations.cleanupHealth() }),
      close: async () => {
        try {
          invocations.close();
        } finally {
          try {
            await channel.close();
          } finally {
            await server.close();
            await invocations.settleCleanup();
          }
        }
      },
    };
  } catch (error) {
    invocations.close();
    throw error;
  }
}
