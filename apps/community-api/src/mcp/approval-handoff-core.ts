import { createHmac, timingSafeEqual } from "node:crypto";
import { isMainThread } from "node:worker_threads";

/** These values bind a request to its durable invocation record. The vault is
 * only a short-lived handoff: it does not authenticate callers or authorize
 * execution. The application must check those before taking an item. */
export interface ApprovalBinding {
  readonly grantId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly toolVersion: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ITEM_BYTES = 32 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 128;
const TTL_MS = 120_000;
// All instances in this process share the sensitive-payload quota.
let totalBytes = 0;
let totalItems = 0;

function valid(binding: ApprovalBinding): boolean {
  return (
    binding !== null &&
    typeof binding === "object" &&
    typeof binding.grantId === "string" &&
    typeof binding.requestId === "string" &&
    typeof binding.toolVersion === "string" &&
    UUID.test(binding.grantId) &&
    UUID.test(binding.requestId) &&
    Number.isSafeInteger(binding.generation) &&
    binding.generation > 0 &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(binding.toolVersion)
  );
}

function digest(key: Buffer, binding: ApprovalBinding, payload: Buffer): Buffer {
  const mac = createHmac("sha256", key).update("stackoryn/mcp-approval/v1\0");
  // Fixed-size length framing prevents ambiguous field concatenation.
  for (const part of [
    Buffer.from(binding.grantId),
    Buffer.from(String(binding.generation)),
    Buffer.from(binding.requestId),
    Buffer.from(binding.toolVersion),
    payload,
  ]) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length);
    mac.update(length).update(part);
  }
  return mac.digest();
}

interface Entry {
  payload: Buffer;
  commitment: Buffer;
  monotonicStart: number;
  wallStart: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

/** Per-process bounded sensitive-data handoff. After staging, the application
 * must atomically reserve the UUID/commitment in durable storage before making
 * the item available; discard it if reservation fails. A lost item must never
 * be recreated after restart. The key comes from a protected long-lived store. */
/** Internal implementation. Product callers must use approval-handoff.ts;
 * clock injection is reserved for the module wrapper and deterministic tests. */
export function createApprovalHandoffCore(
  key: Buffer,
  options: { monotonic: () => number; wall?: () => number; ttlMs?: number },
) {
  if (!isMainThread) throw new Error("MCP_HANDOFF_WORKER_UNSUPPORTED");
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("MCP_HANDOFF_KEY_INVALID");
  const monotonic = options.monotonic;
  const wall = options.wall ?? Date.now;
  const ttl = options.ttlMs ?? TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 20 || ttl > TTL_MS)
    throw new Error("MCP_HANDOFF_TTL_INVALID");
  const elapsedLimit = ttl;
  const secret = Buffer.from(key);
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lastMonotonic: number | undefined;
  let lastWall: number | undefined;
  const remove = (id: string, expected?: Entry) => {
    const entry = entries.get(id);
    if (!entry || (expected && expected !== entry)) return;
    entries.delete(id);
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    totalBytes -= entry.payload.length;
    totalItems--;
    entry.payload.fill(0);
    entry.commitment.fill(0);
    if (!entries.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const sweep = () => {
    let m: number, w: number;
    try {
      m = monotonic();
      w = wall();
    } catch (error) {
      for (const id of entries.keys()) remove(id);
      lastMonotonic = undefined;
      lastWall = undefined;
      throw new Error("MCP_HANDOFF_CLOCK_INVALID", { cause: error });
    }
    if (
      !Number.isFinite(m) ||
      !Number.isFinite(w) ||
      (lastMonotonic !== undefined && m < lastMonotonic) ||
      (lastWall !== undefined && w < lastWall)
    ) {
      for (const id of entries.keys()) remove(id);
      lastMonotonic = undefined;
      lastWall = undefined;
      throw new Error("MCP_HANDOFF_CLOCK_INVALID");
    }
    lastMonotonic = m;
    lastWall = w;
    for (const [id, entry] of entries)
      if (
        m < entry.monotonicStart ||
        w < entry.wallStart ||
        m - entry.monotonicStart >= elapsedLimit ||
        w - entry.wallStart >= ttl
      )
        remove(id);
    return { m, w };
  };
  return {
    commitment(binding: ApprovalBinding, payload: Buffer): string {
      if (
        closed ||
        !valid(binding) ||
        !Buffer.isBuffer(payload) ||
        payload.length < 1 ||
        payload.length > MAX_ITEM_BYTES
      )
        throw new Error("MCP_HANDOFF_INVALID");
      return digest(secret, binding, payload).toString("hex");
    },
    stage(binding: ApprovalBinding, payload: Buffer): { commitment: string; discard: () => void } {
      if (closed) throw new Error("MCP_HANDOFF_CLOSED");
      if (
        !valid(binding) ||
        !Buffer.isBuffer(payload) ||
        payload.length < 1 ||
        payload.length > MAX_ITEM_BYTES
      )
        throw new Error("MCP_HANDOFF_INVALID");
      const beforeTimer = sweep();
      if (entries.has(binding.requestId)) throw new Error("MCP_HANDOFF_DUPLICATE");
      if (totalItems >= MAX_ITEMS || totalBytes + payload.length > MAX_BYTES)
        throw new Error("MCP_HANDOFF_FULL");
      const id = binding.requestId;
      let entry: Entry | undefined;
      let copy: Buffer | undefined;
      // Arm the timer before assigning the new entry's start time. Even if the
      // process is descheduled while staging, the timer cannot be later than
      // the recorded lifetime. Callbacks cannot run during this synchronous method.
      const deadlineTimer = setTimeout(() => {
        if (entry) remove(id, entry);
      }, ttl);
      deadlineTimer.unref();
      try {
        const start = sweep();
        if (start.m - beforeTimer.m >= ttl || start.w - beforeTimer.w >= ttl)
          throw new Error("MCP_HANDOFF_EXPIRED");
        copy = Buffer.from(payload);
        const commitment = digest(secret, binding, copy);
        entry = {
          payload: copy,
          commitment,
          // Expiry checks use the pre-arm sample. The timer was armed before
          // copying or retaining payload, so cleanup cannot extend the
          // sensitive payload's lifetime even if scheduling was delayed.
          monotonicStart: beforeTimer.m,
          wallStart: beforeTimer.w,
          deadlineTimer,
        };
        entries.set(id, entry);
        totalItems++;
        totalBytes += copy.length;
        sweep();
        if (entries.get(id) !== entry) throw new Error("MCP_HANDOFF_EXPIRED");
        if (!timer) {
          timer = setInterval(
            () => {
              try {
                sweep();
              } catch {
                /* entries were cleared */
              }
            },
            Math.min(1000, ttl),
          );
          timer.unref();
        }
        const retained = entry;
        return { commitment: commitment.toString("hex"), discard: () => remove(id, retained) };
      } catch (error) {
        clearTimeout(deadlineTimer);
        if (entry) remove(id, entry);
        else copy?.fill(0);
        throw error;
      }
    },
    take(binding: ApprovalBinding, expectedCommitment: string): Buffer | null {
      if (closed) return null;
      if (
        !valid(binding) ||
        typeof expectedCommitment !== "string" ||
        !/^[0-9a-f]{64}$/.test(expectedCommitment)
      )
        return null;
      sweep();
      const entry = entries.get(binding.requestId);
      if (!entry) return null;
      const claimed = Buffer.from(expectedCommitment, "hex");
      const actual = digest(secret, binding, entry.payload);
      if (!timingSafeEqual(entry.commitment, claimed) || !timingSafeEqual(entry.commitment, actual))
        return null;
      const result = Buffer.from(entry.payload);
      remove(binding.requestId);
      return result;
    },
    inspect(binding: ApprovalBinding, expectedCommitment: string): Buffer | null {
      if (closed || !valid(binding) || !/^[0-9a-f]{64}$/.test(expectedCommitment)) return null;
      sweep();
      const entry = entries.get(binding.requestId);
      if (!entry) return null;
      const claimed = Buffer.from(expectedCommitment, "hex");
      const actual = digest(secret, binding, entry.payload);
      return timingSafeEqual(entry.commitment, claimed) && timingSafeEqual(entry.commitment, actual)
        ? Buffer.from(entry.payload)
        : null;
    },
    size(): number {
      return entries.size;
    },
    close(): void {
      closed = true;
      for (const id of entries.keys()) remove(id);
      secret.fill(0);
    },
  };
}
