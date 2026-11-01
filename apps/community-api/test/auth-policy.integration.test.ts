import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { createAuth, authSessionAccess } from "../src/auth.js";
import { mountProductRoutes } from "../src/product-routes.js";
import { WorkspaceStore } from "../src/workspaces.js";
import { ReadService } from "../src/queries/service.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mutationFixture } from "./mutation-fixture.js";
import { resetOnlyAdminPassword } from "../src/reset-password.js";
import type { RowDataPacket } from "mysql2/promise";
import { hashPassword } from "better-auth/crypto";
import { setImmediate } from "node:timers/promises";
import type { Pool } from "mysql2/promise";
import { createConnection } from "node:net";

test("isolated Better Auth enforces revocation on omitted/false input and stops queued reads plus model waits", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 30000,
}, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  const origin = "http://127.0.0.1:5173";
  const auth = createAuth(
    { databaseUrl: "mysql://unused/isolated", secret: randomBytes(32).toString("hex"), origin },
    f.pool,
  );
  const username = `review${randomBytes(6).toString("hex")}`;
  let password = randomBytes(16).toString("hex");
  const user = await auth.api.signUpEmail({
    body: { username, name: "isolated review", email: `${username}@example.invalid`, password },
  });
  const workspace = await new WorkspaceStore(f.pool).create(user.user.id, "review isolation");
  const scope = {
    ownerId: user.user.id,
    workspaceId: workspace.id,
    sourceId: randomUUID(),
    connectorId: f.binding.connectorId,
  };
  await f.sources.create(scope.ownerId, scope.sourceId, scope.connectorId, "review source");
  await f.sources.bind(scope.ownerId, scope.workspaceId, scope.sourceId);
  const sessions = authSessionAccess(auth, f.pool);
  let dispatched = 0;
  const registry = {
    issueReadTask: async (task: object) => {
      dispatched++;
      return { ...task, signature: "fixture" };
    },
  } as unknown as ConnectorRegistry;
  const read = new ReadService(f.sources, registry, sessions);
  const app = express();
  mountProductRoutes(app, auth, f.pool, origin);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, cookie: string, body?: object) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { origin, cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
  const login = async () => {
    const response = await call("/api/auth/sign-in/username", "", { username, password });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  };
  try {
    for (const value of [false, undefined]) {
      const current = await login(),
        other = await login();
      const identity = await sessions.authenticate({ cookie: other });
      assert.ok(identity);
      assert.equal(await sessions.active(identity), true);
      const submitted = { ...scope, sessionId: identity.sessionId };
      const query = read.jobs.create(submitted, randomUUID(), "SELECT id FROM items", [], 1);
      const model = read.jobs.createModelSchema(submitted, randomUUID());
      const watch = await read.watchSession(scope, model);
      const changed = randomBytes(16).toString("hex");
      const response = await call("/api/auth/change-password", current, {
        currentPassword: password,
        newPassword: changed,
        ...(value === undefined ? {} : { revokeOtherSessions: value }),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      password = changed;
      assert.equal(await sessions.active(identity), false);
      assert.equal(await (await call("/api/auth/get-session", other)).json(), null);
      assert.equal(await read.next(scope.connectorId), null);
      assert.equal(dispatched, 0);
      assert.equal(read.jobs.status(scope, query)?.state, "failed");
      await assert.rejects(() => read.assertSession(scope, model), /STALE/);
      if (!watch.signal.aborted)
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("session watch did not abort")), 2000);
          watch.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(deadline);
              resolve();
            },
            { once: true },
          );
        });
      watch.dispose();
    }
    const cookie = await login();
    const identity = await sessions.authenticate({ cookie });
    assert.ok(identity);
    const id = read.jobs.create(
      { ...scope, sessionId: identity.sessionId },
      randomUUID(),
      "SELECT id FROM items",
      [],
      1,
    );
    await f.pool.execute(
      "UPDATE session SET expiresAt=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
      [identity.sessionId],
    );
    assert.equal(await read.next(scope.connectorId), null);
    assert.equal(read.jobs.status(scope, id)?.state, "failed");
    assert.equal(dispatched, 0);
    const logoutLogin = await auth.api.signInUsername({
      body: { username, password },
      returnHeaders: true,
    });
    const logoutCookie = logoutLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const logoutIdentity = await sessions.authenticate({ cookie: logoutCookie });
    assert.ok(logoutIdentity);
    const logout = await call("/api/auth/sign-out", logoutCookie, {});
    assert.equal(logout.status, 200);
    await logout.arrayBuffer();
    assert.equal(await sessions.active(logoutIdentity), false);
    const held = await Promise.all(Array.from({ length: 8 }, () => f.pool.getConnection()));
    try {
      await assert.rejects(
        sessions.active(identity),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_TIMEOUT",
      );
      assert.equal(dispatched, 0);
    } finally {
      for (const connection of held) connection.release();
    }
  } finally {
    read.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("slow, oversized and wrong-origin auth bodies never check out a database connection", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 15000,
}, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  let checkouts = 0;
  const callbackPool = new Proxy(f.pool.pool, {
    get(target, key, receiver) {
      if (key === "getConnection")
        return (...args: Parameters<typeof target.getConnection>) => {
          checkouts++;
          return target.getConnection(...args);
        };
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pool = new Proxy(f.pool, {
    get(target, key, receiver) {
      return key === "pool" ? callbackPool : Reflect.get(target, key, receiver);
    },
  }) as Pool;
  const origin = "http://127.0.0.1:5173";
  const auth = createAuth(
    { databaseUrl: "mysql://unused/isolated", secret: randomBytes(32).toString("hex"), origin },
    pool,
  );
  const warm = await auth.handler(new Request(`${origin}/api/auth/get-session`));
  await warm.arrayBuffer();
  checkouts = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"username":"'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
    duplex: "half",
  };
  const pending = auth.handler(new Request(`${origin}/api/auth/sign-in/username`, init));
  await setImmediate();
  assert.equal(checkouts, 0);
  const timedOut = await pending;
  assert.equal(timedOut.status, 408);
  auth.completeResponse(timedOut);
  assert.equal(cancelled, true);
  assert.equal(checkouts, 0);
  assert.equal(
    (
      await auth.handler(
        new Request(`${origin}/api/auth/sign-out`, {
          method: "POST",
          headers: { origin },
          body: "x".repeat(8193),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await auth.handler(
        new Request(`${origin}/api/auth/sign-in/username`, {
          method: "POST",
          headers: { origin: "https://wrong.invalid" },
          body: "{}",
        }),
      )
    ).status,
    403,
  );
  assert.equal(checkouts, 0);
  const normal = await auth.handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(normal.status, 200);
  assert.ok(checkouts > 0);
  // Use the actual Better Call Node adapter. Cancelling its IncomingMessage
  // before response.finish would turn both cases into a socket reset.
  const app = express();
  mountProductRoutes(app, auth, f.pool, origin);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  checkouts = 0;
  const exchange = (body: string, length: number) =>
    new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(5000, () => socket.destroy(new Error("synthetic auth response timeout")));
      socket.once("connect", () =>
        socket.write(
          `POST /api/auth/sign-in/username HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n${body}`,
        ),
      );
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.once("error", reject);
      socket.once("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
        socket.destroy();
      });
    });
  const slow = await exchange('{"username":"', 1000);
  assert.match(slow, /^HTTP\/1\.1 408 /);
  assert.match(slow, /INVALID_AUTH_REQUEST/);
  const oversized = await exchange("x".repeat(9000), 9000);
  assert.match(oversized, /^HTTP\/1\.1 413 /);
  assert.match(oversized, /INVALID_AUTH_REQUEST/);
  assert.equal(checkouts, 0);
});

test("a real stalled session prepare terminates on timeout and admission recovers", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 15000,
}, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  const sessions = authSessionAccess({} as ReturnType<typeof createAuth>, f.pool);
  const identity = { ownerId: f.binding.ownerId, sessionId: f.sessionId };
  const blocker = await f.pool.getConnection();
  try {
    await blocker.query("LOCK TABLES session WRITE");
    await assert.rejects(
      sessions.active(identity),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "AUTH_SESSION_CHECK_TIMEOUT",
    );
  } finally {
    await blocker.query("UNLOCK TABLES");
    blocker.release();
  }
  assert.equal(await sessions.active(identity), true);
});

test("credential transactions serialize concurrent old-password login with rotation across auth instances", {
  skip: process.env.STAGE8_G3_TEST !== "1",
  timeout: 30000,
}, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  const config = {
    databaseUrl: "mysql://unused/isolated",
    secret: randomBytes(32).toString("hex"),
    origin: "http://127.0.0.1:5173",
  };
  const a = createAuth(config, f.pool),
    b = createAuth(config, f.pool);
  const username = `race${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("hex"),
    changed = randomBytes(16).toString("hex");
  // Give the fixture's only synthetic owner an SDK-hashed credential.
  await f.pool.execute("UPDATE user SET username=?,displayUsername=? WHERE id=?", [
    username,
    username,
    f.binding.ownerId,
  ]);
  await f.pool.execute(
    "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
    [randomUUID(), f.binding.ownerId, f.binding.ownerId, await hashPassword(password)],
  );
  const current = await b.api.signInUsername({ body: { username, password }, returnHeaders: true });
  const cookie = current.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const ctx = await a.$context;
  const verify = ctx.password.verify;
  let enter!: () => void, resume!: () => void;
  const verified = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  ctx.password.verify = async (input) => {
    const valid = await verify(input);
    if (valid) {
      enter();
      await gate;
    }
    return valid;
  };
  const signing = a.api.signInUsername({ body: { username, password } });
  await verified;
  const rotating = b.api.changePassword({
    headers: new Headers({ cookie }),
    body: { currentPassword: password, newPassword: changed, revokeOtherSessions: false },
  });
  let lockObserved = false;
  try {
    // Observe the actual database lock conflict, not a guessed scheduling delay.
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const [waits] = await f.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE WHERE l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME='user'",
      );
      if (Number(waits[0]?.total) > 0) {
        lockObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    resume();
  }
  const oldLogin = await signing;
  await rotating;
  assert.equal(lockObserved, true, "the two SDK instances must contend on the user row lock");
  const [sessions] = await f.pool.execute<RowDataPacket[]>(
    "SELECT id FROM session WHERE userId=? AND token=?",
    [f.binding.ownerId, oldLogin.token],
  );
  assert.equal(sessions.length, 0);
  await assert.rejects(() => b.api.signInUsername({ body: { username, password } }));
  const newLogin = await b.api.signInUsername({ body: { username, password: changed } });
  assert.ok(newLogin.token);
  // Force a real failure after the password update but during revocation. The
  // HTTP SDK returns an error Response, which must also roll back the update.
  await f.pool.query(
    "CREATE TRIGGER isolated_fail_revoke BEFORE DELETE ON session FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic revocation failure'",
  );
  const rawErrors = t.mock.method(console, "error", () => {});
  const next = randomBytes(16).toString("hex");
  const nextCookie = await b.api.signInUsername({
    body: { username, password: changed },
    returnHeaders: true,
  });
  const response = await b.handler(
    new Request(`${config.origin}/api/auth/change-password`, {
      method: "POST",
      headers: {
        origin: config.origin,
        "content-type": "application/json",
        cookie: nextCookie.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      },
      body: JSON.stringify({ currentPassword: changed, newPassword: next }),
    }),
  );
  assert.equal(response.status, 500);
  await response.arrayBuffer();
  assert.equal(rawErrors.mock.callCount(), 0, "adapter SQL must never bypass the reviewed logger");
  const logoutHeaders = {
    origin: config.origin,
    "content-type": "application/json",
    cookie: nextCookie.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
  const deniedLogout = await b.handler(
    new Request(`${config.origin}/api/auth/sign-out`, {
      method: "POST",
      headers: logoutHeaders,
      body: "{}",
    }),
  );
  await deniedLogout.arrayBuffer();
  assert.equal(
    deniedLogout.status,
    500,
    "logout must not report success if the SDK swallowed session deletion failure",
  );
  const retained = await authSessionAccess(b, f.pool).authenticate({
    cookie: logoutHeaders.cookie,
  });
  assert.ok(retained);
  assert.equal(await authSessionAccess(b, f.pool).active(retained), true);
  await f.pool.query("DROP TRIGGER isolated_fail_revoke");
  const retriedLogout = await b.handler(
    new Request(`${config.origin}/api/auth/sign-out`, {
      method: "POST",
      headers: logoutHeaders,
      body: "{}",
    }),
  );
  assert.equal(retriedLogout.status, 200);
  await retriedLogout.arrayBuffer();
  assert.equal(await authSessionAccess(b, f.pool).active(retained), false);
  await assert.rejects(() => b.api.signInUsername({ body: { username, password: next } }));
  assert.ok((await b.api.signInUsername({ body: { username, password: changed } })).token);
  await resetOnlyAdminPassword(f.pool, randomBytes(16).toString("hex"));
  const [remaining] = await f.pool.execute<RowDataPacket[]>(
    "SELECT id FROM session WHERE userId=?",
    [f.binding.ownerId],
  );
  assert.equal(remaining.length, 0);
});
