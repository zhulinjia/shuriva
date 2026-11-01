import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { resetOnlyAdminPassword } from "../../../apps/community-api/dist/src/reset-password.js";
import { oauthFixture } from "./fixtures/oauth.mjs";

async function issued(f) {
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

test("OAuth rejects PKCE, callback, client and resource mismatches without weakening valid exchange", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  for (const change of [
    { code_verifier: randomBytes(32).toString("base64url") },
    { resource: `${f.origin}/other` },
    { client_id: "unregistered-client" },
    { redirect_uri: "http://127.0.0.1:19493/callback" },
  ]) {
    const attempt = await f.authorize();
    const consent = await f.consent(attempt);
    const response = await f.token(consent.code, attempt.verifier, change);
    assert.notEqual(response.status, 200);
  }
  const token = await issued(f);
  assert.equal((await f.validate(token)).active, true);
  for (const [resource, issuer, scope] of [
    [`${f.origin}/other`, `${f.origin}/api/auth`, "metadata:read"],
    [f.resource, "https://other-issuer.invalid", "metadata:read"],
    [f.resource, `${f.origin}/api/auth`, "query:prepare"],
  ])
    await assert.rejects(() => f.validateWith(token, resource, issuer, scope));
  await assert.rejects(() => f.validate("invalid-token"));
});

test("unknown scopes/resources, no S256, DCR, refresh and machine grants remain disabled", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  for (const change of [
    { scope: "unknown:scope" },
    { resource: `${f.origin}/other` },
    { code_challenge_method: "plain" },
    { code_challenge: "", code_challenge_method: "" },
    { redirect_uri: "http://127.0.0.1:19493/callback" },
  ]) {
    const result = await f.authorize(change);
    const location = result.response.headers.get("location");
    assert.ok(
      result.response.status >= 400 ||
        (location &&
          !new URL(location, f.origin).pathname.includes("consent") &&
          new URL(location, f.origin).searchParams.has("error")),
    );
  }
  for (const grant_type of ["client_credentials", "refresh_token"]) {
    const response = await f.provider.handler(
      new Request(`${f.origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type,
          client_id: f.client.client_id,
          refresh_token: "invalid",
        }),
      }),
    );
    assert.notEqual(response.status, 200);
  }
  const registration = await f.provider.handler(
    new Request(`${f.origin}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.notEqual(registration.status, 200);
});

for (const operation of ["sign-out", "change-password", "terminal-reset", "session-expiry"]) {
  const label = `actual existing administrator ${operation}`;
  test(`${label} invalidates access through the independent grant authority`, async (t) => {
    const f = await oauthFixture();
    t.after(() => f.close());
    const token = await issued(f);
    assert.equal((await f.validate(token)).active, true);
    const identity = await f.sessions.authenticate({ cookie: f.identity.cookie });
    assert.ok(identity);
    const [before] = await f.pool.query("SELECT sessionId FROM mcp_oauth_access_token");
    if (operation === "sign-out") await f.auth.api.signOut({ headers: f.headers });
    else if (operation === "change-password") {
      await f.auth.api.changePassword({
        headers: f.headers,
        body: {
          currentPassword: f.password,
          newPassword: randomBytes(20).toString("hex"),
          revokeOtherSessions: true,
        },
      });
    } else if (operation === "terminal-reset")
      await resetOnlyAdminPassword(f.pool, randomBytes(20).toString("hex"));
    else
      await f.pool.execute(
        "UPDATE session SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
        [identity.sessionId],
      );
    assert.equal(await f.sessions.active(identity), false);
    const checks = f.sdkValidated();
    await assert.rejects(() => f.validate(token));
    if (["sign-out", "terminal-reset"].includes(operation)) {
      const [rows] = await f.pool.query("SELECT sessionId FROM mcp_oauth_access_token");
      assert.equal(
        rows[0].sessionId,
        null,
        "the nullable SDK association does not preserve the deleted approval",
      );
      assert.equal(
        f.sdkValidated(),
        checks + 1,
        "the application must reject SDK-active orphan tokens",
      );
      await writeFile(
        new URL(`../../../.cache/stage9-g2-session-${operation}.json`, import.meta.url),
        JSON.stringify({
          sdkSessionBoundBefore: before[0].sessionId === identity.sessionId,
          sdkSessionNullAfter: rows[0].sessionId === null,
          sdkPassedValidation: true,
          applicationDenied: true,
        }),
      );
    }
  });
}

test("opaque expiry and SDK schema draft are observed in this isolated MySQL only", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  const token = await issued(f);
  await f.pool.query(
    "UPDATE mcp_oauth_access_token SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)",
  );
  await assert.rejects(() => f.validate(token));
  await writeFile(
    new URL("../../../.cache/stage9-g2-oauth-generated.sql", import.meta.url),
    f.migrationSql,
  );
  const [rows] = await f.pool.query(
    "SELECT @@version AS version,@@lower_case_table_names AS tableCase",
  );
  assert.equal(rows[0].tableCase, 1);
  assert.ok(String(rows[0].version).startsWith("26.7."));
});
