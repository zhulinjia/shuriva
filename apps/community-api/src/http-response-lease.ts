import type { ServerResponse } from "node:http";
import { diagnostics } from "./logging/public.js";
/** Per-response write boundary for authorized JSON/MCP delivery. Express and
 * adapters may encode or hash after their caller's check, so check again where
 * bytes enter Node's outgoing response. Never changes another response. */
export function installHttpResponseLease(
  response: ServerResponse,
  assertActive: () => void,
  signal: AbortSignal,
) {
  const write = response.write.bind(response),
    end = response.end.bind(response);
  const allowed = () => {
    try {
      signal.throwIfAborted();
      assertActive();
      return !response.destroyed;
    } catch (error) {
      response.destroy();
      diagnostics.warn("http.delivery_rejected", {}, error);
      return false;
    }
  };
  type Written = (error: Error | null | undefined) => void;
  response.write = (chunk: unknown, encoding?: BufferEncoding | Written, callback?: Written) => {
    if (!allowed()) return false;
    return typeof encoding === "function"
      ? write(chunk, encoding)
      : encoding === undefined
        ? write(chunk, callback)
        : write(chunk, encoding, callback);
  };
  response.end = (
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (!allowed()) return response;
    return typeof encoding === "function"
      ? end(chunk, encoding)
      : encoding === undefined
        ? end(chunk, callback)
        : end(chunk, encoding, callback);
  };
  const abort = () => response.destroy();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return () => {
    signal.removeEventListener("abort", abort);
  };
}
