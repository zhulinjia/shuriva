import { createHash } from "node:crypto";

export interface GrantRecord {
  readonly ownerId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly resource: string;
  readonly generation: number;
  readonly issuedGeneration: number;
  readonly revoked: boolean;
  readonly expiresAt: number;
}
export interface GrantAuthorityPorts {
  /** Hold shared grant/session locks on one transaction connection while the
   * final authentication confirmation runs against that locked snapshot. */
  observe(
    hash: string,
    decide: (snapshot: {
      readonly record: GrantRecord | null;
      readonly sessionExpiresAt: number | undefined;
    }) => Promise<boolean>,
  ): Promise<boolean>;
}

/** The session reference is immutable application metadata. In particular it
 * must not disappear through an OAuth-table FK's ON DELETE SET NULL behavior.
 * These checks supplement the library, never replace its token validation.
 */
export function grantAuthority(ports: GrantAuthorityPorts, clock = () => Date.now()) {
  const matches = (
    record: GrantRecord | null,
    claims: Readonly<Record<string, unknown>>,
  ): record is GrantRecord => {
    if (
      !record ||
      record.revoked ||
      !Number.isSafeInteger(record.generation) ||
      record.generation !== record.issuedGeneration ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= clock() ||
      !record.sessionId ||
      claims.sub !== record.ownerId ||
      claims.client_id !== record.clientId
    )
      return false;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audience.length === 1 && audience[0] === record.resource;
  };
  return async (
    token: string,
    claims: Readonly<Record<string, unknown>>,
    confirmAuthentication: () => Promise<boolean>,
  ) => {
    const hash = createHash("sha256").update(token).digest("hex");
    let validUntil: number | undefined;
    const granted = await ports.observe(hash, async (snapshot) => {
      if (
        snapshot.sessionExpiresAt === undefined ||
        !Number.isFinite(snapshot.sessionExpiresAt) ||
        snapshot.sessionExpiresAt <= clock() ||
        !matches(snapshot.record, claims)
      )
        return false;
      if (!(await confirmAuthentication())) return false;
      if (!matches(snapshot.record, claims)) return false;
      validUntil = Math.min(snapshot.record.expiresAt, snapshot.sessionExpiresAt);
      return validUntil > clock();
    });
    // Row locks do not stop time. Neither authentication nor commit waiting may
    // extend the grant or the approving session's explicit deadline.
    return granted && validUntil !== undefined && validUntil > clock();
  };
}
