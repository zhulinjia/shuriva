import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const forbidden4 = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  forbidden4.addSubnet(ip, bits, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const forbidden6 = new BlockList();
forbidden6.addSubnet("2001:db8::", 32, "ipv6");
forbidden6.addSubnet("2001::", 23, "ipv6");
forbidden6.addSubnet("2002::", 16, "ipv6");
forbidden6.addSubnet("3fff::", 20, "ipv6");

export function publicModelAddress(address: string, family: number): boolean {
  if (family === 4) return isIP(address) === 4 && !forbidden4.check(address, "ipv4");
  return (
    family === 6 &&
    isIP(address) === 6 &&
    global6.check(address, "ipv6") &&
    !forbidden6.check(address, "ipv6")
  );
}

/** Only explicitly local HTTP endpoints or public HTTPS destinations are accepted. */
export function modelEndpoint(raw: string): URL {
  if (raw.length > 2048) throw new Error("INVALID_ENDPOINT");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("INVALID_ENDPOINT");
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(url.pathname) ||
    url.pathname.split("/").some((part) => part === "." || part === "..") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    (isIP(host.replace(/^\[|\]$/g, "")) !== 0 && !local)
  )
    throw new Error("INVALID_ENDPOINT");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url;
}

/** Bound SDK calls to the reviewed URL, resolved address and response size. */
export function modelFetch(
  baseUrl: string,
  apiKey: string,
  resolveHost: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) =>
    lookup(host, { all: true, verbatim: true }),
  onRequestSent?: () => void,
  beforeRequest?: () => void | Promise<void>,
): typeof globalThis.fetch {
  const endpoint = modelEndpoint(baseUrl);
  let used = false;
  return async (input, init) => {
    if (used) throw new Error("MODEL_UNAVAILABLE");
    if (typeof input !== "string" && !(input instanceof URL)) throw new Error("INVALID_ENDPOINT");
    if (new URL(input).href !== endpoint.href) throw new Error("INVALID_ENDPOINT");
    if (init?.method !== "POST" || typeof init.body !== "string")
      throw new Error("INVALID_MODEL_REQUEST");
    if (Buffer.byteLength(init.body) > 128 * 1024) throw new Error("INVALID_MODEL_REQUEST");
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${apiKey}`)
      throw new Error("INVALID_MODEL_REQUEST");
    const host = endpoint.hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    const deadline = AbortSignal.timeout(30_000);
    const combined = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    if (combined.aborted) throw new Error("MODEL_UNAVAILABLE");
    const records = local
      ? [{ address: host === "[::1]" ? "::1" : "127.0.0.1", family: host === "[::1]" ? 6 : 4 }]
      : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
          const abort = () => reject(new Error("MODEL_UNAVAILABLE"));
          combined.addEventListener("abort", abort, { once: true });
          void resolveHost(host)
            .then(resolve, () => reject(new Error("MODEL_UNAVAILABLE")))
            .finally(() => combined.removeEventListener("abort", abort));
        });
    if (
      !records.length ||
      (!local && records.some((item) => !publicModelAddress(item.address, item.family)))
    )
      throw new Error("INVALID_ENDPOINT");
    const target = records[0];
    if (!target) throw new Error("INVALID_ENDPOINT");
    if (combined.aborted) throw new Error("MODEL_UNAVAILABLE");
    await beforeRequest?.();
    if (combined.aborted) throw new Error("MODEL_UNAVAILABLE");
    if (used) throw new Error("MODEL_UNAVAILABLE");
    used = true;
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          // Resolve once and pin the socket to the checked address.
          lookup: (_host, _options, callback) => callback(null, target.address, target.family),
          family: target.family,
          // Never reuse a socket created by another caller or a prior DNS answer.
          agent: false,
          signal: combined,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.destroy();
            reject(new Error("MODEL_UNAVAILABLE"));
            return;
          }
          const parts: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 256 * 1024) {
              reject(new Error("MODEL_RESPONSE_INVALID"));
              res.destroy();
            } else parts.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(parts)));
          res.on("error", () => reject(new Error("MODEL_UNAVAILABLE")));
          res.on("aborted", () => reject(new Error("MODEL_UNAVAILABLE")));
        },
      );
      req.on("error", () => reject(new Error("MODEL_UNAVAILABLE")));
      req.once("finish", () => {
        try {
          onRequestSent?.();
        } catch {
          reject(new Error("MODEL_UNAVAILABLE"));
          req.destroy();
        }
      });
      req.end(init.body);
    });
    return new Response(new Uint8Array(raw), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
