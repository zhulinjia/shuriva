import { BoundaryError } from "./limits.js";

/** A deadline bounds the response. Late SDK work retains its independent
 * quota until it settles; ignored cancellation cannot grow an unbounded queue. */
export class AuthorizationWork {
  private pending = 0;
  constructor(
    private readonly timeoutMs: number,
    private readonly maximum = 8,
  ) {}
  get outstanding() {
    return this.pending;
  }
  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new BoundaryError(408, "MCP_AUTH_ABORTED");
    if (this.pending >= this.maximum) throw new BoundaryError(503, "MCP_AUTH_CAPACITY");
    this.pending++;
    const controller = new AbortController();
    const work = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new BoundaryError(408, "MCP_AUTH_ABORTED");
        return operation(controller.signal);
      })
      .finally(() => {
        this.pending--;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        controller.abort();
        reject(new BoundaryError(408, "MCP_AUTH_ABORTED"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => {
        controller.abort();
        reject(new BoundaryError(408, "MCP_AUTH_TIMEOUT"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
