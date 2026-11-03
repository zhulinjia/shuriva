import { performance } from "node:perf_hooks";
import { diagnostics } from "../logging/public.js";
import { type StoredCallState, ExternalMcpError } from "./model.js";

type Terminal = { owner: string; id: string; state: StoredCallState };
/** Client-owned terminal facts only. Two writers, rotating failures, no
 * arguments/results/callbacks in the queue; admission counts its retained IDs. */
export class TerminalUpdates {
  private readonly pending = new Map<string, Terminal>();
  private readonly completed = new Map<string, Terminal>();
  private readonly working = new Map<string, Promise<void>>();
  private readers = 0;
  constructor(private readonly write: (value: Terminal) => Promise<void>) {}
  ids() {
    return [...this.pending.keys(), ...this.completed.keys()];
  }
  health() {
    return { pending: this.pending.size, outstanding: this.working.size, capacity: 2 };
  }
  get(id: string) {
    return this.pending.get(id) ?? this.completed.get(id);
  }
  enqueue(value: Terminal) {
    if (!this.get(value.id)) this.pending.set(value.id, Object.freeze({ ...value }));
    this.tick();
  }
  /** A later observed outcome replaces an owned, still-retained completion. */
  revise(value: Terminal) {
    this.completed.delete(value.id);
    this.pending.set(value.id, Object.freeze({ ...value }));
    this.tick();
  }
  tick() {
    for (const [id, value] of this.pending) {
      if (this.working.size >= 2) return;
      if (this.working.has(id)) continue;
      let delivered = false;
      const task = this.write(value)
        .then(() => {
          delivered = true;
          if (this.pending.get(id) === value) {
            this.pending.delete(id);
            if (this.readers) this.completed.set(id, value);
          }
        })
        .catch((error) => {
          if (this.pending.get(id) === value) {
            this.pending.delete(id);
            this.pending.set(id, value);
          }
          diagnostics.error("mcp.external_failed", { externalCallId: id }, error);
        })
        .finally(() => {
          this.working.delete(id);
          if (delivered) this.tick();
        });
      this.working.set(id, task);
    }
  }
  async read<T, R>(operation: () => Promise<T>, project: (value: T) => R) {
    if (this.readers >= 32) throw new ExternalMcpError("EXTERNAL_MCP_REQUEST_CAPACITY", 429);
    this.readers++;
    try {
      return project(await operation());
    } finally {
      this.readers--;
      if (!this.readers) this.completed.clear();
    }
  }
  async settle() {
    const end = performance.now() + 1500;
    while (this.pending.size && performance.now() < end) {
      this.tick();
      await Promise.race([...this.working.values(), new Promise<void>((r) => setTimeout(r, 100))]);
    }
  }
}
