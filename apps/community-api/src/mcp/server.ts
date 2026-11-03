import {
  createServer,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { Admission, RateBudget, type VerifiedGrant } from "./admission.js";
import { AuthorizationWork } from "./authorization-work.js";
import { BoundaryError, boundedJson, limits } from "./input-limits.js";
import { RetainedPermit } from "./retained-permit.js";
import type { AuthorizedMcpGrant } from "./grant-authority.js";
import type { McpInvocations } from "./invocations.js";
import { McpError, queryInput, requestIdSchema, type McpTool } from "./model.js";
import { changeInput } from "./change-input.js";
import { randomUUID } from "node:crypto";
import { diagnostics } from "../logging/public.js";
import { ResponsePublication, type ToolResponse } from "./response-publication.js";

async function body(request: IncomingMessage) {
  if (request.headers["content-encoding"]) throw new BoundaryError(415, "MCP_ENCODING_REJECTED");
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new BoundaryError(415, "MCP_CONTENT_TYPE_REJECTED");
  if (Number(request.headers["content-length"] ?? 0) > limits.messageBytes)
    throw new BoundaryError(413, "MCP_INPUT_LIMIT");
  let size = 0;
  const chunks: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > limits.messageBytes) throw new BoundaryError(413, "MCP_INPUT_LIMIT");
          chunks.push(bytes);
        }
        return Buffer.concat(chunks, size);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BoundaryError(408, "MCP_BODY_TIMEOUT")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
/** SDK protocol mapping owns no database or global current-user identity. */
export async function startMcpServer(options: {
  resource: string;
  host: string;
  port: number;
  authorize: (headers: IncomingHttpHeaders) => Promise<AuthorizedMcpGrant>;
  invocations: McpInvocations;
  discovery: (request: Request) => Promise<Response>;
  changeDraftsEnabled?: boolean;
}) {
  const address = new URL(options.resource),
    authorization = new AuthorizationWork(),
    admission = new Admission();
  const discoveryBudget = new RateBudget(600, 32, undefined, 1),
    unauthenticated = new RateBudget(10, 2);
  let receiving = 0;
  const sdk = createMcpHandler(
    (context) => {
      const grant = context.authInfo?.extra?.grant;
      const retained = context.authInfo?.extra?.permit;
      const publication = context.authInfo?.extra?.publication;
      if (
        !grant ||
        typeof grant !== "object" ||
        !(retained instanceof RetainedPermit) ||
        !(publication instanceof ResponsePublication)
      )
        throw new McpError("MCP_UNAUTHENTICATED", 401);
      // The object was constructed by this request's verified closure, not JSON.
      const subject = grant as AuthorizedMcpGrant;
      const headers: IncomingHttpHeaders = {
        authorization: context.requestInfo?.headers.get("authorization") ?? undefined,
      };
      const execute = async (
        tool: McpTool,
        permission: string,
        run: (current: AuthorizedMcpGrant) => Promise<unknown>,
        operationId?: string,
      ) => {
        const release = retained.retain();
        const callId = randomUUID();
        try {
          const current = await authorization.run(() => options.authorize(headers));
          if (
            current.id !== subject.id ||
            current.generation !== subject.generation ||
            current.ownerId !== subject.ownerId ||
            current.clientId !== subject.clientId
          )
            throw new McpError("MCP_GRANT_CHANGED", 403);
          await options.invocations.current(current, permission);
          // An accepted tool request is durably recorded before business work,
          // including metadata, status/result disclosure and cancellation.
          await options.invocations.recordCall(current, tool, callId, operationId);
          const result = await run(current);
          const responseValue: ToolResponse = {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
          return await publication.send(() =>
            options.invocations.publish(
              current,
              headers,
              permission,
              operationId,
              async (assertActive, signal) => {
                publication.release(responseValue, assertActive, signal);
                await publication.finished;
              },
              tool,
              callId,
              result,
            ),
          );
        } catch (error) {
          diagnostics.error("mcp.request_failed", {}, error);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: error instanceof McpError ? error.code : "MCP_OPERATION_REJECTED",
              },
            ],
          };
        } finally {
          release();
        }
      };
      const server = new McpServer({ name: "shuriva", version: "0.1.0" });
      if (subject.scopes.includes("metadata:read")) {
        server.registerTool("workspaces_list", { inputSchema: z.strictObject({}) }, () =>
          execute("workspaces_list", "metadata:read", async (g) => ({
            workspaces: [{ id: (await options.invocations.current(g)).workspaceId }],
            recipient: await options.invocations.recipient(g),
          })),
        );
        server.registerTool("datasources_list", { inputSchema: z.strictObject({}) }, () =>
          execute("datasources_list", "metadata:read", async (g) => ({
            dataSources: [{ id: (await options.invocations.current(g)).sourceId }],
          })),
        );
        server.registerTool(
          "schema_get",
          {
            description:
              "Request fresh authorized schema; use operation_status with the returned id.",
            inputSchema: z.strictObject({ requestId: requestIdSchema }),
          },
          (args) =>
            execute(
              "schema_get",
              "metadata:read",
              (g) => options.invocations.schema(g, headers, args.requestId),
              args.requestId,
            ),
        );
      }
      if (subject.scopes.includes("query:prepare"))
        server.registerTool(
          "query_prepare",
          {
            description:
              "Prepare a read query for explicit human approval. No execution until approval.",
            inputSchema: queryInput,
          },
          (args) =>
            execute(
              "query_prepare",
              "query:prepare",
              (g) => options.invocations.prepare(g, headers, args),
              args.requestId,
            ),
        );
      if (options.changeDraftsEnabled === true && subject.scopes.includes("change:propose"))
        server.registerTool(
          "change_propose",
          {
            description:
              "Submit a change draft for an administrator, up to 24576 UTF-8 argument bytes and 1800 JSON value nodes. This cannot preview, approve, or execute a change.",
            inputSchema: changeInput,
          },
          (args) =>
            execute(
              "change_propose",
              "change:propose",
              (g) => options.invocations.prepareChange(g, headers, args),
              args.requestId,
            ),
        );
      if (subject.scopes.includes("operation:read") || subject.scopes.includes("metadata:read"))
        server.registerTool(
          "operation_status",
          { inputSchema: z.strictObject({ id: requestIdSchema }) },
          (args) =>
            execute(
              "operation_status",
              subject.scopes.includes("operation:read") ? "operation:read" : "metadata:read",
              (g) => options.invocations.status(g, args.id),
              args.id,
            ),
        );
      if (subject.scopes.includes("operation:cancel"))
        server.registerTool(
          "operation_cancel",
          { inputSchema: z.strictObject({ id: requestIdSchema }) },
          (args) =>
            execute(
              "operation_cancel",
              "operation:cancel",
              (g) => options.invocations.cancel(g, args.id),
              args.id,
            ),
        );
      return server;
    },
    { legacy: "reject", maxRequestBodySize: limits.messageBytes },
  );
  const sockets = new Set<import("node:net").Socket>();
  const headerTimers = new WeakMap<import("node:net").Socket, ReturnType<typeof setTimeout>>();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    clearTimeout(headerTimers.get(request.socket));
    response.shouldKeepAlive = false;
    response.setHeader("Connection", "close");
    response.setHeader("Cache-Control", "no-store");
    let permit: RetainedPermit | undefined,
      entered = false;
    try {
      // Source addresses are shared by all loopback clients. Never classify
      // a bearer as unauthenticated solely because its address had failures.
      if (receiving >= 32) throw new BoundaryError(429, "MCP_REQUEST_CAPACITY");
      receiving++;
      entered = true;
      if (
        request.headers.host !== address.host ||
        (request.headers.origin && ![address.origin].includes(request.headers.origin))
      )
        throw new BoundaryError(403, "MCP_ORIGIN_REJECTED");
      if (
        request.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].includes(request.url ?? "")
      ) {
        discoveryBudget.take("public-discovery");
        const result = await options.discovery(new Request(`${address.origin}${request.url}`));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
        return;
      }
      if (request.method !== "POST" || request.url !== address.pathname)
        throw new BoundaryError(405, "MCP_METHOD_REJECTED");
      let subject: AuthorizedMcpGrant;
      try {
        subject = await authorization.run(() => options.authorize(request.headers));
      } catch {
        unauthenticated.take(request.socket.remoteAddress ?? "unknown");
        response.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${address.origin}/.well-known/oauth-protected-resource/mcp"`,
        );
        throw new BoundaryError(401, "MCP_UNAUTHENTICATED");
      }
      const verified: VerifiedGrant = {
        ...subject,
        sessionId: subject.approvalSessionId,
        familyId: subject.id,
        recipient: subject.clientId,
        token: "",
      };
      permit = new RetainedPermit(admission.enter(verified));
      const parsed = boundedJson(await body(request));
      const final = await authorization.run(() => options.authorize(request.headers));
      if (final.id !== subject.id || final.generation !== subject.generation)
        throw new BoundaryError(401, "MCP_GRANT_CHANGED");
      const ownedPermit = permit;
      const publication = new ResponsePublication(response);
      await toNodeHandler({
        fetch: async (web, context) =>
          publication.prepare(
            await sdk.fetch(web, {
              ...context,
              authInfo: {
                token: "",
                clientId: subject.clientId,
                scopes: [...subject.scopes],
                extra: { grant: subject, permit: ownedPermit, publication },
              },
            }),
          ),
      })(request, response, parsed);
    } catch (error) {
      const status =
        error instanceof BoundaryError
          ? error.status
          : error instanceof McpError
            ? error.status
            : 503;
      const code =
        error instanceof BoundaryError || error instanceof McpError
          ? error.code
          : "MCP_UNAVAILABLE";
      if (!response.headersSent) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: code }));
      } else response.destroy();
    } finally {
      permit?.closeResponse();
      if (entered) receiving--;
    }
  };
  const server = createServer(
    {
      maxHeaderSize: limits.headerBytes,
      headersTimeout: 5000,
      requestTimeout: 10000,
      connectionsCheckingInterval: 50,
      keepAliveTimeout: 1,
    },
    handle,
  );
  // One request per socket makes the accepted-connection header deadline apply
  // to every request, including clients that try to reuse a connection.
  server.maxRequestsPerSocket = 1;
  server.on("connection", (socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 5000);
    timer.unref();
    headerTimers.set(socket, timer);
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    handle,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
