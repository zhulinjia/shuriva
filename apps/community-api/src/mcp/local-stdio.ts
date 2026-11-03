import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { BoundedStdioInput } from "./stdio-boundary.js";
import { changeInput } from "./change-input.js";
import { queryInput, requestIdSchema } from "./model.js";
import { localFetch, type localCredential } from "./local-vault.js";

/** Local stdio is a transport adapter for an explicitly approved user trust
 * domain; it never creates an administrator identity or connects a database. */
export async function startLocalStdio(
  credential: z.infer<typeof localCredential>,
  input: Readable,
  output: Writable,
) {
  const remote = new Client(
    { name: "shuriva-local-domain", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(credential.resource), {
    requestInit: { headers: { authorization: `Bearer ${credential.token}` }, redirect: "error" },
    redirectPolicy: "same-origin",
    fetch: localFetch(credential.resource),
  });
  const framed = new BoundedStdioInput();
  let close: () => Promise<void> = async () => {
    await remote.close();
    framed.destroy();
  };
  try {
    await remote.connect(transport);
    const scope = await remote.callTool({ name: "workspaces_list", arguments: {} });
    const first = Array.isArray(scope.content) ? scope.content[0] : undefined;
    if (first?.type !== "text" || typeof first.text !== "string")
      throw Error("MCP_LOCAL_DOMAIN_REQUIRED");
    const described: unknown = JSON.parse(first.text);
    if (
      !described ||
      typeof described !== "object" ||
      !("recipient" in described) ||
      !described.recipient ||
      typeof described.recipient !== "object" ||
      !("mode" in described.recipient) ||
      described.recipient.mode !== "local_domain" ||
      !("clientId" in described.recipient) ||
      described.recipient.clientId !== credential.clientId
    )
      throw Error("MCP_LOCAL_DOMAIN_REQUIRED");
    const discovery = await remote.listTools();
    const allowed = new Set(discovery.tools.map((t) => t.name));
    const schemas = {
      workspaces_list: z.strictObject({}),
      datasources_list: z.strictObject({}),
      schema_get: z.strictObject({ requestId: requestIdSchema }),
      query_prepare: queryInput,
      change_propose: changeInput,
      operation_status: z.strictObject({ id: requestIdSchema }),
      operation_cancel: z.strictObject({ id: requestIdSchema }),
    };
    if (
      discovery.tools.length > Object.keys(schemas).length ||
      discovery.tools.some((t) => !Object.hasOwn(schemas, t.name))
    )
      throw Error("MCP_LOCAL_TOOLS_REJECTED");
    let pending = 0;
    const server = serveStdio(
      () => {
        const sdk = new McpServer({ name: "shuriva-local-domain", version: "0.1.0" });
        for (const [name, schema] of Object.entries(schemas))
          if (allowed.has(name))
            sdk.registerTool(
              name,
              { inputSchema: schema },
              async (args: Record<string, unknown>) => {
                if (pending >= 4 || credential.expiresAt <= Date.now())
                  return {
                    isError: true,
                    content: [{ type: "text" as const, text: "MCP_LOCAL_UNAVAILABLE" }],
                  };
                pending++;
                try {
                  // The remote Server applies the domain-wide rate and authority budget
                  // again on every call, including retained transports after revocation.
                  const result = await remote.callTool({ name, arguments: args });
                  const content = z
                    .array(
                      z.strictObject({ type: z.literal("text"), text: z.string().max(1500000) }),
                    )
                    .max(4)
                    .parse(result.content);
                  return { isError: result.isError === true, content };
                } catch {
                  return {
                    isError: true,
                    content: [{ type: "text" as const, text: "MCP_LOCAL_CALL_REJECTED" }],
                  };
                } finally {
                  pending--;
                }
              },
            );
        return sdk;
      },
      {
        transport: new StdioServerTransport(framed, output, { maxBufferSize: 65536 }),
        legacy: "reject",
        onerror: () => {
          void close();
        },
      },
    );
    close = async () => {
      framed.destroy();
      await server.close();
      await remote.close();
    };
    framed.once("error", () => {
      void close();
    });
    input.once("end", () => {
      void close();
    });
    input.pipe(framed);
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
