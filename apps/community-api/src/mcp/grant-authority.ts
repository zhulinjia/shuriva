import { createHash } from "node:crypto";

/** Authentication adapters must construct this from a verified SDK result. */
export interface VerifiedMcpToken {
  readonly ownerId: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

export interface McpGrantRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly clientId: string;
  readonly approvalSessionId: string;
  readonly resource: string;
  readonly generation: number;
  readonly tokenGeneration: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

export interface McpGrantObservation {
  /** Hold grant, token binding and actual approval-session locks while the
   * asynchronous decision runs; fail closed on any storage/locking error. */
  observe(
    tokenHash: string,
    decide: (snapshot: {
      readonly grant: McpGrantRecord | null;
      readonly sessionExpiresAt: number | undefined;
    }) => Promise<boolean>,
  ): Promise<boolean>;
}

export type AuthorizedMcpGrant = Readonly<{
  id: string;
  ownerId: string;
  clientId: string;
  approvalSessionId: string;
  resource: string;
  generation: number;
  scopes: readonly string[];
  validUntil: number;
}>;

/** The SDK validates the opaque token; this separately binds it to the actual
 * approval session and grant generation. Neither an SDK claim nor a client
 * parameter alone constitutes application authorization. */
export function createMcpGrantAuthority(
  store: McpGrantObservation,
  issuer: string,
  resource: string,
  clock: () => number = Date.now,
) {
  const sameScopes = (a: readonly string[], b: readonly string[]) => {
    const first = new Set(a),
      second = new Set(b);
    return (
      first.size === a.length &&
      second.size === b.length &&
      first.size === second.size &&
      [...first].every((scope) => second.has(scope))
    );
  };
  const matchesToken = (token: VerifiedMcpToken) =>
    token.ownerId.length > 0 &&
    token.clientId.length > 0 &&
    token.issuer === issuer &&
    token.audience.length === 1 &&
    token.audience[0] === resource &&
    token.scopes.length > 0 &&
    token.scopes.length <= 32 &&
    token.scopes.every((scope) => /^[a-z][a-z0-9:_-]{0,63}$/.test(scope)) &&
    new Set(token.scopes).size === token.scopes.length &&
    Number.isFinite(token.expiresAt) &&
    token.expiresAt > clock();

  return async (
    token: string,
    initial: VerifiedMcpToken,
    confirmAuthentication: () => Promise<VerifiedMcpToken | null>,
  ): Promise<AuthorizedMcpGrant | null> => {
    if (!token || Buffer.byteLength(token) > 4096 || !matchesToken(initial)) return null;
    // A caller must not be able to change the checked claims while storage or
    // the final SDK check is awaiting I/O.
    const checked: VerifiedMcpToken = Object.freeze({
      ...initial,
      audience: Object.freeze([...initial.audience]),
      scopes: Object.freeze([...initial.scopes]),
    });
    const hash = createHash("sha256").update(token).digest("hex");
    let approved: AuthorizedMcpGrant | undefined;
    const accepted = await store.observe(hash, async ({ grant, sessionExpiresAt }) => {
      if (
        !grant ||
        grant.revoked ||
        !grant.id ||
        !grant.approvalSessionId ||
        grant.ownerId !== checked.ownerId ||
        grant.clientId !== checked.clientId ||
        grant.resource !== resource ||
        !Number.isSafeInteger(grant.generation) ||
        grant.generation < 1 ||
        grant.generation !== grant.tokenGeneration ||
        !Number.isFinite(grant.expiresAt) ||
        sessionExpiresAt === undefined ||
        !Number.isFinite(sessionExpiresAt) ||
        grant.expiresAt <= clock() ||
        sessionExpiresAt <= clock()
      )
        return false;
      const final = await confirmAuthentication();
      if (
        !final ||
        !matchesToken(final) ||
        final.ownerId !== checked.ownerId ||
        final.clientId !== checked.clientId ||
        final.issuer !== checked.issuer ||
        !sameScopes(checked.scopes, final.scopes)
      )
        return false;
      const validUntil = Math.min(
        grant.expiresAt,
        sessionExpiresAt,
        checked.expiresAt,
        final.expiresAt,
      );
      if (validUntil <= clock()) return false;
      approved = Object.freeze({
        id: grant.id,
        ownerId: grant.ownerId,
        clientId: grant.clientId,
        approvalSessionId: grant.approvalSessionId,
        resource,
        generation: grant.generation,
        scopes: Object.freeze([...final.scopes]),
        validUntil,
      });
      return true;
    });
    return accepted && approved && approved.validUntil > clock() ? approved : null;
  };
}
