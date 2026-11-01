import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/api.ts";
import {
  hasUnsavedModelChanges,
  setSettingsWritePending,
  settingsFailure,
  settingsWritePending,
} from "../src/model-settings.ts";
import { withRequestTimeout } from "../src/models/model-session.ts";

const saved = { configured: true, baseUrl: "http://127.0.0.1:3374/v1", model: "example" };

test("connection checks require the form to match the saved destination and have no new key", () => {
  assert.equal(hasUnsavedModelChanges(saved, saved.baseUrl, saved.model, ""), false);
  assert.equal(hasUnsavedModelChanges(saved, "http://127.0.0.1:1/v1", saved.model, ""), true);
  assert.equal(hasUnsavedModelChanges(saved, saved.baseUrl, "other", ""), true);
  assert.equal(hasUnsavedModelChanges(saved, saved.baseUrl, saved.model, "replacement"), true);
});

test("rate-limited checks explain when to retry without exposing provider errors", () => {
  assert.match(settingsFailure("check", new ApiError(429, "untrusted"), false).message, /5 秒/);
  assert.match(settingsFailure("check", new Error("private-token"), false).message, /连接未完成/);
  assert.doesNotMatch(
    settingsFailure("check", new Error("private-token"), false).message,
    /private-token/,
  );
});

test("a changed server configuration requires a fresh read before checking again", () => {
  assert.match(settingsFailure("check", new ApiError(409, "stale"), false).message, /重新读取配置/);
});

test("a write interrupted by navigation leaves an uncertainty marker without storing credentials", () => {
  const stored = new Map();
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  try {
    assert.equal(settingsWritePending(), false);
    setSettingsWritePending(true);
    assert.equal(settingsWritePending(), true);
    assert.deepEqual([...stored.values()], ["1"]);
    setSettingsWritePending(false);
    assert.equal(settingsWritePending(), false);
  } finally {
    globalThis.sessionStorage = previous;
  }
});

test("stalled writes settle and are described as uncertain, rather than failed or retried", async () => {
  let calls = 0;
  let underlyingSignal;
  await assert.rejects(
    withRequestTimeout(new AbortController().signal, 15, async (signal) => {
      calls++;
      underlyingSignal = signal;
      await new Promise(() => {});
    }),
    (error) => {
      for (const action of ["save", "remove"]) {
        const result = settingsFailure(action, error, false);
        assert.equal(result.uncertain, true);
        assert.match(result.message, /可能已经完成/);
        assert.match(result.message, /重新读取配置/);
      }
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(underlyingSignal.aborted, true);
});

test("a cancelled model check reports that the service may have received it", () => {
  assert.match(settingsFailure("check", new Error("cancelled"), true).message, /可能已经收到/);
});

test("a connection check timeout is reported distinctly from cancellation", () => {
  const message = settingsFailure("check", new Error("request timeout"), false).message;
  assert.match(message, /超时/);
  assert.match(message, /重试/);
  assert.doesNotMatch(message, /已取消/);
});
