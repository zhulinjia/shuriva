import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { createParser } from "eventsource-parser";
import { publicModelAddress } from "../ai/public.js";
import { decodeJson } from "./limits.js";
import { ExternalMcpError, safeUrl } from "./model.js";
export type Address = { address: string; family: number };
export type NetworkPolicy = {
  destinations: string[];
  privateApprovals: Array<{ origin: string; addresses: string[] }>;
  blockedOrigins: string[];
  controlPorts: number[];
  credentialDestinations: string[];
};
function eligiblePrivate(ip: string) {
  if (ip === "::1") return true;
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31)
  );
}
export function loopbackAddress(ip: string) {
  return ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
}
export function validateDestination(raw: string, policy: NetworkPolicy, addresses: Address[]) {
  const local = new Set(
    Object.values(networkInterfaces()).flatMap((items) => items?.map((item) => item.address) ?? []),
  );
  const url = safeUrl(raw);
  if (!policy.destinations.includes(url.href) || policy.blockedOrigins.includes(url.origin))
    throw new ExternalMcpError("EXTERNAL_MCP_DESTINATION_REJECTED", 403);
  if (!addresses.length || addresses.length > 16)
    throw new ExternalMcpError("EXTERNAL_MCP_ADDRESS_REJECTED", 403);
  const approval = policy.privateApprovals.find((a) => a.origin === url.origin),
    privateMode = !!approval;
  if (
    url.protocol === "http:" &&
    (!privateMode || addresses.some((a) => !loopbackAddress(a.address)))
  )
    throw new ExternalMcpError("EXTERNAL_MCP_HTTPS_REQUIRED", 403);
  for (const a of addresses) {
    if (
      !isIP(a.address) ||
      isIP(a.address) !== a.family ||
      ((loopbackAddress(a.address) || local.has(a.address)) &&
        policy.controlPorts.includes(Number(url.port || (url.protocol === "https:" ? 443 : 80))))
    )
      throw new ExternalMcpError("EXTERNAL_MCP_CONTROL_PLANE_REJECTED", 403);
    if (
      approval
        ? !eligiblePrivate(a.address) || !approval.addresses.includes(a.address)
        : !publicModelAddress(a.address, a.family)
    )
      throw new ExternalMcpError("EXTERNAL_MCP_ADDRESS_REJECTED", 403);
  }
  return url;
}
type SendGuard = (send: (check: () => void, signal: AbortSignal) => Promise<void>) => Promise<void>;
export async function abortableAddresses(dns: Promise<Address[]>, signal: AbortSignal) {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  try {
    return await Promise.race([
      dns,
      new Promise<never>((_r, no) => {
        stop = () => no(new ExternalMcpError("EXTERNAL_MCP_CANCELLED"));
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
/** Native HTTP owns DNS pinning/TLS/bytes; official SDK owns OAuth and RPC.
 * No proxy environment, redirects, cookies or ambient credentials. */
export function clientFetch(
  policy: NetworkPolicy,
  guard: SendGuard,
  abort: AbortSignal,
  resolveHost: (host: string) => Promise<Address[]> = (h) =>
    lookup(h, { all: true, verbatim: true }),
  onHandoff: () => void = () => {},
): typeof fetch {
  let physical = 0;
  return async (input, init) => {
    if (physical >= 4) throw new ExternalMcpError("EXTERNAL_MCP_NETWORK_CAPACITY", 429);
    physical++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        physical--;
      }
    };
    try {
      const u = safeUrl(input instanceof Request ? input.url : input.toString()),
        host = u.hostname.replace(/^\[|\]$/g, "");
      if (!policy.destinations.includes(u.href) || policy.blockedOrigins.includes(u.origin))
        throw new ExternalMcpError("EXTERNAL_MCP_DESTINATION_REJECTED", 403);
      const signal = AbortSignal.any([abort, init?.signal ?? new AbortController().signal]);
      signal.throwIfAborted();
      const dns = isIP(host)
        ? Promise.resolve([{ address: host, family: isIP(host) }])
        : resolveHost(host);
      const addresses = await new Promise<Address[]>((yes, no) => {
        const stop = () => no(new ExternalMcpError("EXTERNAL_MCP_CANCELLED"));
        signal.addEventListener("abort", stop, { once: true });
        void dns.then(yes, no).finally(() => signal.removeEventListener("abort", stop));
        if (signal.aborted) stop();
      });
      const url = validateDestination(u.href, policy, addresses),
        target = addresses[0];
      if (!target) throw new ExternalMcpError("EXTERNAL_MCP_ADDRESS_REJECTED");
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((v, k) => {
        headers.set(k, v);
      });
      const standard = new Set([
        "accept",
        "content-type",
        "mcp-protocol-version",
        "mcp-session-id",
        "mcp-method",
        "mcp-name",
        "last-event-id",
      ]);
      for (const [key, value] of headers) {
        if (
          value.length > 4096 ||
          ["cookie", "host", "proxy-authorization"].includes(key) ||
          (!standard.has(key) &&
            (!["authorization", "x-api-key"].includes(key) ||
              !policy.credentialDestinations.includes(url.href)))
        )
          throw new ExternalMcpError("EXTERNAL_MCP_CREDENTIAL_DESTINATION_REJECTED", 403);
      }
      if (input instanceof Request && input.body)
        throw new ExternalMcpError("EXTERNAL_MCP_BODY_REJECTED");
      if (
        init?.body != null &&
        typeof init.body !== "string" &&
        !(init.body instanceof URLSearchParams)
      )
        throw new ExternalMcpError("EXTERNAL_MCP_BODY_REJECTED");
      const body = init?.body?.toString();
      if (body && Buffer.byteLength(body) > 65536)
        throw new ExternalMcpError("EXTERNAL_MCP_SIZE_LIMIT", 413);
      let request: ReturnType<typeof httpRequest> | undefined;
      let response: Promise<Response> | undefined;
      await guard(async (check, leaseSignal) => {
        check();
        leaseSignal.throwIfAborted();
        const lost = () => request?.destroy(new ExternalMcpError("EXTERNAL_MCP_AUTH_EXPIRED", 403));
        leaseSignal.addEventListener("abort", lost, { once: true });
        try {
          signal.throwIfAborted();
          response = new Promise<Response>((yes, no) => {
            const send = url.protocol === "https:" ? httpsRequest : httpRequest;
            request = send(
              url,
              {
                method: init?.method ?? (input instanceof Request ? input.method : "GET"),
                headers: Object.fromEntries(headers),
                agent: false,
                maxHeaderSize: 8192,
                signal,
                lookup: (_h, _o, done) => done(null, target.address, target.family),
                family: target.family,
              },
              (res) => {
                const status = res.statusCode ?? 502;
                if ((status >= 300 && status < 400) || res.headers["content-encoding"]) {
                  res.destroy();
                  no(new ExternalMcpError("EXTERNAL_MCP_REDIRECT_OR_ENCODING_REJECTED", 403));
                  return;
                }
                const out = new Headers();
                for (const [k, v] of Object.entries(res.headers))
                  if (v !== undefined && !["set-cookie"].includes(k))
                    out.set(k, Array.isArray(v) ? v.join(", ") : v);
                if ([204, 205, 304].includes(status)) {
                  res.resume();
                  res.once("end", release);
                  yes(new Response(null, { status, headers: out }));
                  return;
                }
                const sse =
                  (res.headers["content-type"] ?? "").split(";")[0]?.trim() === "text/event-stream";
                let bytes = 0,
                  ended = false,
                  frameBytes = 0,
                  lineStart = true,
                  previousCR = false,
                  timer: ReturnType<typeof setTimeout> | undefined;
                const clear = () => {
                  if (timer) clearTimeout(timer);
                  timer = undefined;
                };
                const raw: Buffer[] = [];
                const stream = new ReadableStream<Uint8Array>({
                  start(controller) {
                    const fail = (error: unknown) => {
                      if (ended) return;
                      ended = true;
                      clear();
                      controller.error(error);
                      res.destroy();
                      release();
                    };
                    const parser = sse
                      ? createParser({
                          maxBufferSize: 1048576,
                          onError: () => {
                            throw new ExternalMcpError("EXTERNAL_MCP_SSE_REJECTED");
                          },
                          onEvent: (event) => {
                            if (
                              (event.event && event.event !== "message") ||
                              (event.id && event.id.length > 128)
                            )
                              throw new ExternalMcpError("EXTERNAL_MCP_SSE_REJECTED");
                            decodeJson(Buffer.from(event.data));
                            controller.enqueue(
                              Buffer.from(
                                `${event.id ? `id: ${event.id}\n` : ""}data: ${event.data.replaceAll("\n", "\ndata: ")}\n\n`,
                              ),
                            );
                          },
                        })
                      : undefined;
                    const decoder = new TextDecoder("utf-8", { fatal: true });
                    res.on("data", (chunk: Buffer) => {
                      try {
                        bytes += chunk.length;
                        if (bytes > (sse ? 4194304 : 1048576))
                          throw new ExternalMcpError("EXTERNAL_MCP_SIZE_LIMIT", 413);
                        if (!sse) {
                          raw.push(chunk);
                          return;
                        }
                        for (const b of chunk) {
                          if (b === 10 && previousCR) {
                            previousCR = false;
                            continue;
                          }
                          if (++frameBytes > 1048576)
                            throw new ExternalMcpError("EXTERNAL_MCP_SIZE_LIMIT", 413);
                          if (b === 10 || b === 13) {
                            if (lineStart) {
                              frameBytes = 0;
                              clear();
                            }
                            lineStart = true;
                            previousCR = b === 13;
                          } else {
                            lineStart = false;
                            previousCR = false;
                          }
                          if (frameBytes && !timer)
                            timer = setTimeout(
                              () => fail(new ExternalMcpError("EXTERNAL_MCP_FRAME_TIMEOUT")),
                              5000,
                            );
                        }
                        parser?.feed(decoder.decode(chunk, { stream: true }));
                        if ((controller.desiredSize ?? 0) <= 0) res.pause();
                      } catch (error) {
                        fail(error);
                      }
                    });
                    res.once("end", () => {
                      if (ended) return;
                      try {
                        if (sse) {
                          parser?.feed(decoder.decode());
                          if (frameBytes)
                            throw new ExternalMcpError("EXTERNAL_MCP_INCOMPLETE_FRAME");
                        } else {
                          const data = Buffer.concat(raw, bytes);
                          decodeJson(data);
                          controller.enqueue(data);
                        }
                        ended = true;
                        clear();
                        controller.close();
                        release();
                      } catch (error) {
                        fail(error);
                      }
                    });
                    res.once("error", () =>
                      fail(new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502)),
                    );
                    res.once("aborted", () =>
                      fail(new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502)),
                    );
                  },
                  pull() {
                    res.resume();
                  },
                  cancel() {
                    ended = true;
                    clear();
                    res.destroy();
                    release();
                  },
                });
                yes(new Response(stream, { status, headers: out }));
              },
            );
            request.once("error", () => {
              release();
              no(new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502));
            });
          });
          void response.catch(() => {});
          await new Promise<void>((yes, no) => {
            if (!request) return no(new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED"));
            request.once("finish", yes);
            request.once("error", no);
            signal.throwIfAborted();
            check();
            leaseSignal.throwIfAborted();
            onHandoff();
            request.end(body);
          });
          check();
          leaseSignal.throwIfAborted();
        } finally {
          leaseSignal.removeEventListener("abort", lost);
        }
      }).catch((error) => {
        request?.destroy();
        throw error;
      });
      if (!response) throw new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED");
      return await response;
    } catch (error) {
      release();
      throw error;
    }
  };
}
