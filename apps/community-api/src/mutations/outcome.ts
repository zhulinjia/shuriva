import {
  MutationError,
  terminalMutationStates,
  type MutationExecution,
  type MutationState,
} from "./model.js";

/** Validated metadata for the original execution; no persistence dependencies. */
export function validateOutcome(
  state: MutationState,
  code: string | null,
  expiry: string | null,
  affectedRows: number | null,
  now: number,
): string | null {
  if (code !== null && !/^[a-z_]{1,48}$/.test(code)) throw new MutationError("INVALID");
  if (
    expiry !== null &&
    (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) > now + 86430000)
  )
    throw new MutationError("INVALID");
  if (state === "committed" && affectedRows === 0) throw new MutationError("INVALID");
  if (
    affectedRows !== null &&
    (!Number.isSafeInteger(affectedRows) ||
      affectedRows < 0 ||
      affectedRows > 100 ||
      !terminalMutationStates.has(state))
  )
    throw new MutationError("INVALID");
  return expiry === null ? null : new Date(expiry).toISOString();
}

/** Call on the record read under its transaction's execution and scope locks. */
export function checkOutcomeTransition(
  prior: MutationExecution,
  state: MutationState,
  expiry: string | null,
  affectedRows: number | null,
): "unchanged" | "update" {
  if (
    affectedRows !== null &&
    (affectedRows > prior.rowCount ||
      (prior.affectedRows !== null && prior.affectedRows !== affectedRows))
  )
    throw new MutationError("CONFLICT");
  if (
    prior.reconciliationExpiresAt !== null &&
    expiry !== null &&
    prior.reconciliationExpiresAt !== expiry
  )
    throw new MutationError("CONFLICT");
  if (terminalMutationStates.has(prior.state)) {
    if (prior.state !== state) throw new MutationError("CONFLICT");
    return "unchanged";
  }
  if (
    prior.state === "outcome_unknown" &&
    state !== "outcome_unknown" &&
    state !== "committed" &&
    state !== "rolled_back"
  )
    throw new MutationError("CONFLICT");
  if (state === "registered" || (prior.state === "commit_intent" && state === "running"))
    throw new MutationError("CONFLICT");
  return "update";
}
