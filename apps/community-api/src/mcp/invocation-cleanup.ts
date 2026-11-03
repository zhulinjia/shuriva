import { diagnostics } from "../logging/public.js";
import { McpError } from "./model.js";
export type PendingTerminal = "cancelled" | "expired" | "failed";
export interface InvocationCleanupIntent {
  ownerId: string;
  id: string;
  grantId: string;
  generation: number;
  bootId: string;
  commitment: string;
  pending: PendingTerminal;
  running: string;
  approvalSessionId: string | null;
}
/** Metadata-only retry queue. No bearer, SQL, parameters, results or callbacks
 * retaining them. Stalled IO uses two slots, independent of auth monitoring. */
export class InvocationCleanup {
  private readonly pending = new Map<string, InvocationCleanupIntent>();
  private readonly working = new Set<string>();
  private readonly completed = new Map<string, InvocationCleanupIntent>();
  private readers = 0;
  private readonly idleWaiters = new Set<() => void>();
  constructor(private readonly deliver: (intent: InvocationCleanupIntent) => Promise<void>) {}
  get size() {
    return this.pending.size + this.completed.size;
  }
  has(id: string) {
    return this.pending.has(id) || this.completed.has(id);
  }
  project(owner: string, id: string, state: string) {
    const intent = this.pending.get(id) ?? this.completed.get(id);
    return intent?.ownerId === owner
      ? state === "pending_approval"
        ? intent.pending
        : state === "running"
          ? intent.running
          : state
      : state;
  }
  enqueue(intent: InvocationCleanupIntent) {
    if (!this.pending.has(intent.id) && !this.completed.has(intent.id))
      this.pending.set(intent.id, Object.freeze({ ...intent }));
    this.tick();
  }
  health() {
    return {
      pending: this.pending.size,
      outstanding: this.working.size,
      capacity: 2,
      readers: this.readers,
      projections: this.completed.size,
    };
  }
  /** Keep a completed projection while an earlier DB snapshot can still arrive.
   * Projection capacity remains part of the same 128 invocation budget. */
  async read<T, R>(operation: () => Promise<T>, project: (value: T) => R): Promise<R> {
    if (this.readers >= 64) throw new McpError("MCP_METADATA_READ_CAPACITY", 429);
    this.readers++;
    try {
      return project(await operation());
    } finally {
      this.readers--;
      if (!this.readers) this.completed.clear();
    }
  }
  /** Best-effort drain before the owning pool closes. A stalled writer retains
   * its slot; shutdown does not pretend that timeout cancelled physical IO. */
  async settle(timeoutMs = 1000, registrations: readonly Promise<void>[] = []) {
    if ((!this.pending.size && !registrations.length) || timeoutMs <= 0) return;
    this.tick();
    await new Promise<void>((resolve) => {
      let waiting = registrations.length > 0,
        ended = false;
      const stop = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearInterval(retry);
        this.idleWaiters.delete(finish);
        resolve();
      };
      const finish = () => {
        if (!waiting && !this.pending.size) stop();
      };
      const timer = setTimeout(stop, timeoutMs);
      const retry = setInterval(() => {
        this.tick();
        finish();
      }, 100);
      this.idleWaiters.add(finish);
      if (waiting)
        void Promise.allSettled(registrations).then(() => {
          waiting = false;
          finish();
        });
    });
  }
  tick() {
    for (const [id, intent] of this.pending) {
      if (this.working.size >= 2) return;
      if (this.working.has(id)) continue;
      this.working.add(id);
      let delivered = false;
      void this.deliver(intent)
        .then(() => {
          delivered = true;
          if (this.pending.get(id) === intent) {
            this.pending.delete(id);
            if (this.readers) this.completed.set(id, intent);
          }
          if (!this.pending.size) for (const finish of this.idleWaiters) finish();
        })
        .catch((error) => {
          // Rotate failed rows behind unrelated work; no immediate busy retry.
          if (this.pending.get(id) === intent) {
            this.pending.delete(id);
            this.pending.set(id, intent);
          }
          diagnostics.error("mcp.authorization_unavailable", {}, error);
        })
        .finally(() => {
          this.working.delete(id);
          if (delivered) this.tick();
        });
    }
  }
}
