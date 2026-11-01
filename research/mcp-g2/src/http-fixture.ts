import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Admission, RateBudget, type VerifiedGrant } from "./admission.js";
import { AuthorizationWork } from "./authorization-work.js";
import { BoundaryError, boundedJson, limits } from "./limits.js";
import { listenLoopback } from "./loopback-listener.js";
import { RetainedPermit } from "./retained-permit.js";

type Authorize = (
  request: {
    readonly headers: Readonly<IncomingHttpHeaders>;
  },
  signal: AbortSignal,
) => Promise<VerifiedGrant>;

async function readBody(request: IncomingMessage, timeoutMs: number): Promise<Buffer> {
  if (request.headers["content-encoding"]) throw new BoundaryError(415, "MCP_ENCODING_REJECTED");
  if (Number(request.headers["content-length"] ?? 0) > limits.messageBytes)
    throw new BoundaryError(413, "MCP_INPUT_LIMIT");
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundaryError(408, "MCP_BODY_TIMEOUT")), timeoutMs);
  });
  try {
    const body = (async () => {
      for await (const chunk of request) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += part.length;
        if (bytes > limits.messageBytes) throw new BoundaryError(413, "MCP_INPUT_LIMIT");
        chunks.push(part);
      }
      return Buffer.concat(chunks, bytes);
    })();
    return await Promise.race([body, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real SDK transport plus a synthetic scope tool. It never dispatches SQL. */
export async function httpFixture(
  authorize: Authorize,
  options: {
    timeoutMs?: number;
    clock?: () => number;
    onDispatch?: () => void;
    onTool?: (signal: AbortSignal) => Promise<void>;
    legacy?: "reject" | "stateless";
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const authWork = new AuthorizationWork(timeoutMs);
  const admission = new Admission(options.clock);
  const unauthenticated = new RateBudget(10, 2, options.clock);
  const arrivals = new RateBudget(600, 32, options.clock, 1);
  let receiving = 0;
  let url = "";
  let factories = 0;
  const sdk = createMcpHandler(
    (context) => {
      factories++;
      const subject = context.authInfo;
      if (!subject) throw new BoundaryError(401, "MCP_UNAUTHORIZED");
      const permit = subject.extra?.executionPermit;
      if (!(permit instanceof RetainedPermit)) throw new BoundaryError(401, "MCP_UNAUTHORIZED");
      const execute = async <T>(work: () => Promise<T>): Promise<T> => {
        const finish = permit.retain();
        try {
          return await work();
        } finally {
          finish();
        }
      };
      const recheck = async () => {
        const info = context.requestInfo;
        if (!info) throw new BoundaryError(401, "MCP_UNAUTHORIZED");
        let fresh: VerifiedGrant;
        try {
          fresh = await authWork.run(
            (signal) => authorize({ headers: Object.fromEntries(info.headers) }, signal),
            info.signal,
          );
        } catch (error) {
          if (error instanceof BoundaryError) throw error;
          throw new BoundaryError(401, "MCP_UNAUTHORIZED");
        }
        if (
          fresh.clientId !== subject.clientId ||
          fresh.id !== subject.extra?.grantId ||
          fresh.generation !== subject.extra?.generation ||
          fresh.ownerId !== subject.extra?.ownerId ||
          fresh.sessionId !== subject.extra?.sessionId ||
          fresh.familyId !== subject.extra?.familyId ||
          fresh.recipient !== subject.extra?.recipient ||
          JSON.stringify([...fresh.scopes].sort()) !== JSON.stringify([...subject.scopes].sort())
        )
          throw new BoundaryError(401, "MCP_GRANT_CHANGED");
      };
      const server = new McpServer({ name: "g2-isolated-scope-fixture", version: "0.0.0" });
      server.registerTool("read_scope", { inputSchema: z.object({}) }, () =>
        execute(async () => {
          await recheck();
          if (!subject.scopes.includes("metadata:read"))
            throw new BoundaryError(403, "MCP_SCOPE_REJECTED");
          options.onDispatch?.();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  clientId: subject.clientId,
                  scopes: subject.scopes,
                  recipient: subject.extra?.recipient,
                }),
              },
            ],
          };
        }),
      );
      server.registerTool("hold", { inputSchema: z.object({}) }, (_args, context) =>
        execute(async () => {
          await recheck();
          try {
            await options.onTool?.(context.mcpReq.signal);
          } catch {
            throw new BoundaryError(502, "MCP_TOOL_UNAVAILABLE");
          }
          await recheck();
          return { content: [{ type: "text", text: "finished" }] };
        }),
      );
      return server;
    },
    { legacy: options.legacy ?? "reject", maxRequestBodySize: limits.messageBytes },
  );
  const headerTimers = new WeakMap<import("node:net").Socket, ReturnType<typeof setTimeout>>();
  const server = createServer(
    {
      maxHeaderSize: limits.headerBytes,
      headersTimeout: timeoutMs,
      requestTimeout: timeoutMs * 2,
      connectionsCheckingInterval: 20,
      keepAliveTimeout: timeoutMs,
    },
    async (request, response) => {
      clearTimeout(headerTimers.get(request.socket));
      let permit: RetainedPermit | undefined;
      let admitted = false;
      const disconnected = new AbortController();
      const abortRequest = () => disconnected.abort();
      const closeResponse = () => {
        if (!response.writableFinished) disconnected.abort();
      };
      request.once("aborted", abortRequest);
      response.once("close", closeResponse);
      try {
        arrivals.take("process");
        if (receiving >= 32) throw new BoundaryError(429, "MCP_REQUEST_CAPACITY");
        receiving++;
        admitted = true;
        if (
          request.headers.host !== new URL(url).host ||
          (request.headers.origin && request.headers.origin !== new URL(url).origin)
        )
          throw new BoundaryError(403, "MCP_ORIGIN_REJECTED");
        if (request.url !== "/mcp" || request.method !== "POST")
          throw new BoundaryError(405, "MCP_METHOD_REJECTED");
        let grant: VerifiedGrant;
        try {
          const value = await authWork.run(
            (signal) => authorize(request, signal),
            disconnected.signal,
          );
          grant = Object.freeze({ ...value, scopes: Object.freeze([...value.scopes]) });
        } catch (error) {
          if (error instanceof BoundaryError && [408, 503].includes(error.status)) throw error;
          unauthenticated.take(request.socket.remoteAddress ?? "unknown");
          throw new BoundaryError(401, "MCP_UNAUTHORIZED");
        }
        permit = new RetainedPermit(admission.enter(grant));
        const body = boundedJson(await readBody(request, timeoutMs));
        let current: VerifiedGrant;
        try {
          current = await authWork.run((signal) => authorize(request, signal), disconnected.signal);
        } catch (error) {
          if (error instanceof BoundaryError) throw error;
          throw new BoundaryError(401, "MCP_UNAUTHORIZED");
        }
        if (
          current.id !== grant.id ||
          current.generation !== grant.generation ||
          current.sessionId !== grant.sessionId
        )
          throw new BoundaryError(401, "MCP_GRANT_CHANGED");
        // This closure belongs to one immutable principal; no global currentActor.
        await toNodeHandler({
          fetch: (web, supplied) =>
            sdk.fetch(web, {
              ...supplied,
              authInfo: {
                token: grant.token,
                clientId: grant.clientId,
                scopes: [...grant.scopes],
                extra: {
                  recipient: grant.recipient,
                  generation: grant.generation,
                  grantId: grant.id,
                  ownerId: grant.ownerId,
                  sessionId: grant.sessionId,
                  familyId: grant.familyId,
                  executionPermit: permit,
                },
              },
            }),
        })(request, response, body);
      } catch (error) {
        const failure =
          error instanceof BoundaryError ? error : new BoundaryError(500, "MCP_UNAVAILABLE");
        if (!response.headersSent) {
          response.writeHead(failure.status, {
            "content-type": "application/json",
            connection: "close",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ error: failure.code }));
        } else response.destroy();
      } finally {
        permit?.closeResponse();
        if (admitted) receiving--;
        request.removeListener("aborted", abortRequest);
        response.removeListener("close", closeResponse);
      }
    },
  );
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    headerTimers.set(socket, timer);
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  const port = await listenLoopback(server);
  url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    factories: () => factories,
    outstandingAuthorization: () => authWork.outstanding,
    receivingRequests: () => receiving,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
