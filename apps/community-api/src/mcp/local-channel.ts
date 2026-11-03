import { createHash } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import type { RequestListener } from "node:http";
import { Entry } from "@napi-rs/keyring";
import { generate } from "selfsigned";
import { z } from "zod";

const descriptor = z.strictObject({
  port: z.number().int().min(1).max(65535),
  cert: z.string().min(100).max(16384),
  resource: z.string().url(),
  issuer: z.string().url(),
});
function channelEntry(resource: string) {
  return new Entry(
    "shuriva-mcp-local-channel",
    createHash("sha256").update(resource).digest("hex"),
    {
      linux: { store: "secret-service" },
    },
  );
}
/** Trust bootstrap uses the current OS user's credential store, never a network
 * discovery response. Other OS users cannot impersonate this ephemeral listener. */
export async function startLocalChannel(resource: string, issuer: string, handle: RequestListener) {
  const pems = await generate([{ name: "commonName", value: "127.0.0.1" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      { name: "extKeyUsage", serverAuth: true },
    ],
  });
  const headerTimers = new WeakMap<import("node:stream").Duplex, ReturnType<typeof setTimeout>>();
  const server = createServer(
    {
      key: pems.private,
      cert: pems.cert,
      minVersion: "TLSv1.3",
      maxHeaderSize: 8192,
      handshakeTimeout: 5000,
      headersTimeout: 5000,
      requestTimeout: 10000,
    },
    (req, res) => {
      clearTimeout(headerTimers.get(req.socket));
      res.setHeader("Cache-Control", "no-store");
      Promise.resolve(handle(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(503).end();
        else res.destroy();
      });
    },
  );
  const sockets = new Set<import("node:stream").Duplex>();
  server.maxRequestsPerSocket = 1;
  server.on("connection", (socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 20000);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  server.on("secureConnection", (socket) => {
    const headerTimer = setTimeout(() => socket.destroy(), 5000);
    headerTimer.unref();
    headerTimers.set(socket, headerTimer);
    socket.once("close", () => clearTimeout(headerTimer));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("MCP_LOCAL_CHANNEL_UNAVAILABLE");
  const entry = channelEntry(resource),
    value = JSON.stringify({ port: addr.port, cert: pems.cert, resource, issuer });
  try {
    entry.setPassword(value);
    if (entry.getPassword() !== value) throw Error("MCP_LOCAL_CHANNEL_UNAVAILABLE");
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (entry.getPassword() === value) entry.deletePassword();
    },
  };
}
export function trustedLocalFetch(
  resource: string,
  maximumBytes = 6 * 1048576 + 65536,
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init),
      raw = channelEntry(resource).getPassword();
    if (!raw) throw Error("MCP_LOCAL_CHANNEL_REQUIRED");
    const target = descriptor.parse(JSON.parse(raw));
    if (target.resource !== resource) throw Error("MCP_LOCAL_TARGET_REJECTED");
    const paths = new Map([
      [resource, "/mcp"],
      [
        `${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp`,
        "/.well-known/oauth-protected-resource/mcp",
      ],
      [
        `${new URL(resource).origin}/.well-known/oauth-protected-resource`,
        "/.well-known/oauth-protected-resource",
      ],
      [
        `${new URL(target.issuer).origin}/.well-known/oauth-authorization-server/api/auth`,
        "/_local/oauth-discovery",
      ],
      [
        `${new URL(target.issuer).origin}/.well-known/openid-configuration/api/auth`,
        "/_local/openid-discovery",
      ],
      [`${target.issuer}/oauth2/token`, "/_local/token"],
    ]);
    const path = paths.get(req.url);
    if (!path || !["GET", "POST", "DELETE"].includes(req.method))
      throw Error("MCP_LOCAL_TARGET_REJECTED");
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length > 65536) throw Error("MCP_LOCAL_INPUT_TOO_LARGE");
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15000)]);
    return new Promise<Response>((resolve, reject) => {
      // Node validates both the pinned certificate chain and the IP SAN before
      // the HTTP request (including its bearer) can be written on this socket.
      const wire = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: target.port,
          path,
          method: req.method,
          ca: target.cert,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          agent: false,
          signal,
          headers: {
            ...Object.fromEntries(req.headers),
            host: `127.0.0.1:${target.port}`,
            "content-length": String(bytes.length),
          },
        },
        (res) => {
          const parts: Buffer[] = [];
          let size = 0;
          res.on("data", (part: Buffer) => {
            size += part.length;
            if (size > maximumBytes) {
              res.destroy(Error("MCP_LOCAL_RESULT_TOO_LARGE"));
              return;
            }
            parts.push(part);
          });
          res.once("error", reject);
          res.once("end", () => {
            const status = res.statusCode ?? 503;
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value !== undefined)
                for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
            resolve(
              new Response([204, 205, 304].includes(status) ? null : Buffer.concat(parts, size), {
                status,
                headers,
              }),
            );
          });
        },
      );
      wire.once("error", reject);
      wire.end(bytes);
    });
  };
}
