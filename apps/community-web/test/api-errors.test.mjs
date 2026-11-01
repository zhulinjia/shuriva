import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, api } from "../src/api.ts";

test("only bounded recognized capacity and semantic responses expose a stable error code", async () => {
  const previous = globalThis.fetch;
  try {
    for (const code of ["CAPACITY", "RESULT_CAPACITY"]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: code }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      await assert.rejects(
        () => api("/fixture"),
        (error) => error instanceof ApiError && error.code === code,
      );
    }
    for (const code of ["SEMANTIC_STALE", "NO_MODEL_FIELDS", "SEMANTICS_TOO_LARGE"]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: code }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      await assert.rejects(
        () => api("/fixture"),
        (error) => error instanceof ApiError && error.code === code,
      );
    }
    for (const body of [
      '{"error":"OTHER"}',
      "not json",
      JSON.stringify({ error: "CAPACITY", padding: "x".repeat(3000) }),
    ]) {
      globalThis.fetch = async () =>
        new Response(body, { status: 503, headers: { "content-type": "application/json" } });
      await assert.rejects(
        () => api("/fixture"),
        (error) => error instanceof ApiError && error.code === undefined,
      );
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("only a bounded opaque request ID appears in a user-facing API error", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("{}", { status: 500, headers: { "x-request-id": "trace_123-ABC" } });
    await assert.rejects(
      () => api("/fixture"),
      (error) =>
        error instanceof ApiError &&
        error.requestId === "trace_123-ABC" &&
        error.message.includes("trace_123-ABC"),
    );
    globalThis.fetch = async () =>
      new Response("{}", { status: 500, headers: { "x-request-id": "x".repeat(100) } });
    await assert.rejects(
      () => api("/fixture"),
      (error) =>
        error instanceof ApiError &&
        error.requestId === undefined &&
        !error.message.includes("排查编号"),
    );
  } finally {
    globalThis.fetch = previous;
  }
});
