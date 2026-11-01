import { ConnectorError } from "./errors.js";

/** Serializes publication, revocation and rotation for each Connector identity. */
export class IdentityQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  run<T>(id: string, fn: () => Promise<T>, limit = true): Promise<T> {
    const depth = this.depths.get(id) ?? 0;
    if (limit && depth >= 16) throw new ConnectorError("CAPACITY");
    this.depths.set(id, depth + 1);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      const remaining = (this.depths.get(id) ?? 1) - 1;
      if (remaining) this.depths.set(id, remaining);
      else this.depths.delete(id);
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return run;
  }
  async drain(): Promise<void> {
    await Promise.all(this.tails.values());
  }
}
