import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { MutationExecution } from "../src/mutations/model.js";
import { checkOutcomeTransition, validateOutcome } from "../src/mutations/outcome.js";

const prior = (
  state: MutationExecution["state"],
  overrides: Partial<MutationExecution> = {},
): MutationExecution => ({
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  sourceId: randomUUID(),
  connectorId: randomUUID(),
  previewId: randomUUID(),
  executionId: randomUUID(),
  confirmationId: randomUUID(),
  sessionId: randomUUID(),
  commitment: "a".repeat(43),
  revision: 1,
  apiBoot: "a".repeat(64),
  connectorBoot: "b".repeat(64),
  targetIdentity: "target",
  targetEpoch: "c".repeat(64),
  policyGeneration: "1",
  installationGeneration: "1",
  operation: "update",
  table: "orders",
  rowCount: 2,
  expiresAt: new Date().toISOString(),
  state,
  cancelRequested: false,
  permitIssued: false,
  code: null,
  reconciliationExpiresAt: null,
  affectedRows: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

test("mutation outcome validation rejects impossible counts, invalid codes and extended expiry", () => {
  const now = Date.now();
  assert.throws(() => validateOutcome("committed", null, null, 0, now), /INVALID/);
  assert.throws(() => validateOutcome("running", null, null, 1, now), /INVALID/);
  assert.throws(() => validateOutcome("committed", "secret info", null, 1, now), /INVALID/);
  assert.throws(
    () =>
      validateOutcome("outcome_unknown", null, new Date(now + 86430001).toISOString(), null, now),
    /INVALID/,
  );
  assert.equal(validateOutcome("committed", null, null, 2, now), null);
});

test("terminal facts are immutable and unknown can only transition to original reconciled outcomes", () => {
  const committed = prior("committed", { affectedRows: 1 });
  assert.equal(checkOutcomeTransition(committed, "committed", null, 1), "unchanged");
  assert.throws(() => checkOutcomeTransition(committed, "rolled_back", null, null), /CONFLICT/);
  assert.throws(() => checkOutcomeTransition(committed, "committed", null, 2), /CONFLICT/);
  const unknown = prior("outcome_unknown", { reconciliationExpiresAt: "2026-11-01T12:00:00.000Z" });
  assert.throws(() => checkOutcomeTransition(unknown, "running", null, null), /CONFLICT/);
  assert.throws(
    () => checkOutcomeTransition(unknown, "committed", "2026-11-01T12:01:00.000Z", 1),
    /CONFLICT/,
  );
  assert.equal(
    checkOutcomeTransition(unknown, "committed", unknown.reconciliationExpiresAt, 1),
    "update",
  );
  assert.throws(
    () => checkOutcomeTransition(prior("commit_intent"), "running", null, null),
    /CONFLICT/,
  );
  assert.throws(() => checkOutcomeTransition(prior("running"), "committed", null, 3), /CONFLICT/);
});
