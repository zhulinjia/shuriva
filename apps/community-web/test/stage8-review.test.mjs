import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  currentExecution,
  initialReview,
  mayConfirm,
  pendingExecutions,
  reviewReducer,
  reviewStage,
} from "../src/stage8-review/flow.ts";

const step = (state, event) =>
  reviewReducer(
    state,
    event.type === "TICK"
      ? { generation: state.generation, phase: state.phase, step: state.step, ...event }
      : event,
  );
function preview(scenario = "success", operation = "update") {
  let state = step(initialReview(), { type: "RESET", scenario, operation });
  state = step(state, { type: "PREVIEW" });
  return step(state, { type: "TICK", generation: state.generation });
}
function confirm(state) {
  state = step(state, { type: "OPEN_CONFIRM" });
  state = step(state, { type: "ACK", value: true });
  return step(state, { type: "CONFIRM", generation: state.generation });
}
function complete(state) {
  for (let i = 0; i < 9; i++) state = step(state, { type: "TICK" });
  return state;
}
test("review confirmation requires a valid preview and explicit intent; delete additionally requires the exact table name", () => {
  assert.equal(step(initialReview(), { type: "CONFIRM", generation: 1 }).phase, "draft");
  let state = step(preview("success", "delete"), { type: "OPEN_CONFIRM" });
  assert.equal(mayConfirm(state), false);
  state = step(state, { type: "ACK", value: true });
  state = step(state, { type: "TABLE", value: "other" });
  assert.equal(mayConfirm(state), false);
  assert.equal(step(state, { type: "CONFIRM", generation: state.generation }).phase, "confirming");
  state = step(state, { type: "TABLE", value: "demo_customers" });
  assert.equal(mayConfirm(state), true);
  state = step(state, { type: "CLOSE_CONFIRM" });
  assert.equal(state.phase, "preview");
  assert.equal(state.acknowledged, false);
  assert.equal(step(state, { type: "CONFIRM", generation: state.generation }).phase, "preview");
  assert.equal(currentExecution(state), null);
  assert.equal(state.executionRecords.length, 0);
});
test("review failure scenarios never become successful writes; unknown status checks do not execute again", () => {
  for (const scenario of [
    "changed",
    "revoked",
    "overLimit",
    "expired",
    "rollback",
    "unknown",
    "rowScope",
    "permitExpired",
  ]) {
    let state = preview(scenario);
    if (state.phase === "preview") state = confirm(state);
    state = complete(state);
    assert.notEqual(state.phase, "success");
    assert.ok(["invalid", "rolledBack", "unknown"].includes(state.phase));
    if (scenario === "overLimit" || scenario === "expired") {
      assert.equal(reviewStage(state), 1, "a refused preview must not mark confirmation completed");
    }
    if (scenario === "unknown") {
      const generation = state.generation;
      state = step(state, { type: "CHECK_RECEIPT" });
      assert.equal(state.phase, "unknown");
      assert.equal(state.generation, generation);
      assert.equal(step(state, { type: "CONFIRM", generation: state.generation }).phase, "unknown");
      const records = structuredClone(state.executionRecords);
      state = step(state, { type: "OPEN_RECOVERY" });
      assert.deepEqual(step(state, { type: "EDIT" }), state);
      assert.deepEqual(step(state, { type: "RETURN_TO_DRAFT" }), state);
      assert.deepEqual(state.executionRecords, records);
    }
  }
});

test("a refused preview creates no execution, while post-confirmation rejection keeps its registered identity", () => {
  for (const scenario of ["overLimit", "expired"]) {
    const state = preview(scenario);
    assert.equal(state.executionId, null);
    assert.equal(state.confirmationId, null);
    assert.equal(state.executionRecords.length, 0);
  }
  for (const scenario of ["changed", "revoked"]) {
    let state = confirm(preview(scenario));
    const execution = currentExecution(state);
    assert.ok(execution);
    assert.equal(execution.status, "running");
    const originalId = execution.id;
    const originalConfirmation = execution.confirmationId;
    state = complete(state);
    assert.equal(state.phase, "invalid");
    assert.equal(state.executionId, originalId);
    assert.equal(state.confirmationId, originalConfirmation);
    assert.equal(currentExecution(state)?.id, originalId);
    assert.equal(currentExecution(state)?.status, "rejected");
    assert.equal(state.executionRecords.length, 1);
  }
});

test("a lost confirmation response is reconciled with the original confirmation without another execution", () => {
  let state = confirm(preview("confirmationLost"));
  assert.equal(state.phase, "reconciling");
  assert.equal(state.executionId, null, "the response containing the execution ID was lost");
  assert.ok(state.confirmationId);
  assert.equal(state.executionRecords.length, 1);
  const original = state.executionRecords[0];
  assert.equal(original.confirmationId, state.confirmationId);
  state = step(state, { type: "CHECK_CONFIRMATION" });
  assert.equal(state.executionId, original.id);
  assert.equal(state.confirmationId, original.confirmationId);
  assert.deepEqual(state.executionRecords, [original]);
  for (let i = 0; i < 3; i++) state = step(state, { type: "CHECK_CONFIRMATION" });
  assert.deepEqual(state.executionRecords, [original], "status queries must not advance execution");
  assert.equal(state.executionId, original.id);
  assert.equal(
    step(state, { type: "CONFIRM", generation: state.generation }).executionRecords.length,
    1,
  );
});

test("a simulated page reload can discover the original execution after all page identities are lost", () => {
  let state = confirm(preview("confirmationLost"));
  const original = state.executionRecords[0];
  const staleTimer = {
    type: "TICK",
    generation: state.generation,
    phase: state.phase,
    step: state.step,
  };
  state = step(state, { type: "SIMULATE_RELOAD" });
  assert.equal(state.phase, "recovery");
  assert.equal(state.executionId, null);
  assert.equal(state.confirmationId, null);
  assert.equal(state.acknowledged, false);
  assert.equal(state.tableInput, "");
  assert.deepEqual(pendingExecutions(state), [original]);
  assert.deepEqual(
    step(state, staleTimer),
    state,
    "a page from before reload cannot advance a task",
  );
  assert.deepEqual(step(state, { type: "OPEN_EXECUTION", id: "other-task" }), state);
  state = step(state, { type: "OPEN_EXECUTION", id: original.id });
  assert.equal(state.executionId, original.id);
  assert.equal(state.confirmationId, original.confirmationId);
  assert.deepEqual(state.executionRecords, [original]);
});

test("recovery retains a completed execution even if its response was lost and the page was reloaded", () => {
  let state = confirm(preview("confirmationLost"));
  const originalId = state.executionRecords[0].id;
  state = step(state, { type: "SIMULATE_RELOAD" });
  state = complete(state);
  assert.equal(state.executionId, null);
  assert.equal(state.confirmationId, null);
  assert.equal(state.executionRecords.length, 1);
  assert.equal(state.executionRecords[0].status, "committed");
  assert.equal(pendingExecutions(state).length, 0);
  const records = structuredClone(state.executionRecords);
  state = step(state, { type: "OPEN_EXECUTION", id: originalId });
  assert.equal(state.phase, "success");
  assert.equal(state.executionId, originalId);
  assert.deepEqual(state.executionRecords, records);
  state = step(state, { type: "OPEN_RECOVERY" });
  state = step(state, { type: "OPEN_EXECUTION", id: originalId });
  assert.equal(state.executionId, originalId);
  assert.deepEqual(state.executionRecords, records);
});

test("a fresh draft invalidates a previous preview confirmation without losing earlier execution records", () => {
  let state = confirm(preview());
  const oldGeneration = state.generation;
  state = complete(state);
  const earlier = structuredClone(state.executionRecords);
  state = step(state, { type: "EDIT" });
  assert.equal(state.executionId, null);
  assert.equal(state.confirmationId, null);
  assert.equal(currentExecution(state), null);
  state = step(state, { type: "PREVIEW" });
  state = step(state, { type: "TICK" });
  state = step(state, { type: "OPEN_CONFIRM" });
  state = step(state, { type: "ACK", value: true });
  assert.equal(mayConfirm(state), true);
  assert.deepEqual(step(state, { type: "CONFIRM", generation: oldGeneration }), state);
  assert.deepEqual(state.executionRecords, earlier);
  state = step(state, { type: "CONFIRM", generation: state.generation });
  assert.equal(state.executionRecords.length, 2);
  assert.notEqual(currentExecution(state)?.id, earlier[0].id);
  assert.notEqual(currentExecution(state)?.confirmationId, earlier[0].confirmationId);
});
test("review cancellation stops before commit, cannot claim rollback during commit, and stale timers cannot advance a new demonstration", () => {
  let state = confirm(preview());
  state = step(state, { type: "CANCEL" });
  assert.equal(state.phase, "rolledBack");
  state = confirm(preview());
  for (let i = 0; i < 4; i++) state = step(state, { type: "TICK", generation: state.generation });
  assert.equal(state.step, 4);
  assert.equal(step(state, { type: "CANCEL" }).phase, "executing");
  const old = state.generation;
  state = step(state, { type: "RESET" });
  state = step(state, { type: "PREVIEW" });
  assert.equal(step(state, { type: "TICK", generation: old }).phase, "preparing");
});
test("review entry cannot import product API clients or persist/transmit data, and its server denies connections and API proxying", async () => {
  const sources = [];
  async function collectSources(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) await collectSources(file);
      else if (/\.tsx?$/.test(entry.name)) sources.push(file);
    }
  }
  await collectSources(new URL("../src/stage8-review/", import.meta.url));
  assert.ok(sources.length > 0);
  for (const file of sources) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|sendBeacon)\b/,
    );
    assert.doesNotMatch(
      source,
      /\bfrom\s+["'][^"']*(?:\/api|query-session|model-session|history-api)["']/,
    );
  }
  const server = await readFile(
    new URL("../../../scripts/serve-stage8-review.mjs", import.meta.url),
    "utf8",
  );
  assert.match(server, /connect-src 'none'/);
  assert.match(server, /form-action 'none'/);
  assert.match(server, /127\.0\.0\.1/);
  assert.doesNotMatch(server, /DATABASE_URL|BETTER_AUTH_SECRET|fetch\(/);
  const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(main, /stage8-review/);
});
