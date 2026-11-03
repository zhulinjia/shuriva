import type { ServerResponse } from "node:http";
import { McpError } from "./model.js";
import { installHttpResponseLease } from "../http-response-lease.js";
export type ToolResponse = { content: { type: "text"; text: string }[] };
/** SDK result readiness and HTTP completion are separate: the authorization
 * transaction stays alive while the SDK serializes and the socket sends. */
export class ResponsePublication {
  readonly finished: Promise<void>;
  private readonly stopped = new AbortController();
  private resolve?: (value: ToolResponse) => void;
  private published = false;
  private assertActive?: () => void;
  private lease?: AbortSignal;
  constructor(private readonly response: ServerResponse) {
    this.finished = new Promise((resolve) => {
      const timer = setTimeout(() => response.destroy(), 5000);
      timer.unref();
      const done = () => {
        clearTimeout(timer);
        this.stopped.abort();
        resolve();
      };
      response.once("finish", done);
      response.once("close", done);
    });
  }
  private check() {
    this.lease?.throwIfAborted();
    this.assertActive?.();
    if (this.response.destroyed || this.response.writableEnded)
      throw new McpError("MCP_RESPONSE_CLOSED", 408);
  }
  release(value: ToolResponse, assertActive: () => void, signal: AbortSignal) {
    if (!this.resolve) throw new McpError("MCP_RESPONSE_CLOSED", 408);
    this.assertActive = assertActive;
    this.lease = signal;
    const dispose = installHttpResponseLease(this.response, assertActive, signal);
    void this.finished.then(dispose);
    const abort = () => this.response.destroy();
    signal.addEventListener("abort", abort, { once: true });
    void this.finished.then(() => signal.removeEventListener("abort", abort));
    this.check();
    this.published = true;
    this.resolve(value);
  }
  send(operation: () => Promise<unknown>): Promise<ToolResponse> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      void operation().catch((error) => {
        if (this.published) this.response.destroy();
        else reject(error);
      });
    });
  }
  /** Buffer the SDK's final encoded JSON envelope before the final lease check;
   * downstream Node writes bytes and cannot serialize business data afterward. */
  async prepare(value: Response): Promise<Response> {
    const reader = value.body?.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    const signal = AbortSignal.any([this.stopped.signal, ...(this.lease ? [this.lease] : [])]);
    const abort = () => {
      void reader?.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 6 * 1048576 + 65536) throw new McpError("MCP_RESPONSE_LIMIT", 503);
          parts.push(chunk.value);
        }
      this.check();
      signal.throwIfAborted();
      return new Response(
        [204, 205, 304].includes(value.status) ? null : Buffer.concat(parts, size),
        { status: value.status, headers: value.headers },
      );
    } finally {
      signal.removeEventListener("abort", abort);
      void reader?.cancel().catch(() => {});
    }
  }
}
