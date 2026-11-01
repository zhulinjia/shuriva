import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitAndRefresh,
  pollSerial,
  SourceState,
  shouldClearSnapshot,
  sourceViewKey,
  sourceViewReady,
} from "../src/datasources/source-state.ts";

test("a late response cannot replace the selected workspace bindings", () => {
  const state = new SourceState();
  state.select("workspace-a");
  const old = state.bindings("workspace-a");
  state.select("workspace-b");
  const current = state.bindings("workspace-b");
  assert.equal(state.acceptsBindings("workspace-b", current), true);
  assert.equal(state.acceptsBindings("workspace-a", old), false);
  assert.equal(state.bindings("workspace-a"), -1);
  assert.equal(state.acceptsBindings("workspace-b", current), true);
});

test("unbinding invalidates an in-flight snapshot but other bindings do not", () => {
  const state = new SourceState();
  state.select("workspace-a");
  const request = state.beginSnapshot("source-a");
  state.updateBindings(["source-a", "source-b"], ["source-a", "source-b"]);
  assert.equal(state.acceptsSnapshot(request), true);
  state.updateBindings(["source-b"], ["source-b"]);
  assert.equal(state.acceptsSnapshot(request), true);
  state.updateBindings(["source-a", "source-b"], ["source-b"]);
  assert.equal(state.acceptsSnapshot(request), false);
});

test("changing workspace invalidates snapshot even if source IDs match", () => {
  const state = new SourceState();
  state.select("workspace-a");
  const request = state.beginSnapshot("source-a");
  state.select("workspace-b");
  state.updateBindings(["source-a"], ["source-a"]);
  assert.equal(state.acceptsSnapshot(request), false);
});

test("a queued snapshot selection is cleared only when its source was checked", () => {
  assert.equal(shouldClearSnapshot("new-selection", ["old-selection"], []), false);
  assert.equal(shouldClearSnapshot("new-selection", ["new-selection"], ["new-selection"]), false);
  assert.equal(shouldClearSnapshot("new-selection", ["new-selection"], []), true);
});

test("slow polling waits for completion before scheduling the next request", async () => {
  let finish;
  let scheduled;
  let calls = 0;
  const stop = pollSerial(
    () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    (callback) => {
      scheduled = callback;
      return 1;
    },
    () => {},
  );
  assert.equal(calls, 1);
  assert.equal(scheduled, undefined);
  finish();
  await Promise.resolve();
  assert.equal(typeof scheduled, "function");
  scheduled();
  assert.equal(calls, 2);
  stop();
  finish();
  await Promise.resolve();
});

test("a previously loaded page stays hidden after changing filter or page, including on failure", () => {
  const loaded = sourceViewKey(false, "");
  assert.equal(sourceViewReady(loaded, sourceViewKey(false, "")), true);
  const archived = sourceViewKey(true, "");
  const secondPage = sourceViewKey(false, "cursor-1");
  assert.equal(sourceViewReady(loaded, archived), false);
  assert.equal(sourceViewReady(loaded, secondPage), false);
  // A failed request leaves the previously loaded key unchanged.
  assert.equal(sourceViewReady(loaded, archived), false);
  assert.equal(sourceViewReady(archived, archived), true);
});

test("successful write remains distinguishable from failed refresh, even if another reload resolves later", async () => {
  let finishSlow;
  const slow = new Promise((resolve) => {
    finishSlow = resolve;
  });
  let committed = false;
  const result = await commitAndRefresh(
    async () => {
      committed = true;
    },
    () => Promise.all([slow, Promise.reject(new Error("binding unavailable"))]),
  );
  assert.equal(committed, true);
  assert.equal(result, "refresh-failed");
  finishSlow();
  await slow;
  await assert.rejects(
    () =>
      commitAndRefresh(
        async () => {
          throw new Error("write failed");
        },
        async () => {},
      ),
    /write failed/,
  );
});
