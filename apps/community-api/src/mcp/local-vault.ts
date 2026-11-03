import { Entry } from "@napi-rs/keyring";
import { z } from "zod";
import { trustedLocalFetch } from "./local-channel.js";

export const localCredential = z.strictObject({
  token: z.string().min(1).max(4096),
  resource: z.string().url(),
  clientId: z.string().min(1).max(255),
  expiresAt: z.number().int().positive(),
});
export function localAddress(raw: string, pathname: string) {
  const u = new URL(raw);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.pathname !== pathname ||
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    u.href !== raw
  )
    throw Error("MCP_LOCAL_ADDRESS_REJECTED");
  return u;
}
export function localEntry(reference: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reference))
    throw Error("MCP_LOCAL_REFERENCE_INVALID");
  return new Entry("shuriva-mcp-local-domain", reference, { linux: { store: "secret-service" } });
}
export function loadLocalCredential(reference: string) {
  const raw = localEntry(reference).getPassword();
  if (!raw) throw Error("MCP_LOCAL_LOGIN_REQUIRED");
  const value = localCredential.parse(JSON.parse(raw));
  localAddress(value.resource, "/mcp");
  if (value.expiresAt <= Date.now()) throw Error("MCP_LOCAL_LOGIN_EXPIRED");
  return value;
}
/** Pin every SDK request to the exact loopback resource. No OAuth auto-fetch,
 * redirects, SSE reconnection or other destinations may inherit the bearer. */
export function localFetch(resource: string): typeof fetch {
  localAddress(resource, "/mcp");
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== resource || !["POST", "DELETE"].includes(request.method))
      throw Error("MCP_LOCAL_TARGET_REJECTED");
    const response = await trustedLocalFetch(resource)(
      new Request(request, {
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      }),
    );
    if (!response.body) return response;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        // JSON text embedded in JSON-RPC may expand every byte to a six-byte escape.
        if (size > 6 * 1048576 + 65536) throw Error("MCP_LOCAL_RESULT_TOO_LARGE");
        parts.push(chunk.value);
      }
      return new Response(Buffer.concat(parts, size), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      void reader.cancel().catch(() => {});
    }
  };
}
