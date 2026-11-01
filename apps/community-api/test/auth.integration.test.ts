import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { createAuth, createDatabase, readAuthConfig } from "../src/auth.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("auth config requires explicit safe values", () => {
  assert.throws(() => readAuthConfig({}), /required/);
  assert.throws(
    () =>
      readAuthConfig({
        DATABASE_URL: "mysql://u:p@localhost/db",
        BETTER_AUTH_SECRET: "short",
        APP_ORIGIN: "http://localhost:5173",
      }),
    /32/,
  );
  assert.throws(
    () =>
      readAuthConfig({
        DATABASE_URL: "mysql://u:p@localhost/db",
        BETTER_AUTH_SECRET: "a".repeat(32),
        APP_ORIGIN: "http://example.com",
      }),
    /HTTPS/,
  );
});

test("MySQL login, sessions, password change and workspace isolation", {
  skip: !databaseUrl,
}, async () => {
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/ai_workspace_stage1_test")
    throw new Error("Use only the dedicated stage 1 test database");
  const origin = "http://127.0.0.1:5173";
  const config = { databaseUrl, secret: randomBytes(32).toString("hex"), origin };
  const pool = createDatabase(databaseUrl);
  const auth = createAuth(config, pool);
  const userIds: string[] = [];
  const suffix = randomUUID().replaceAll("-", "");
  const app = await createApp({ logger: false, auth: config });
  try {
    for (const n of [1, 2]) {
      const result = await auth.api.signUpEmail({
        body: {
          name: `Test ${n}`,
          username: `t${n}${suffix}`,
          email: `t${n}${suffix}@example.test`,
          password: "test-password-only-123",
        },
      });
      userIds.push(result.user.id);
    }
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const call = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, options);
    const request = (
      method: string,
      cookie: string,
      data?: unknown,
      requestOrigin = origin,
    ): RequestInit => ({
      method,
      headers: { origin: requestOrigin, cookie, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.equal((await call("/api/workspaces")).status, 401);
    assert.equal((await call("/api/auth/sign-up/email", { method: "POST" })).status, 404);
    async function login(n: number): Promise<string> {
      const response = await call(
        "/api/auth/sign-in/username",
        request("POST", "", { username: `t${n}${suffix}`, password: "test-password-only-123" }),
      );
      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie");
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/i);
      return cookie.split(";")[0] ?? "";
    }
    assert.equal(
      (
        await call(
          "/api/auth/sign-in/username",
          request("POST", "", { username: `t1${suffix}`, password: "wrong-password" }),
        )
      ).status,
      401,
    );
    const malformed = await call("/api/workspaces", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "请求格式无效" });
    const oversized = await call("/api/workspaces", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(9000) }),
    });
    assert.equal(oversized.status, 413);
    const cookie1 = await login(1);
    const cookie1b = await login(1);
    const cookie2 = await login(2);
    const sessionResponse = await call("/api/security/sessions", { headers: { cookie: cookie1 } });
    const sessionJson = (await sessionResponse.json()) as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    assert.equal(sessionJson.sessions.length, 2);
    assert.ok(!JSON.stringify(sessionJson).includes("token"));
    const other = sessionJson.sessions.find((s) => !s.current);
    assert.ok(other);
    assert.equal(
      (await call(`/api/security/sessions/${other.id}/revoke`, request("POST", cookie2))).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/api/security/sessions/${other.id}/revoke`,
          request("POST", cookie1, {}, "http://evil.example"),
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(`/api/security/sessions/${other.id}/revoke`, request("POST", cookie1))).status,
      200,
    );
    assert.equal((await call("/api/workspaces", { headers: { cookie: cookie1b } })).status, 401);
    assert.equal(
      (
        await call(
          "/api/workspaces",
          request("POST", cookie1, { name: "bad" }, "http://evil.example"),
        )
      ).status,
      403,
    );
    const made = await call("/api/workspaces", request("POST", cookie1, { name: "测试空间" }));
    assert.equal(made.status, 201);
    const workspace = (await made.json()) as { id: string };
    const others = await call("/api/workspaces", { headers: { cookie: cookie2 } });
    assert.deepEqual(((await others.json()) as { workspaces: unknown[] }).workspaces, []);
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}`, request("PATCH", cookie2, { name: "越权" })))
        .status,
      404,
    );
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}`, request("PATCH", cookie1, { name: "新名称" })))
        .status,
      200,
    );
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}/archive`, request("POST", cookie2))).status,
      404,
    );
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}/archive`, request("POST", cookie1))).status,
      200,
    );
    const active = await call("/api/workspaces", { headers: { cookie: cookie1 } });
    assert.equal(((await active.json()) as { workspaces: unknown[] }).workspaces.length, 0);
    const archived = await call("/api/workspaces?archived=true", { headers: { cookie: cookie1 } });
    assert.equal(((await archived.json()) as { workspaces: unknown[] }).workspaces.length, 1);
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}`, request("PATCH", cookie1, { name: "不允许" })))
        .status,
      404,
    );
    assert.equal(
      (await call(`/api/workspaces/${workspace.id}/restore`, request("POST", cookie1))).status,
      200,
    );
    const cookie1c = await login(1);
    assert.equal(
      (
        await call(
          "/api/auth/sign-in/username",
          request("POST", "", { username: `t1${suffix}`, password: "bad" }),
        )
      ).status,
      429,
    );
    assert.equal(
      (
        await call(
          "/api/auth/change-password",
          request(
            "POST",
            cookie1,
            { currentPassword: "test-password-only-123", newPassword: "never-used-pass-456" },
            "http://evil.example",
          ),
        )
      ).status,
      403,
    );
    const changed = await call(
      "/api/auth/change-password",
      request("POST", cookie1, {
        currentPassword: "test-password-only-123",
        newPassword: "new-password-only-456",
        revokeOtherSessions: true,
      }),
    );
    assert.equal(changed.status, 200);
    const replacement = changed.headers
      .getSetCookie()
      .find((value) => value.startsWith("better-auth.session_token="));
    const currentCookie = replacement?.split(";")[0] ?? cookie1;
    assert.equal((await call("/api/workspaces", { headers: { cookie: cookie1c } })).status, 401);
    assert.equal(
      (await call("/api/workspaces", { headers: { cookie: currentCookie } })).status,
      200,
    );
    await assert.rejects(() =>
      auth.api.signInUsername({
        body: { username: `t1${suffix}`, password: "test-password-only-123" },
      }),
    );
    const newLogin = await auth.api.signInUsername({
      body: { username: `t1${suffix}`, password: "new-password-only-456" },
    });
    assert.equal(newLogin.user.id, userIds[0]);
    assert.equal((await call("/api/auth/sign-out", request("POST", currentCookie))).status, 200);
    assert.equal(
      (await call("/api/workspaces", { headers: { cookie: currentCookie } })).status,
      401,
    );
  } finally {
    await app.close();
    for (const id of userIds) {
      await pool.execute("DELETE FROM workspace WHERE createdByAccountId = ?", [id]);
      await pool.execute("DELETE FROM `user` WHERE id = ?", [id]);
    }
    await pool.end();
  }
});
