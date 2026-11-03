import type { Confirmation } from "./model";

/** Tab-scoped metadata only. Storage is never authority or evidence of a result. */
export type ChangeRecovery = {
  invocationId: string | null;
  workspaceId: string;
  sourceId: string;
  confirmation: Confirmation;
};

const key = "shuriva.mcp.pending-confirmation.v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commitment = /^[A-Za-z0-9_-]{43}$/;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function parseRecovery(data: unknown): ChangeRecovery {
  if (
    !exact(data, ["invocationId", "workspaceId", "sourceId", "confirmation"]) ||
    (data.invocationId !== null &&
      (typeof data.invocationId !== "string" || !uuid.test(data.invocationId))) ||
    typeof data.workspaceId !== "string" ||
    !uuid.test(data.workspaceId) ||
    typeof data.sourceId !== "string" ||
    !uuid.test(data.sourceId) ||
    !exact(data.confirmation, ["confirmationId", "previewId", "commitment", "revision"])
  )
    throw Error("RECOVERY_STORAGE_INVALID");
  const pending = data.confirmation;
  if (
    typeof pending.confirmationId !== "string" ||
    !uuid.test(pending.confirmationId) ||
    typeof pending.previewId !== "string" ||
    !uuid.test(pending.previewId) ||
    typeof pending.commitment !== "string" ||
    !commitment.test(pending.commitment) ||
    typeof pending.revision !== "number" ||
    !Number.isSafeInteger(pending.revision) ||
    pending.revision < 1 ||
    pending.revision > 4294967295
  )
    throw Error("RECOVERY_STORAGE_INVALID");
  return {
    invocationId: data.invocationId,
    workspaceId: data.workspaceId,
    sourceId: data.sourceId,
    confirmation: {
      confirmationId: pending.confirmationId,
      previewId: pending.previewId,
      commitment: pending.commitment,
      revision: pending.revision,
    },
  };
}
export function readChangeRecovery(): ChangeRecovery | null {
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) return null;
  if (raw.length > 1024) throw Error("RECOVERY_STORAGE_INVALID");
  return parseRecovery(JSON.parse(raw) as unknown);
}
export function sameChangeRecovery(a: ChangeRecovery | null, b: ChangeRecovery): boolean {
  return (
    !!a &&
    a.invocationId === b.invocationId &&
    a.workspaceId === b.workspaceId &&
    a.sourceId === b.sourceId &&
    a.confirmation.confirmationId === b.confirmation.confirmationId &&
    a.confirmation.previewId === b.confirmation.previewId &&
    a.confirmation.commitment === b.confirmation.commitment &&
    a.confirmation.revision === b.confirmation.revision
  );
}
export function saveChangeRecovery(value: ChangeRecovery): void {
  const validated = parseRecovery(value);
  const previous = readChangeRecovery();
  if (previous && !sameChangeRecovery(previous, validated)) throw Error("RECOVERY_ALREADY_PENDING");
  window.sessionStorage.setItem(key, JSON.stringify(validated));
  if (!sameChangeRecovery(readChangeRecovery(), validated))
    throw Error("RECOVERY_STORAGE_UNAVAILABLE");
}
export function clearChangeRecovery(value: ChangeRecovery): void {
  const previous = readChangeRecovery();
  if (sameChangeRecovery(previous, value)) window.sessionStorage.removeItem(key);
}
