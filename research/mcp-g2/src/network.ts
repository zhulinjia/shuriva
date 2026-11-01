import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { BoundaryError } from "./limits.js";

type Address = { address: string; family: number };
function parseUrl(raw: string) {
  if (raw.length > 4096) throw new BoundaryError(403, "MCP_DESTINATION_REJECTED");
  try {
    return new URL(raw);
  } catch {
    throw new BoundaryError(403, "MCP_DESTINATION_REJECTED");
  }
}
interface NetworkPolicy {
  readonly destinations: readonly string[];
  readonly blockedOrigins: readonly string[];
  readonly privateApprovals: ReadonlyArray<{ origin: string; addresses: readonly string[] }>;
  readonly credentialOrigin?: string;
  readonly credentialDestinations?: readonly string[];
  readonly timeoutMs?: number;
  readonly responseBytes?: number;
}

function eligiblePrivate(address: string) {
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return (
    octets[0] === 127 ||
    octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)
  );
}

/** HTTP primitive proof, not a generic browser fetch. Unsupported request body
 * kinds fail closed. OAuth/MCP adapters use the same explicitly approved URLs.
 * The existing address classifier is injected rather than copying its lists.
 */
export function guardedFetch(
  policy: NetworkPolicy,
  isPublic: (address: string, family: number) => boolean,
  resolveHost: (host: string) => Promise<Address[]> = (host) =>
    lookup(host, { all: true, verbatim: true }),
): typeof globalThis.fetch {
  const approved = new Set(
    policy.destinations.map((raw) => {
      const url = parseUrl(raw);
      return url.href;
    }),
  );
  return async (input, init) => {
    const url = parseUrl(input instanceof Request ? input.url : input.toString());
    const privateApproval = policy.privateApprovals.find((entry) => entry.origin === url.origin);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.href.length > 4096 ||
      !approved.has(url.href) ||
      policy.blockedOrigins.includes(url.origin) ||
      !(url.protocol === "https:" || (url.protocol === "http:" && privateApproval))
    )
      throw new BoundaryError(403, "MCP_DESTINATION_REJECTED");
    if (input instanceof Request && input.body)
      throw new BoundaryError(400, "MCP_BODY_KIND_REJECTED");
    if (
      init?.body != null &&
      typeof init.body !== "string" &&
      !(init.body instanceof URLSearchParams)
    )
      throw new BoundaryError(400, "MCP_BODY_KIND_REJECTED");
    const body = init?.body == null ? undefined : init.body.toString();
    if (body && Buffer.byteLength(body) > 65536) throw new BoundaryError(413, "MCP_INPUT_LIMIT");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    if (
      ["cookie", "host", "proxy-authorization"].some((name) => headers.has(name)) ||
      ([...headers.keys()].some((name) => !["accept", "content-type"].includes(name)) &&
        (url.origin !== policy.credentialOrigin ||
          !policy.credentialDestinations?.includes(url.href)))
    )
      throw new BoundaryError(403, "MCP_CREDENTIAL_DESTINATION_REJECTED");
    const timeout = AbortSignal.timeout(policy.timeoutMs ?? 10_000);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await new Promise<Address[]>((resolve, reject) => {
      const abort = () => reject(new BoundaryError(408, "MCP_NETWORK_TIMEOUT"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void (
        isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : resolveHost(host)
      )
        .then(resolve, () => reject(new BoundaryError(502, "MCP_DNS_FAILED")))
        .finally(() => signal.removeEventListener("abort", abort));
    });
    if (
      !addresses.length ||
      addresses.some((entry) =>
        privateApproval
          ? !(eligiblePrivate(entry.address) && privateApproval.addresses.includes(entry.address))
          : !isPublic(entry.address, entry.family),
      )
    )
      throw new BoundaryError(403, "MCP_ADDRESS_REJECTED");
    const target = addresses[0];
    if (!target || signal.aborted) throw new BoundaryError(408, "MCP_NETWORK_TIMEOUT");
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        url,
        {
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          headers: Object.fromEntries(headers.entries()),
          agent: false,
          signal,
          lookup: (_host, _opts, done) => done(null, target.address, target.family),
          family: target.family,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new BoundaryError(403, "MCP_REDIRECT_REJECTED"));
            return;
          }
          let bytes = 0;
          let stopped = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on("data", (part: Buffer) => {
                bytes += part.length;
                if (bytes > (policy.responseBytes ?? 1024 * 1024)) {
                  stopped = true;
                  controller.error(new BoundaryError(413, "MCP_RESPONSE_LIMIT"));
                  response.destroy();
                } else {
                  controller.enqueue(part);
                  if ((controller.desiredSize ?? 0) <= 0) response.pause();
                }
              });
              response.once("end", () => {
                if (!stopped) {
                  stopped = true;
                  controller.close();
                }
              });
              response.once("error", () => {
                if (!stopped) {
                  stopped = true;
                  controller.error(new BoundaryError(502, "MCP_NETWORK_FAILED"));
                }
              });
              response.once("aborted", () => {
                if (!stopped) {
                  stopped = true;
                  controller.error(new BoundaryError(502, "MCP_NETWORK_FAILED"));
                }
              });
            },
            pull() {
              response.resume();
            },
            cancel() {
              stopped = true;
              response.destroy();
            },
          });
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              resultHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(
            new Response([204, 205, 304].includes(status) ? null : stream, {
              status,
              headers: resultHeaders,
            }),
          );
        },
      );
      request.once("error", () => reject(new BoundaryError(502, "MCP_NETWORK_FAILED")));
      request.end(body);
    });
  };
}
