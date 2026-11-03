import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ExternalMcpError } from "../src/mcp-client/model.js";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { externalFixture } from "./external-mcp-fixture.js";

test("G4 actual SDK OAuth binds PKCE/state/issuer/resource/original session, has one-use callback and never invokes after callback", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  f.requireOAuth();
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "OAuth external",
    config: { ...f.httpConfig, authentication: "oauth", oauth: f.oauthConfig },
  });
  let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const attempt = await f.service.oauth.begin(c, f.identity),
    url = new URL(attempt.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), f.resource);
  assert.equal(f.stats().exchanges, 0);
  assert.equal(f.stats().calls, 0);
  await assert.rejects(
    f.service.oauth.callback({ state: "unapproved", code: "synthetic-code", iss: f.issuer }),
    /CALLBACK_REJECTED/,
  );
  const callback = {
    state: url.searchParams.get("state") ?? assert.fail("Missing OAuth state"),
    code: "synthetic-code",
    iss: f.issuer,
  };
  const once = await Promise.allSettled([
    f.service.oauth.callback(callback),
    f.service.oauth.callback(callback),
  ]);
  assert.equal(once.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    f.service.oauth.finish({ ...f.identity, sessionId: randomUUID() }, attempt.id),
    /NOT_FOUND/,
  );
  assert.equal(f.stats().exchanges, 0);
  await f.service.oauth.finish(f.identity, attempt.id);
  assert.equal(f.stats().exchanges, 1);
  assert.equal(f.stats().calls, 0);
  await assert.rejects(f.service.oauth.finish(f.identity, attempt.id), /NOT_FOUND/);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.discover(c, f.identity);
  assert.equal(f.stats().authorization, "Bearer synthetic-oauth-token");
  assert.equal(f.stats().calls, 0);
  const [rows] = await f.pool.query("SELECT config FROM external_mcp_connection");
  assert.equal(JSON.stringify(rows).includes("synthetic-oauth-token"), false);
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  await f.service.approve(
    c,
    f.identity,
    c.snapshotHash ?? assert.fail("Missing verified snapshot"),
    ["echo"],
  );
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const pending = await f.service.invocations.prepare(c, f.identity, "echo", {
    text: "never sent after rotation",
  });
  c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const again = await f.service.oauth.begin(c, f.identity),
    a = new URL(again.authorizationUrl);
  await f.service.oauth.callback({
    state: a.searchParams.get("state") ?? assert.fail("state"),
    code: "synthetic-code",
    iss: f.issuer,
  });
  await f.service.oauth.finish(f.identity, again.id);
  const rotated = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(rotated.version, c.version + 1);
  assert.notEqual(rotated.credentialRef, c.credentialRef);
  assert.deepEqual(rotated.approvedTools, []);
  await assert.rejects(
    f.service.invocations.confirm(rotated, f.identity, pending.id),
    /RECONNECT_REQUIRED|TOOL_NOT_APPROVED|CALL_NOT_FOUND|CALL_EXPIRED/,
  );
  assert.equal(f.stats().calls, 0);
});

test("G4 explicitly selected OIDC metadata works and control-plane authorization URLs are refused", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const saved = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "OIDC fixture",
    config: {
      ...f.httpConfig,
      authentication: "oauth",
      oauth: { ...f.oauthConfig, metadataUrl: `${f.issuer}/.well-known/openid-configuration` },
    },
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, saved.id);
  const a = await f.service.oauth.begin(c, f.identity);
  assert.ok(a.authorizationUrl);
  // Use the real configured control-plane port: no navigation link is produced.
  const authorizationEndpoint = `${f.origin}/authorize`;
  f.authorizeAt(authorizationEndpoint);
  const b = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Denied authorization",
    config: {
      ...f.httpConfig,
      authentication: "oauth",
      oauth: { ...f.oauthConfig, authorizationEndpoint },
    },
  });
  const bad = await f.service.connection(f.identity, f.binding.workspaceId, b.id);
  await assert.rejects(
    f.service.oauth.begin(bad, f.identity),
    /CONTROL_PLANE|DESTINATION_REJECTED/,
  );
});
test("G4 a real metadata commit with uncertain acknowledgment or revoked attempt never publishes credentials", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 40000,
}, async (t) => {
  for (const mode of ["uncertain", "revoked"] as const) {
    await t.test(mode, async () => {
      let fault:
        | ((connection: PoolConnection, commit: () => Promise<void>) => Promise<void>)
        | undefined;
      const f = await externalFixture(
        undefined,
        (pool) =>
          new Proxy(pool, {
            get(target, key) {
              if (key === "getConnection")
                return async () => {
                  const c = await pool.getConnection(),
                    commit = c.commit,
                    release = c.release;
                  c.commit = () => (fault ? fault(c, commit.bind(c)) : commit.call(c));
                  c.release = () => {
                    c.commit = commit;
                    c.release = release;
                    release.call(c);
                  };
                  return c;
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      );
      try {
        const { id } = await f.service.create(f.identity, {
          workspaceId: f.binding.workspaceId,
          name: "Publication gate",
          config: { ...f.httpConfig, authentication: "oauth", oauth: f.oauthConfig },
        });
        const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
        const a = await f.service.oauth.begin(c, f.identity),
          u = new URL(a.authorizationUrl);
        await f.service.oauth.callback({
          state: u.searchParams.get("state") ?? assert.fail("state"),
          code: "synthetic-code",
          iss: f.issuer,
        });
        let injected = false;
        fault = async (connection, commit) => {
          const [rows] = await connection.query<RowDataPacket[]>(
            "SELECT version,credentialRef FROM external_mcp_connection WHERE id=?",
            [id],
          );
          const candidate =
            !injected &&
            Number(rows[0]?.version) === c.version + 1 &&
            rows[0]?.credentialRef !== c.credentialRef;
          if (candidate) injected = true;
          await commit();
          if (candidate) {
            if (mode === "uncertain")
              throw new ExternalMcpError("EXTERNAL_MCP_STORAGE_TIMEOUT", 503);
            f.service.oauth.revoke(id);
          }
        };
        await assert.rejects(
          f.service.oauth.finish(f.identity, a.id),
          /STORAGE_TIMEOUT|OAUTH_EXPIRED/,
        );
        const current = await f.service.store.connection(f.identity.ownerId, id);
        assert.equal(current.version, c.version + 1);
        assert.equal(f.service.summary(current, f.identity).credentialConfigured, false);
        assert.equal(f.stats().calls, 0);
        assert.equal(injected, true);
      } finally {
        await f.close();
      }
    });
  }
});

test("G4 archiving workspace before credential commit prevents token publication", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 25000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Archived publication",
    config: { ...f.httpConfig, authentication: "oauth", oauth: f.oauthConfig },
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const a = await f.service.oauth.begin(c, f.identity),
    u = new URL(a.authorizationUrl);
  await f.service.oauth.callback({
    state: u.searchParams.get("state") ?? assert.fail("state"),
    code: "synthetic-code",
    iss: f.issuer,
  });
  const stage = f.service.store.stageCredential.bind(f.service.store);
  f.service.store.stageCredential = async (...args) => {
    await stage(...args);
    await f.pool.execute("UPDATE workspace SET archivedAt=UTC_TIMESTAMP(3) WHERE id=?", [
      f.binding.workspaceId,
    ]);
  };
  await assert.rejects(f.service.oauth.finish(f.identity, a.id), /WORKSPACE_REJECTED/);
  const current = await f.service.store.connection(f.identity.ownerId, id);
  assert.equal(current.version, c.version);
  assert.equal(f.service.summary(current, f.identity).credentialConfigured, false);
});

test("G4 OAuth issuer mismatch and connection disable make callbacks unusable without token exchange", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "OAuth external",
    config: { ...f.httpConfig, authentication: "oauth", oauth: f.oauthConfig },
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id),
    a = await f.service.oauth.begin(c, f.identity);
  await assert.rejects(
    f.service.oauth.callback({
      state:
        new URL(a.authorizationUrl).searchParams.get("state") ?? assert.fail("Missing OAuth state"),
      code: "synthetic-code",
      iss: "https://unapproved.invalid",
    }),
    /CALLBACK_REJECTED/,
  );
  const b = await f.service.oauth.begin(c, f.identity);
  await f.service.disable(c, f.identity);
  await assert.rejects(
    f.service.oauth.callback({
      state:
        new URL(b.authorizationUrl).searchParams.get("state") ?? assert.fail("Missing OAuth state"),
      code: "synthetic-code",
      iss: f.issuer,
    }),
    /CALLBACK_REJECTED/,
  );
  assert.equal(f.stats().exchanges, 0);
});

test("G4 revoking OAuth while credential staging is blocked cannot publish a token", {
  skip: process.env.STAGE9_G4_TEST !== "1",
  timeout: 30000,
}, async (t) => {
  const f = await externalFixture();
  t.after(() => f.close());
  const { id } = await f.service.create(f.identity, {
    workspaceId: f.binding.workspaceId,
    name: "Revoked authorization",
    config: { ...f.httpConfig, authentication: "oauth", oauth: f.oauthConfig },
  });
  const c = await f.service.connection(f.identity, f.binding.workspaceId, id);
  const a = await f.service.oauth.begin(c, f.identity),
    u = new URL(a.authorizationUrl);
  await f.service.oauth.callback({
    state: u.searchParams.get("state") ?? assert.fail("state"),
    code: "synthetic-code",
    iss: f.issuer,
  });
  const lock = await f.pool.getConnection();
  await lock.beginTransaction();
  await lock.execute("SELECT ownerId FROM external_mcp_owner WHERE ownerId=? FOR UPDATE", [
    f.identity.ownerId,
  ]);
  const finish = f.service.oauth.finish(f.identity, a.id),
    rejected = assert.rejects(finish, /OAUTH_EXPIRED/);
  for (let i = 0; i < 60 && f.stats().exchanges === 0; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.stats().exchanges, 1);
  await new Promise((r) => setTimeout(r, 50));
  f.service.oauth.revoke(id);
  await lock.rollback();
  lock.release();
  await rejected;
  const current = await f.service.connection(f.identity, f.binding.workspaceId, id);
  assert.equal(current.version, c.version);
  assert.equal(current.credentialRef, c.credentialRef);
  assert.equal(f.service.summary(current, f.identity).credentialConfigured, false);
});
