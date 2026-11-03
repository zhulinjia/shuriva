import { performance } from "node:perf_hooks";

/** An SDK call may ignore cancellation. A timed-out operation retains its slot
 * until it settles, so repeated timeouts cannot create an unbounded queue. */
export class AuthorizationWork {
  private pending = 0;
  constructor(
    private readonly timeoutMs = 5_000,
    private readonly maximum = 8,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 32
    )
      throw new Error("MCP_AUTH_WORK_CONFIG_INVALID");
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maximum) throw new Error("MCP_AUTH_CAPACITY");
    this.pending++;
    const deadline = performance.now() + this.timeoutMs;
    const work = Promise.resolve()
      .then(() => {
        if (performance.now() >= deadline) throw new Error("MCP_AUTH_DEADLINE_EXCEEDED");
        return operation();
      })
      .finally(() => {
        this.pending--;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MCP_AUTH_DEADLINE_EXCEEDED")), this.timeoutMs);
    });
    try {
      const result = await Promise.race([work, timeout]);
      if (performance.now() >= deadline) throw new Error("MCP_AUTH_DEADLINE_EXCEEDED");
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** State-changing exchanges must settle authoritatively; cap outstanding
   * physical work without returning a fictitious timeout before it completes. */
  async settle<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maximum) throw new Error("MCP_AUTH_CAPACITY");
    this.pending++;
    try {
      return await operation();
    } finally {
      this.pending--;
    }
  }
}
