import { BoundaryError } from "./limits.js";

/** Token buckets have a fixed capacity; keys come from verified identities, not JSON. */
export class RateBudget {
  private readonly entries = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly clock = () => performance.now(),
    private readonly maxKeys = 256,
  ) {}
  take(key: string) {
    const now = this.clock();
    let state = this.entries.get(key);
    if (!state) {
      if (this.entries.size >= this.maxKeys) {
        const refillMs = (this.burst * 60_000) / this.perMinute;
        for (const [oldKey, old] of this.entries)
          if (now - old.at >= refillMs) this.entries.delete(oldKey);
      }
      if (this.entries.size >= this.maxKeys) throw new BoundaryError(429, "MCP_RATE_CAPACITY");
      state = { tokens: this.burst, at: now };
      this.entries.set(key, state);
    }
    state.tokens = Math.min(
      this.burst,
      state.tokens + (Math.max(0, now - state.at) * this.perMinute) / 60_000,
    );
    state.at = now;
    if (state.tokens < 1) throw new BoundaryError(429, "MCP_RATE_LIMIT");
    state.tokens--;
  }
}

export interface VerifiedGrant {
  readonly id: string;
  readonly clientId: string;
  readonly ownerId: string;
  readonly familyId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly recipient: string;
  readonly token: string;
  readonly scopes: readonly string[];
}

export class Admission {
  private active = 0;
  private readonly grants = new Map<string, number>();
  private readonly rates: RateBudget;
  private readonly global: RateBudget;
  constructor(clock = () => performance.now()) {
    this.rates = new RateBudget(60, 8, clock);
    this.global = new RateBudget(600, 32, clock, 1);
  }
  enter(grant: VerifiedGrant) {
    this.global.take("process");
    this.rates.take(`principal:${grant.ownerId}:${grant.recipient}`);
    this.rates.take(`family:${grant.familyId}`);
    const current = this.grants.get(grant.id) ?? 0;
    if (this.active >= 32 || current >= 4) throw new BoundaryError(429, "MCP_INFLIGHT_LIMIT");
    this.active++;
    this.grants.set(grant.id, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const count = (this.grants.get(grant.id) ?? 1) - 1;
      if (count) this.grants.set(grant.id, count);
      else this.grants.delete(grant.id);
    };
  }
}
