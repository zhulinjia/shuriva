import { createHash, randomBytes } from "node:crypto";
import { BoundaryError } from "./limits.js";

interface CallbackContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly connectionId: string;
}
interface PendingCallback extends CallbackContext {
  readonly issuer: string;
  readonly resource: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

/** Host-owned callback correlation, not an OAuth implementation. PKCE, code
 * exchange and issuer discovery stay in the SDK. Pending state is lost on restart.
 */
export class CallbackApprovals {
  private readonly pending = new Map<string, PendingCallback>();
  constructor(
    private readonly sessionActive: (identity: CallbackContext) => Promise<boolean>,
    private readonly clock = () => Date.now(),
  ) {}
  async begin(input: Omit<PendingCallback, "expiresAt">) {
    for (const [kind, raw] of Object.entries({
      issuer: input.issuer,
      resource: input.resource,
      redirectUri: input.redirectUri,
    })) {
      const url = this.parse(raw);
      if (
        url.username ||
        url.password ||
        (kind !== "resource" && url.search) ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw new BoundaryError(400, "MCP_CALLBACK_CONFIG_REJECTED");
    }
    if (!(await this.sessionActive(input)))
      throw new BoundaryError(401, "MCP_CALLBACK_SESSION_REJECTED");
    for (const [key, value] of this.pending)
      if (value.expiresAt <= this.clock()) this.pending.delete(key);
    if (this.pending.size >= 16) throw new BoundaryError(429, "MCP_CALLBACK_CAPACITY");
    const state = randomBytes(32).toString("base64url");
    this.pending.set(
      this.hash(state),
      Object.freeze({ ...input, expiresAt: this.clock() + 300_000 }),
    );
    return state;
  }
  async consume(raw: string, current: CallbackContext) {
    const callback = this.parse(raw);
    const states = callback.searchParams.getAll("state");
    const issuers = callback.searchParams.getAll("iss");
    const codes = callback.searchParams.getAll("code");
    const key = this.hash(states[0] ?? "");
    const record = this.pending.get(key);
    this.pending.delete(key); // consume before any async session check
    const destination = new URL(record?.redirectUri ?? "https://invalid.invalid");
    if (
      !record ||
      record.expiresAt <= this.clock() ||
      states.length !== 1 ||
      issuers.length !== 1 ||
      codes.length !== 1 ||
      !codes[0] ||
      codes[0].length > 4096 ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.protocol !== destination.protocol ||
      callback.host !== destination.host ||
      callback.origin !== destination.origin ||
      callback.pathname !== destination.pathname ||
      issuers[0] !== record.issuer ||
      current.ownerId !== record.ownerId ||
      current.sessionId !== record.sessionId ||
      current.connectionId !== record.connectionId
    )
      throw new BoundaryError(403, "MCP_CALLBACK_REJECTED");
    if (!(await this.sessionActive(current)))
      throw new BoundaryError(401, "MCP_CALLBACK_SESSION_REJECTED");
    if (record.expiresAt <= this.clock()) throw new BoundaryError(403, "MCP_CALLBACK_REJECTED");
    return Object.freeze({
      authorizationCode: codes[0],
      authorizationResponseIssuer: record.issuer,
      resource: record.resource,
      connectionId: record.connectionId,
    });
  }
  private parse(raw: string) {
    if (raw.length > 8192) throw new BoundaryError(400, "MCP_CALLBACK_REJECTED");
    try {
      return new URL(raw);
    } catch {
      throw new BoundaryError(400, "MCP_CALLBACK_REJECTED");
    }
  }
  private hash(state: string) {
    return createHash("sha256").update(state).digest("hex");
  }
}
