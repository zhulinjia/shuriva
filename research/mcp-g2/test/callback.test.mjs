import assert from "node:assert/strict";
import { test } from "node:test";
import { CallbackApprovals } from "../dist/callback.js";

const context = {
  ownerId: "actual-owner",
  sessionId: "actual-session",
  connectionId: "connection",
};
const request = {
  ...context,
  issuer: "https://issuer.invalid/auth",
  resource: "https://resource.invalid/mcp",
  redirectUri: "https://platform.invalid/mcp/callback",
};
function callback(state) {
  const url = new URL(request.redirectUri);
  url.search = new URLSearchParams({ state, code: "synthetic-code", iss: request.issuer });
  return url;
}

test("callback binds owner/session/connection/issuer/redirect and consumes only once", async () => {
  const approvals = new CallbackApprovals(async () => true);
  const state = await approvals.begin(request);
  const accepted = await approvals.consume(callback(state).href, context);
  assert.equal(accepted.resource, request.resource);
  assert.equal(accepted.authorizationResponseIssuer, request.issuer);
  await assert.rejects(
    () => approvals.consume(callback(state).href, context),
    /MCP_CALLBACK_REJECTED/,
  );
  for (const change of [
    "state",
    "issuer",
    "duplicate",
    "destination",
    "owner",
    "session",
    "connection",
  ]) {
    const fresh = await approvals.begin(request),
      url = callback(fresh),
      current = { ...context };
    if (change === "state") url.searchParams.set("state", "wrong");
    if (change === "issuer") url.searchParams.set("iss", "https://wrong.invalid");
    if (change === "duplicate") url.searchParams.append("state", fresh);
    if (change === "destination") url.hostname = "wrong.invalid";
    if (change === "owner") current.ownerId = "other";
    if (change === "session") current.sessionId = "other";
    if (change === "connection") current.connectionId = "other";
    await assert.rejects(() => approvals.consume(url.href, current), /MCP_CALLBACK_REJECTED/);
  }
});

test("callback expires, rejects revoked sessions, and concurrent callbacks cannot exchange twice", async () => {
  let now = 1000,
    active = true;
  const approvals = new CallbackApprovals(
    async () => active,
    () => now,
  );
  const state = await approvals.begin(request);
  now += 300001;
  await assert.rejects(
    () => approvals.consume(callback(state).href, context),
    /MCP_CALLBACK_REJECTED/,
  );
  const second = await approvals.begin(request);
  active = false;
  await assert.rejects(
    () => approvals.consume(callback(second).href, context),
    /MCP_CALLBACK_SESSION_REJECTED/,
  );
  let release, entered;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const race = new CallbackApprovals(async () => {
    if (++calls > 1) {
      entered();
      await pause;
    }
    return true;
  });
  const third = await race.begin(request);
  const first = race.consume(callback(third).href, context);
  await waiting;
  await assert.rejects(() => race.consume(callback(third).href, context), /MCP_CALLBACK_REJECTED/);
  release();
  await first;
});

test("custom schemes are disabled and a session check cannot extend a callback past expiry", async () => {
  let now = 0,
    checks = 0;
  const approvals = new CallbackApprovals(
    async () => {
      if (++checks > 1) now = 300001;
      return true;
    },
    () => now,
  );
  await assert.rejects(
    () => approvals.begin({ ...request, redirectUri: "app://trusted/callback" }),
    /MCP_CALLBACK_CONFIG_REJECTED/,
  );
  const state = await approvals.begin(request);
  await assert.rejects(
    () => approvals.consume(callback(state).href, context),
    /MCP_CALLBACK_REJECTED/,
  );
});

test("query-bearing resources remain exact while issuer and callback queries are rejected", async () => {
  const approvals = new CallbackApprovals(async () => true);
  const resource = `${request.resource}?tenant=A`;
  const state = await approvals.begin({ ...request, resource });
  assert.equal((await approvals.consume(callback(state).href, context)).resource, resource);
  for (const invalid of [
    { issuer: `${request.issuer}?tenant=A` },
    { redirectUri: `${request.redirectUri}?tenant=A` },
  ]) {
    await assert.rejects(
      () => approvals.begin({ ...request, ...invalid }),
      /MCP_CALLBACK_CONFIG_REJECTED/,
    );
  }
});
