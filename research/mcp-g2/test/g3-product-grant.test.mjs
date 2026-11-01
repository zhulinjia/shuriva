import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { authSessionReferenceDeadline } from "../../../apps/community-api/dist/src/auth.js";
import { createMcpGrantAuthority } from "../../../apps/community-api/dist/src/mcp/grant-authority.js";
import { mysqlMcpGrantObservation } from "../../../apps/community-api/dist/src/mcp/mysql-grant-observation.js";
import { createMcpOAuthOptions } from "../../../apps/community-api/dist/src/mcp/oauth-config.js";
import { createMcpResourceVerifier } from "../../../apps/community-api/dist/src/mcp/resource-verifier.js";
import { oauthFixture } from "./fixtures/oauth.mjs";

function productFixture(wrapObservation = (value) => value, onFinalCheck = () => {}) {
  return oauthFixture({
    oauthOptionsFactory: ({ resource }) =>
      createMcpOAuthOptions({
        resource,
        loginPage: "/login",
        consentPage: "/consent",
      }),
    extensionPlugins: ({ oauthOptions, db, issuer, resource }) => {
      const authority = createMcpGrantAuthority(
        wrapObservation(mysqlMcpGrantObservation(db.pool, authSessionReferenceDeadline)),
        issuer,
        resource,
      );
      return [
        createMcpResourceVerifier(oauthOptions, (token, claims, confirm) =>
          authority(token, claims, () => {
            onFinalCheck();
            return confirm();
          }),
        ),
      ];
    },
  });
}

test("G3 OAuth configuration enforces PKCE, redirect registration and disables dynamic registration", async (t) => {
  const f = await productFixture();
  t.after(() => f.close());
  for (const change of [
    { code_challenge_method: "plain" },
    { code_challenge: "", code_challenge_method: "" },
    { redirect_uri: "http://127.0.0.1:19493/callback" },
    { scope: "not:permitted" },
  ]) {
    const result = await f.authorize(change);
    const location = result.response.headers.get("location");
    assert.ok(
      result.response.status >= 400 ||
        (location && new URL(location, f.origin).searchParams.has("error")),
    );
  }
  for (const cookie of [undefined, f.identity.cookie]) {
    const registration = await f.provider.handler(
      new Request(`${f.origin}/api/auth/oauth2/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie, origin: f.origin } : {}),
        },
        body: JSON.stringify({
          client_name: "synthetic-registration",
          redirect_uris: ["http://127.0.0.1:19492/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    assert.equal(registration.status, 403);
    const denial = await registration.json();
    assert.equal(denial.error, "access_denied");
    assert.equal(denial.error_description, "Client registration is disabled");
  }
});

test("G3 authorization timeout releases real grant locks and rejects late decisions", async (t) => {
  const f = await productFixture();
  let release = () => {};
  t.after(async () => {
    release();
    await f.close();
  });
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  let entered = () => {};
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const writer = await f.pool.getConnection();
  t.after(() => writer.destroy());
  await writer.query("SET SESSION innodb_lock_wait_timeout = 10");
  const [ids] = await writer.query("SELECT CONNECTION_ID() AS id");
  const writerId = ids[0].id;
  const observation = mysqlMcpGrantObservation(f.pool, authSessionReferenceDeadline, 3000);
  const pending = observation.observe(
    createHash("sha256").update(token).digest("hex"),
    async (snapshot) => {
      assert.ok(snapshot.grant && snapshot.sessionExpiresAt > Date.now());
      entered();
      await gate;
      return true;
    },
  );
  const timedOut = assert.rejects(() => pending, /MCP_GRANT_DEADLINE_EXCEEDED/);
  await Promise.race([
    waiting,
    pending.then(
      () => {
        throw new Error("observation finished before gate");
      },
      (error) => {
        throw error;
      },
    ),
  ]);
  const update = writer.execute("UPDATE mcp_grant SET generation=generation+1 WHERE id=?", [
    f.grants.grantId,
  ]);
  const stop = Date.now() + 1500;
  let waitingForLock = false;
  while (Date.now() < stop && !waitingForLock) {
    const [rows] = await f.pool.execute(
      "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?",
      [writerId],
    );
    waitingForLock = Number(rows[0].n) > 0;
    if (!waitingForLock) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(waitingForLock, true, "writer never entered the MySQL row-lock wait");
  await timedOut;
  const [result] = await Promise.race([
    update,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("grant lock not released")), 2000),
    ),
  ]);
  assert.equal(result.affectedRows, 1);
  release();
});

test("G3 MySQL bounds a blocked session metadata lock on the server", async (t) => {
  const f = await productFixture();
  t.after(() => f.close());
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  const locker = await f.pool.getConnection();
  t.after(() => locker.destroy());
  await locker.query("LOCK TABLES session WRITE");
  let reveal = () => {};
  const connectionId = new Promise((resolve) => {
    reveal = resolve;
  });
  const pool = {
    getConnection: async () => {
      const c = await f.pool.getConnection();
      const [rows] = await c.query("SELECT CONNECTION_ID() AS id");
      reveal(rows[0].id);
      return c;
    },
  };
  const observation = mysqlMcpGrantObservation(pool, authSessionReferenceDeadline, 5000);
  const pending = observation.observe(
    createHash("sha256").update(token).digest("hex"),
    async () => true,
  );
  const failed = assert.rejects(
    () => pending,
    (error) => error.code === "ER_LOCK_WAIT_TIMEOUT",
  );
  const observerId = await connectionId;
  const stop = Date.now() + 1200;
  let waiting = false;
  while (Date.now() < stop && !waiting) {
    const [rows] = await f.pool.execute(
      "SELECT PROCESSLIST_STATE AS state FROM performance_schema.threads WHERE PROCESSLIST_ID=?",
      [observerId],
    );
    waiting = rows.some((row) => row.state === "Waiting for table metadata lock");
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(waiting, true, "observer never entered the metadata lock wait");
  await failed;
  await locker.query("UNLOCK TABLES");
  const [updated] = await f.pool.execute(
    "UPDATE mcp_grant SET generation=generation+1 WHERE id=?",
    [f.grants.grantId],
  );
  assert.equal(updated.affectedRows, 1);
});

test("G3 MySQL bounds an observer waiting on an InnoDB row lock", async (t) => {
  const f = await productFixture();
  t.after(() => f.close());
  const attempt = await f.authorize(),
    consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  const locker = await f.pool.getConnection();
  t.after(() => locker.destroy());
  await locker.beginTransaction();
  await locker.execute("UPDATE mcp_grant SET generation=generation WHERE id=?", [f.grants.grantId]);
  let reveal = () => {};
  const connectionId = new Promise((resolve) => {
    reveal = resolve;
  });
  const pool = {
    getConnection: async () => {
      const c = await f.pool.getConnection();
      const [rows] = await c.query("SELECT CONNECTION_ID() AS id");
      reveal(rows[0].id);
      return c;
    },
  };
  const observation = mysqlMcpGrantObservation(pool, authSessionReferenceDeadline, 5000);
  const pending = observation.observe(
    createHash("sha256").update(token).digest("hex"),
    async () => true,
  );
  const failed = assert.rejects(
    () => pending,
    (error) => error.code === "ER_LOCK_WAIT_TIMEOUT",
  );
  const observerId = await connectionId,
    stop = Date.now() + 1200;
  let waiting = false;
  while (Date.now() < stop && !waiting) {
    const [rows] = await f.pool.execute(
      "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?",
      [observerId],
    );
    waiting = Number(rows[0].n) > 0;
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(waiting, true, "observer never entered the InnoDB row-lock wait");
  await failed;
  await locker.rollback();
});

test("G3 production grant boundary uses the real SDK and rejects an orphan after logout", async (t) => {
  const f = await productFixture();
  t.after(() => f.close());
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  const result = await f.provider.api.verifyMcpResourceToken({ body: { token } });
  assert.equal(result.id, f.grants.grantId);
  assert.equal(result.ownerId, f.identity.userId);
  assert.deepEqual(result.scopes, ["metadata:read"]);
  assert.equal(JSON.stringify(result).includes(token), false);
  const canary = "synthetic-private-invalid-token";
  await assert.rejects(
    () => f.provider.api.verifyMcpResourceToken({ body: { token: canary } }),
    (error) => error.statusCode === 401 && !JSON.stringify(error).includes(canary),
  );
  await f.auth.api.signOut({ headers: f.headers });
  await assert.rejects(
    () => f.provider.api.verifyMcpResourceToken({ body: { token } }),
    (error) => error.statusCode === 401,
  );
});

test("G3 grant generation advance alone denies an otherwise valid SDK token", async (t) => {
  const f = await productFixture();
  t.after(() => f.close());
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  assert.equal(
    (await f.provider.api.verifyMcpResourceToken({ body: { token } })).id,
    f.grants.grantId,
  );
  await f.grants.advance();
  assert.ok(await f.sessions.authenticate({ cookie: f.identity.cookie }));
  await assert.rejects(
    () => f.provider.api.verifyMcpResourceToken({ body: { token } }),
    (error) => error.statusCode === 401,
  );
});

test("G3 final SDK check observes token revocation while grant and session are locked", async (t) => {
  let entered,
    release,
    decisionStarted = false,
    finalChecks = 0;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await productFixture(
    (base) => ({
      observe: (hash, decide) =>
        base.observe(hash, async (snapshot) => {
          assert.ok(snapshot.grant && !snapshot.grant.revoked);
          assert.ok(snapshot.sessionExpiresAt > Date.now());
          assert.equal(snapshot.grant.generation, snapshot.grant.tokenGeneration);
          entered();
          await gate;
          decisionStarted = true;
          return decide(snapshot);
        }),
    }),
    () => {
      finalChecks++;
    },
  );
  t.after(async () => {
    release();
    await f.close();
  });
  const attempt = await f.authorize();
  const consent = await f.consent(attempt);
  const response = await f.token(consent.code, attempt.verifier);
  const token = (await response.json()).access_token;
  const pending = f.provider.api.verifyMcpResourceToken({ body: { token } });
  const denied = assert.rejects(
    () => pending,
    (error) => error.statusCode === 401,
  );
  await Promise.race([
    waiting,
    pending.then(
      () => {
        throw new Error("verification completed before reaching gate");
      },
      (error) => {
        throw new Error("verification failed before reaching gate", { cause: error });
      },
    ),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("verification gate timed out")), 3000);
      timer.unref();
    }),
  ]);
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
  await denied;
  assert.equal(decisionStarted, true);
  assert.equal(finalChecks, 1);
});
