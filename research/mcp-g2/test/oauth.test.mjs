import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthFixture } from "./fixtures/oauth.mjs";

test("real MySQL OAuth public PKCE authorization shares existing admin session without JWT keys", async (t) => {
  const f = await oauthFixture();
  t.after(() => f.close());
  assert.ok(f.client.client_id);
  assert.ok(f.migrationSql.includes("mcp_oauth_client"));
  const attempt = await f.authorize();
  assert.equal(attempt.response.status, 302);
  assert.ok(attempt.response.headers.get("location")?.includes("consent"));
  const approval = await f.consent(attempt);
  assert.ok(approval.code);
  assert.equal(approval.state, attempt.state);
  const response = await f.token(approval.code, attempt.verifier);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.access_token);
  assert.equal(payload.refresh_token, undefined);
  assert.equal(payload.access_token.split(".").length === 3, false);
  const unauthorizedIntrospection = await f.introspect(payload.access_token);
  assert.equal(unauthorizedIntrospection.response.status, 401);
  const live = await f.validate(payload.access_token);
  assert.equal(live.active, true);
  assert.equal(live.client_id, f.client.client_id);
  assert.ok([live.aud].flat().includes(f.resource));
  const [tables] = await f.pool.query("SHOW TABLES");
  assert.ok(!tables.some((row) => Object.values(row).includes("jwks")));
  for (const row of tables) {
    const name = String(Object.values(row)[0]);
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("G2_TABLE_IDENTIFIER_INVALID");
    const [rows] = await f.pool.query(`SELECT * FROM \`${name}\``);
    const stored = JSON.stringify(rows);
    assert.equal(stored.includes(payload.access_token), false, `raw OAuth token in ${name}`);
    assert.equal(stored.includes(approval.code), false, `raw authorization code in ${name}`);
    assert.equal(stored.includes(f.password), false, `raw password in ${name}`);
  }
  assert.notEqual((await f.token(approval.code, attempt.verifier)).status, 200);
});
