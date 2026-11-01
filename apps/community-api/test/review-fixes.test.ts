import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import express from "express";
import { databaseConnectionOptions } from "../src/auth/database.js";
import { readAuthConfig, createDatabase } from "../src/auth.js";
import { readApiConfig } from "../src/config.js";
import { safeError } from "../src/logging/fields.js";
import { AuditTrail } from "../src/history/audit.js";
import type { HistoryStore } from "../src/history/store.js";
import type { AuditEntry } from "../src/history/model.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { ScopeCoordinator } from "../src/datasources/scope-coordinator.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountProductRoutes } from "../src/product-routes.js";
import type { Auth } from "../src/auth.js";
import type { Pool } from "mysql2/promise";
import type { WorkspaceStore } from "../src/workspaces.js";
import { ReadService } from "../src/queries/service.js";
import { testSessionId, testSessions } from "./session-fixture.js";

test("database transport defaults to certificate-verified TLS outside loopback and rejects silent URL overrides", () => {
  assert.equal(databaseConnectionOptions("mysql://u:p@127.0.0.1/example").ssl, undefined);
  assert.equal(databaseConnectionOptions("mysql://u:p@[::1]/example").host, "::1");
  assert.deepEqual(databaseConnectionOptions("mysql://u:p@db.example.invalid/example").ssl, {
    rejectUnauthorized: true,
    verifyIdentity: true,
  });
  assert.deepEqual(databaseConnectionOptions("mysql://u:p@localhost/example?tls=required").ssl, {
    rejectUnauthorized: true,
    verifyIdentity: true,
  });
  for (const option of ["tls=local", "tls=false", "ssl=false", "tls=required&tls=local"])
    assert.throws(
      () => databaseConnectionOptions(`mysql://u:p@db.example.invalid/example?${option}`),
      /tls/,
    );
  assert.throws(() => databaseConnectionOptions("not-a-url-with-sensitive-text"), /valid MySQL/);
  assert.throws(() => databaseConnectionOptions("mysql://u:p@127.0.0.1:0/example"), /valid MySQL/);
});

test("a synthetic MySQL auth-switch peer cannot obtain a cleartext password", {
  timeout: 8000,
}, async () => {
  const secret = `synthetic-${randomUUID()}`;
  const received: Buffer[] = [],
    sockets = new Set<Socket>();
  const number = (value: number, size: number) => {
    const b = Buffer.alloc(size);
    b.writeUIntLE(value, 0, size);
    return b;
  };
  const packet = (payload: Buffer, sequence: number) =>
    Buffer.concat([number(payload.length, 3), Buffer.from([sequence]), payload]);
  const salt = Buffer.from("fixed-test-salt-12345");
  const flags = 0x0008a20d;
  const handshake = Buffer.concat([
    Buffer.from([10]),
    Buffer.from("8.0.40\0"),
    number(1, 4),
    salt.subarray(0, 8),
    Buffer.from([0]),
    number(flags & 0xffff, 2),
    Buffer.from([45]),
    number(2, 2),
    number(flags >>> 16, 2),
    Buffer.from([21]),
    Buffer.alloc(10),
    salt.subarray(8, 20),
    Buffer.from([0]),
    Buffer.from("mysql_native_password\0"),
  ]);
  let switched = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write(packet(handshake, 0));
    let first = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      received.push(bytes);
      if (switched) {
        socket.write(
          packet(
            Buffer.concat([
              Buffer.from([0xff]),
              number(1045, 2),
              Buffer.from("#28000Synthetic authentication rejection"),
            ]),
            4,
          ),
        );
        return;
      }
      first = Buffer.concat([first, bytes]);
      if (first.length < 4 || first.length < first.readUIntLE(0, 3) + 4) return;
      switched = true;
      socket.write(
        packet(
          Buffer.concat([
            Buffer.from([0xfe]),
            Buffer.from("mysql_clear_password\0"),
            salt,
            Buffer.from([0]),
          ]),
          2,
        ),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const pool = createDatabase(`mysql://fixture:${secret}@127.0.0.1:${address.port}/unused`);
  try {
    await assert.rejects(
      () => pool.getConnection(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MYSQL_CLEAR_PASSWORD_NOT_ENABLED",
    );
    assert.equal(switched, true);
    assert.equal(Buffer.concat(received).includes(Buffer.from(secret)), false);
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("known operational failures retain distinct fixed guidance without reflecting credentials or unknown messages", () => {
  const errors: unknown[] = [];
  for (const action of [
    () => readAuthConfig({}),
    () => readApiConfig({ API_PORT: "0" }),
    () =>
      readAuthConfig({
        DATABASE_URL: "CANARY_PRIVATE_URL",
        BETTER_AUTH_SECRET: "a".repeat(32),
        APP_ORIGIN: "http://localhost:5173",
      }),
  ]) {
    try {
      action();
    } catch (error) {
      errors.push(safeError(error));
    }
  }
  assert.deepEqual(
    errors.map((value) => Reflect.get(value as object, "errorCode")),
    ["AUTH_CONFIG_REQUIRED", "API_PORT_INVALID", "DATABASE_URL_INVALID"],
  );
  assert.ok(
    errors.every((value) => typeof Reflect.get(value as object, "operatorMessage") === "string"),
  );
  assert.doesNotMatch(JSON.stringify(errors), /CANARY_PRIVATE_URL/);
  assert.doesNotMatch(
    JSON.stringify(safeError(new Error("CANARY_DATABASE_PASSWORD"))),
    /CANARY_DATABASE_PASSWORD/,
  );
});

test("actual management routes audit business operations with targets, while status polling and unknown paths create no changes", async () => {
  const owner = randomUUID(),
    workspace = randomUUID(),
    source = randomUUID(),
    connector = randomUUID();
  const events: Array<{ entry: AuditEntry; scope: unknown }> = [];
  const trail = new AuditTrail({
    appendAudit: async (_owner: string, scope: unknown, entry: AuditEntry) => {
      events.push({ scope, entry });
    },
  } as HistoryStore);
  const app = express();
  const origin = "http://localhost:5173";
  let revoked = 0,
    archived = 0,
    bound = 0;
  const registry = {
    isActiveOwner: async () => true,
    revoke: async () => {
      revoked++;
    },
    withActiveOwner: async (_o: string, _c: string, action: () => unknown) => action(),
  } as unknown as ConnectorRegistry;
  const sources = {
    bindingStatuses: async () => [],
    bind: async () => {
      bound++;
    },
    unbind: async () => {},
  } as unknown as DataSourceStore;
  trail.install(app, async () => owner);
  mountDataSourceRoutes(
    app,
    sources,
    registry,
    origin,
    async () => owner,
    new ScopeCoordinator(sources, registry),
  );
  mountConnectorRoutes(app, registry, origin, async () => owner);
  mountProductRoutes(
    app,
    { api: { getSession: async () => ({ user: { id: owner } }) } } as unknown as Auth,
    {} as Pool,
    origin,
    {
      setArchived: async () => {
        archived++;
        return true;
      },
    } as unknown as WorkspaceStore,
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    await response.arrayBuffer();
    return response.status;
  };
  try {
    for (let i = 0; i < 3; i++)
      assert.equal(
        await post(`/api/data-sources/workspaces/${workspace}/status`, { sourceIds: [source] }),
        200,
      );
    assert.equal(await post("/api/data-sources/workspaces/not-a-binding"), 404);
    await trail.flush();
    assert.equal(events.length, 0);
    assert.equal(await post(`/api/connectors/${connector}/revoke`), 200);
    assert.equal(await post(`/api/workspaces/${workspace}/archive`), 200);
    assert.equal(await post(`/api/workspaces/${workspace}/restore`), 200);
    await trail.flush();
    assert.deepEqual(
      events.map((item) => item.entry),
      [
        { event: "connection.revoked", connectorId: connector, outcome: "success" },
        { event: "workspace.archived", targetId: workspace, outcome: "success" },
        { event: "workspace.restored", targetId: workspace, outcome: "success" },
      ],
    );
    for (const [method, path] of [
      ["POST", `/api/connectors/${connector}/revoke`],
      ["POST", `/api/workspaces/${workspace}/archive`],
      ["PUT", `/api/data-sources/workspaces/${workspace}/${source}`],
    ]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { origin: "http://wrong.example.invalid", "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 403);
      await response.arrayBuffer();
    }
    await trail.flush();
    assert.deepEqual(events.slice(3), [
      {
        entry: { event: "security.denied", connectorId: connector, outcome: "denied" },
        scope: null,
      },
      { entry: { event: "security.denied", targetId: workspace, outcome: "denied" }, scope: null },
      {
        entry: {
          event: "security.denied",
          targetId: source,
          outcome: "denied",
          attemptedWorkspaceId: workspace,
          attemptedSourceId: source,
        },
        scope: null,
      },
    ]);
    assert.deepEqual({ revoked, archived, bound }, { revoked: 1, archived: 2, bound: 0 });
  } finally {
    trail.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("session revocation and expiry before dispatch deny the task, including revocation during signing", async () => {
  let active = true,
    release!: () => void,
    started!: () => void;
  const signing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = {
    ownerId: "owner",
    sessionId: testSessionId,
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  let signed = 0;
  const registry = {
    issueReadTask: async (task: object) => {
      signed++;
      started();
      await wait;
      return { ...task, signature: "fixture" };
    },
  } as unknown as ConnectorRegistry;
  const store = {
    boundSource: async () => ({ connectorId: scope.connectorId }),
  } as unknown as DataSourceStore;
  const read = new ReadService(store, registry, {
    ...testSessions,
    active: async (identity) => active && identity.sessionId === testSessionId,
  });
  try {
    const first = read.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    active = false;
    assert.equal(await read.next(scope.connectorId), null);
    assert.equal(signed, 0);
    assert.equal(read.jobs.status(scope, first)?.state, "failed");
    active = true;
    const second = read.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    const dispatch = read.next(scope.connectorId);
    await signing;
    active = false;
    release();
    assert.equal(await dispatch, null);
    assert.equal(read.jobs.status(scope, second)?.state, "failed");
  } finally {
    release();
    read.close();
  }
});

test("an expired dispatch cannot reject a replacement with the same ID while it waits for the workspace lock", async (context) => {
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  let enter!: () => void,
    resume!: () => void,
    signed = 0;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const scope = {
    ownerId: "owner",
    sessionId: testSessionId,
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const registry = {
    issueReadTask: async (task: object) => {
      signed++;
      enter();
      await gate;
      return { ...task, signature: "fixture" };
    },
  } as unknown as ConnectorRegistry;
  const store = {
    boundSource: async () => ({ connectorId: scope.connectorId }),
  } as unknown as DataSourceStore;
  const read = new ReadService(store, registry, testSessions);
  try {
    const id = randomUUID();
    read.jobs.create(scope, id, "SELECT id FROM items", [], 1);
    const old = read.next(scope.connectorId);
    await started;
    now += 400000;
    read.jobs.create(scope, id, "SELECT name FROM items", [], 1);
    const replacement = read.next(scope.connectorId);
    resume();
    assert.equal(await old, null);
    assert.ok(await replacement);
    assert.equal(signed, 2);
    assert.equal(read.jobs.status(scope, id)?.state, "running");
  } finally {
    resume();
    read.close();
  }
});

test("revocation stops redelivery without replacing an already published read's real outcome", async () => {
  let active = true;
  const scope = {
    ownerId: "owner",
    sessionId: testSessionId,
    connectorId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
  };
  const updates: string[] = [];
  const registry = {
    issueReadTask: async (task: object) => ({ ...task, signature: "fixture" }),
    preflightReadResult: async () => {},
    verifyReadResult: async (_input: unknown, commit: () => Promise<void>) => commit(),
    readResultAcknowledgement: () => "fixture-ack",
  } as unknown as ConnectorRegistry;
  const read = new ReadService(
    { boundSource: async () => ({ connectorId: scope.connectorId }) } as unknown as DataSourceStore,
    registry,
    { ...testSessions, active: async () => active },
    {
      begin: async () => ({ created: true, state: "queued" }),
      update: async (_scope, _id, state) => {
        updates.push(state);
      },
    },
  );
  try {
    const id = read.jobs.create(scope, randomUUID(), "SELECT id FROM items", [], 1);
    await read.trackExecution(scope, id);
    const task = await read.next(scope.connectorId);
    assert.ok(task && task.operation === "read_query");
    active = false;
    assert.equal(await read.next(scope.connectorId), null);
    assert.equal(read.jobs.status(scope, id)?.state, "running");
    const payload = Buffer.from(
      JSON.stringify({
        columns: [{ name: "id", type: "int" }],
        rows: [[{ null: false, encoding: "text", value: "1" }]],
        timezone: "UTC",
        truncated: false,
      }),
    ).toString("base64url");
    assert.equal(
      await read.result({
        taskId: id,
        taskNonce: task.nonce,
        actorId: scope.ownerId,
        workspaceId: scope.workspaceId,
        sourceId: scope.sourceId,
        connectorId: scope.connectorId,
        outcome: "ok",
        payload,
        nonce: "fixture",
        timestamp: Math.floor(Date.now() / 1000),
        signature: "fixture",
      }),
      "fixture-ack",
    );
    assert.equal(read.jobs.status(scope, id)?.state, "completed");
    assert.deepEqual(read.jobs.executionState(scope, id), {
      state: "completed",
      summary: { rowCount: 1, truncated: false },
    });
    assert.equal(updates.includes("failed"), false);
    assert.equal(updates.at(-1), "completed");
  } finally {
    read.close();
  }
});
