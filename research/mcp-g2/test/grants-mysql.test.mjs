import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthFixture } from "./fixtures/oauth.mjs";

test("authorization storage errors are normalized before SDK endpoint error delivery", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  const canary = "synthetic-private-adapter-details";
  f.grants.pauseBeforeSession(async () => {
    throw new Error(canary);
  });
  await assert.rejects(
    () => f.validate(token),
    (error) => error.statusCode === 503 && !JSON.stringify(error).includes(canary),
  );
  f.grants.pauseBeforeSession(undefined);
  assert.equal((await f.validate(token)).active, true);
});

test("MySQL grant rollback, concurrent revocation, immutable approval and hashed-token uniqueness", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  assert.equal((await f.validate(token)).active, true);
  const connection = await f.pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE mcp_grant SET generation=generation+1 WHERE id=?", [
      f.grants.grantId,
    ]);
    await connection.rollback();
  } finally {
    connection.release();
  }
  assert.equal((await f.validate(token)).active, true);
  const duplicates = await Promise.allSettled([
    f.grants.register(token, 1),
    f.grants.register(token, 1),
  ]);
  assert.ok(duplicates.every((value) => value.status === "rejected"));
  await Promise.all([f.grants.revoke(), f.grants.revoke()]);
  const [rows] = await f.pool.execute(
    "SELECT generation,approvalSessionId FROM mcp_grant WHERE id=?",
    [f.grants.grantId],
  );
  assert.equal(Number(rows[0].generation), 3);
  const identity = await f.sessions.authenticate({ cookie: f.identity.cookie });
  assert.equal(rows[0].approvalSessionId, identity.sessionId);
  const checked = f.sdkValidated();
  await assert.rejects(() => f.validate(token));
  assert.equal(f.sdkValidated(), checked + 1);
});

test("old authorization-code approval cannot acquire a later generation while its session stays active", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  await f.grants.advance();
  assert.ok(await f.sessions.authenticate({ cookie: f.identity.cookie }));
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error_description, "MCP_APPROVAL_STALE");
  const [rows] = await f.pool.query("SELECT COUNT(*) total FROM mcp_grant_token");
  assert.equal(Number(rows[0].total), 0);
});

test("generation advance alone invalidates a token while the real approval session remains active", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  const identity = await f.sessions.authenticate({ cookie: f.identity.cookie });
  assert.equal(await f.sessions.active(identity), true);
  assert.equal((await f.validate(token)).active, true);
  await f.grants.advance();
  assert.equal(await f.sessions.active(identity), true);
  await assert.rejects(() => f.validate(token));
});

test("actual session deletion between SDK validation and locked session observation cannot pass", async (t) => {
  const f = await oauthFixture();
  let release, entered;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  t.after(async () => {
    release();
    await f.close();
  });
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  f.grants.pauseBeforeSession(async () => {
    entered();
    await paused;
  });
  const validating = f.validate(token);
  const denied = assert.rejects(() => validating);
  await waiting;
  await f.auth.api.signOut({ headers: f.headers });
  release();
  await denied;
  f.grants.pauseBeforeSession(undefined);
});

test("cached SDK consent cannot approve a new generation; explicit consent can renew it", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const first = await f.authorize();
  await f.consent(first);
  await f.grants.advance();
  assert.ok(await f.sessions.authenticate({ cookie: f.identity.cookie }));
  const cached = await f.authorize();
  const cachedCode = new URL(cached.response.headers.get("location")).searchParams.get("code");
  assert.ok(cachedCode, "exercise the SDK's actual cached-consent path");
  await assert.rejects(() => f.consent(cached), /G2_REAPPROVAL_REQUIRED/);
  assert.equal((await f.token(cachedCode, cached.verifier)).status, 400);
  const renewed = await f.authorize({ prompt: "consent" });
  const approval = await f.consent(renewed);
  const response = await f.token(approval.code, renewed.verifier);
  assert.equal(response.status, 200);
  assert.equal((await f.validate((await response.json()).access_token)).active, true);
});

test("expired unexchanged code bindings release capacity for later approvals", async (t) => {
  let now = Date.now();
  const f = await oauthFixture({ approvalClock: () => now });
  t.after(() => f.close());
  for (let index = 0; index < 16; index++) await f.consent(await f.authorize());
  await assert.rejects(async () => f.consent(await f.authorize()), /G2_APPROVAL_BINDING_REQUIRED/);
  now += 300001;
  const renewed = await f.authorize();
  const approval = await f.consent(renewed);
  const response = await f.token(approval.code, renewed.verifier);
  assert.equal(response.status, 200);
  assert.equal((await f.validate((await response.json()).access_token)).active, true);
});

test("SDK token revocation during eight locked grant checks is observed without pool starvation", async (t) => {
  const f = await oauthFixture();
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  let validators = [];
  t.after(async () => {
    release();
    await Promise.allSettled(validators);
    await f.close();
  });
  const attempt = await f.authorize(),
    approval = await f.consent(attempt);
  const response = await f.token(approval.code, attempt.verifier);
  const token = (await response.json()).access_token;
  let observing = 0;
  f.grants.pauseBeforeSession(async () => {
    if (++observing === 8) entered();
    await gate;
  });
  validators = Array.from({ length: 8 }, () =>
    assert.rejects(
      () => f.validate(token),
      (error) => error.statusCode === 401,
    ),
  );
  await waiting;
  const revoked = await f.provider.handler(
    new Request(`${f.origin}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        client_id: f.client.client_id,
        token_type_hint: "access_token",
      }),
    }),
  );
  assert.equal(revoked.status, 200);
  release();
  await Promise.all(validators);
  assert.equal(observing, 8);
});

test("a token expiring during asynchronous grant validation cannot return active", async (t) => {
  let now = Date.now();
  const f = await oauthFixture({ resourceClock: () => now });
  t.after(() => f.close());
  const attempt = await f.authorize(),
    approval = await f.consent(attempt);
  const response = await f.token(approval.code, attempt.verifier);
  const token = (await response.json()).access_token;
  const claims = await f.validate(token);
  assert.equal(typeof claims.exp, "number");
  f.grants.pauseBeforeSession(async () => {
    now = claims.exp * 1000;
  });
  await assert.rejects(
    () => f.validate(token),
    (error) => error.statusCode === 401,
  );
});

test("approval session expiry while final authentication is awaited cannot return active", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    approval = await f.consent(attempt);
  const response = await f.token(approval.code, attempt.verifier);
  const token = (await response.json()).access_token;
  const identity = await f.sessions.authenticate({ cookie: f.identity.cookie });
  // Fault injection into this owned synthetic session, matching the existing
  // session-expiry fixture; no product or original database is involved.
  await f.pool.execute(
    "UPDATE session SET expiresAt=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 SECOND) WHERE id=?",
    [identity.sessionId],
  );
  assert.equal(await f.sessions.active(identity), true);
  let hookReached = false;
  f.grants.pauseAfterConfirmation(async (accepted) => {
    hookReached = true;
    assert.equal(accepted, true, "SDK and first locked session observation must initially accept");
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });
  await assert.rejects(
    () => f.validate(token),
    (error) => error.statusCode === 401,
  );
  assert.equal(
    hookReached,
    true,
    "the test must cross expiry after a successful final authentication",
  );
  assert.equal(await f.sessions.active(identity), false);
});

test("stale broad consent cannot alter current cached scopes when code-binding capacity is full", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const stale = await f.authorize({ prompt: "consent", scope: "metadata:read query:prepare" });
  await f.grants.advance();
  const current = await f.authorize({ prompt: "consent", scope: "metadata:read" });
  const approval = await f.consent(current);
  for (let index = 0; index < 15; index++) await f.consent(await f.authorize());
  await assert.rejects(() => f.consent(stale), /G2_APPROVAL_STALE/);
  assert.equal((await f.token(approval.code, current.verifier)).status, 200);
  const broader = await f.authorize({ scope: "metadata:read query:prepare" });
  const destination = new URL(broader.response.headers.get("location"), f.origin);
  assert.equal(
    destination.searchParams.has("code"),
    false,
    "stale approval must not broaden the SDK's current consent",
  );
  const explicit = await f.consent(broader);
  const response = await f.token(explicit.code, broader.verifier);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.scope.split(" ").includes("query:prepare"));
  assert.equal((await f.validate(payload.access_token)).active, true);
});
