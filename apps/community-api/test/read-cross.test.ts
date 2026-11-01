import { testSessions } from "./session-fixture.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import express from "express";
import mysql from "mysql2/promise";
import { ModelStore } from "../src/ai/model-store.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { mountConnectorRoutes } from "../src/connectors/routes.js";
import { mountDataSourceRoutes } from "../src/datasources/routes.js";
import { scanHooks } from "../src/datasources/scan.js";
import { DataSourceStore } from "../src/datasources/store.js";
import type { Execution } from "../src/history/model.js";
import { mountHistoryRoutes } from "../src/history/routes.js";
import { HistoryStore } from "../src/history/store.js";
import { migrateDatabase, migrateStage3, migrateStage6, migrateStage7 } from "../src/migrations.js";
import { apiPackageRoot } from "../src/package-path.js";
import { ReadService } from "../src/queries/service.js";
import { mountSemanticRoutes } from "../src/semantic/routes.js";
import { SemanticStore } from "../src/semantic/store.js";

test("isolated platform dispatches signed Go reads and retains safe terminal execution history", {
  skip: process.env.STAGE3_MYSQL_TEST !== "1",
  timeout: 90_000,
}, async () => {
  const database = `stage4_${randomBytes(8).toString("hex")}`;
  const sourceDatabase = `stage4s_${randomBytes(8).toString("hex")}`;
  const username = `s4_${randomBytes(6).toString("hex")}`;
  const password = "stage4-fixture-only";
  const admin = mysql.createPool({
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
    connectionLimit: 2,
  });
  const [identity] = await admin.query<mysql.RowDataPacket[]>(
    "SELECT @@port AS port, @@datadir AS dir",
  );
  if (
    identity[0]?.port !== 13307 ||
    !String(identity[0]?.dir)
      .toLowerCase()
      .replaceAll("\\", "/")
      .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
  ) {
    await admin.end();
    throw new Error("unexpected test database instance");
  }
  const pool = mysql.createPool({
    host: "127.0.0.1",
    port: 13307,
    user: "root",
    password: "stage3-isolated-fixture-only",
    database,
    connectionLimit: 4,
  });
  const dir = await mkdtemp(join(tmpdir(), "stage4-cross-"));
  const registry = await ConnectorRegistry.open(
    join(dir, "registry.json"),
    randomBytes(32).toString("hex"),
  );
  const owner = randomUUID(),
    workspace = randomUUID(),
    source = randomUUID();
  const store = new DataSourceStore(pool);
  const history = new HistoryStore(pool, store);
  const service = new ReadService(store, registry, testSessions, {
    begin: (scope, id, instance) => history.beginExecution(scope, id, scope.connectorId, instance),
    update: (scope, id, state, summary) => history.setExecutionState(scope, id, state, summary),
  });
  const semantics = new SemanticStore(store);
  const app = express();
  const model = express();
  model.use(express.json());
  let modelRequests = 0;
  model.post("/v1/chat/completions", (req, res) => {
    modelRequests++;
    const input = JSON.parse(String(req.body.messages?.[1]?.content)) as {
      question: string;
      schema: { tables: Array<{ columns: Array<{ name: string }> }> };
    };
    assert.equal(input.question, "查询客户编号");
    assert.deepEqual(
      input.schema.tables[0]?.columns.map((column) => column.name),
      ["id", "name"],
    );
    res.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              kind: "query",
              explanation: "查询客户编号",
              table: "customers",
              columns: ["id", "name"],
              filters: [],
              orderBy: [],
              maxRows: 10,
            }),
          },
        },
      ],
    });
  });
  const modelServer = model.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => modelServer.once("listening", resolve));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const credentials = new Map<string, string>();
  const models = new ModelStore((key) => ({
    getPassword: () => credentials.get(key) ?? null,
    setPassword: (value) => {
      credentials.set(key, value);
    },
    deletePassword: () => credentials.delete(key),
  }));
  models.set(owner, {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
    model: "test",
    apiKey: "fixture",
  });
  let readAttempts = 0;
  let droppedCreate = false;
  let droppedHeartbeat = false;
  app.use((req, res, next) => {
    const drop = () => {
      res.end = (() => {
        res.socket?.destroy();
        return res;
      }) as typeof res.end;
    };
    if (!droppedCreate && req.method === "POST" && req.path.endsWith("/queries")) {
      droppedCreate = true;
      drop();
    }
    if (!droppedHeartbeat && req.path === "/api/connector-agent/heartbeat") {
      droppedHeartbeat = true;
      drop();
    }
    if (req.path === "/api/connector-agent/read-result") {
      readAttempts++;
      if (readAttempts === 1) {
        // The handler has already committed the result when it calls end();
        // lose only that response to simulate a real acknowledgement loss.
        drop();
      }
    }
    next();
  });
  const origin = "http://127.0.0.1:5173";
  const auth = async (headers: import("node:http").IncomingHttpHeaders) =>
    headers["x-test-owner"] === owner ? owner : undefined;
  mountConnectorRoutes(app, registry, origin, auth, scanHooks(store, registry), service);
  mountDataSourceRoutes(
    app,
    store,
    registry,
    origin,
    auth,
    service.coordinator,
    service,
    models,
    semantics,
  );
  mountSemanticRoutes(app, auth, origin, semantics, service);
  mountHistoryRoutes(app, auth, origin, history, service);
  type ExecutionRecord = {
    id: string;
    revision: number;
    content: Execution;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    workspaceId: string;
    sourceId: string;
  };
  let completedBeforeRelease: ExecutionRecord | undefined;
  let releaseCheck: Promise<void> | undefined;
  async function executions(): Promise<ExecutionRecord[]> {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/history/executions`, {
      headers: { "x-test-owner": owner },
    });
    assert.equal(response.status, 200);
    const page = (await response.json()) as { items: ExecutionRecord[]; nextCursor: string | null };
    assert.equal(page.nextCursor, null, "the synthetic fixture should fit on one history page");
    return page.items;
  }
  app.get("/fixture/model-requests", (_req, res) => res.json({ requests: modelRequests }));
  app.get("/fixture/read-busy/:id", (req, res) =>
    res.json({ busy: service.jobs.busy(req.params.id) }),
  );
  app.get("/fixture/read-attempts", async (_req, res) => {
    // The Go probe has copied the completed result and will later release it
    // by unbinding the source. Snapshot its durable outcome before those real
    // HTTP unbind/revoke operations remove result cells and cancellation state.
    if (readAttempts >= 2 && !releaseCheck) {
      releaseCheck = (async () => {
        const records = await executions();
        const completed = records.find((entry) => entry.content.state === "completed");
        assert.ok(completed, "a signed result must have a completed durable execution");
        completedBeforeRelease = completed;
      })();
    }
    await releaseCheck;
    res.json({ attempts: readAttempts });
  });
  app.get("/fixture/read-status/:connectorId/:taskId", (req, res) =>
    res.json(
      service.jobs.status(
        {
          ownerId: owner,
          workspaceId: workspace,
          sourceId: source,
          connectorId: req.params.connectorId,
        },
        req.params.taskId,
      ),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  let created = false;
  let sourceCreated = false;
  let userCreated = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    created = true;
    await admin.query(`CREATE DATABASE \`${sourceDatabase}\``);
    sourceCreated = true;
    await admin.query(
      `CREATE TABLE \`${sourceDatabase}\`.customers (id INT PRIMARY KEY, name VARCHAR(50), secret VARCHAR(80))`,
    );
    await admin.query(
      `INSERT INTO \`${sourceDatabase}\`.customers VALUES (1, 'fixture', 'fixture-secret')`,
    );
    await admin.query(`CREATE USER '${username}'@'localhost' IDENTIFIED BY '${password}'`);
    userCreated = true;
    await admin.query(
      `GRANT SELECT, SHOW VIEW ON \`${sourceDatabase.replaceAll("_", "\\_")}\`.* TO '${username}'@'localhost'`,
    );
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT @@port AS port, @@datadir AS dir, DATABASE() AS db",
    );
    const instance = rows[0];
    if (
      instance?.port !== 13307 ||
      instance.db !== database ||
      !String(instance.dir)
        .toLowerCase()
        .replaceAll("\\", "/")
        .startsWith("i:/wwwroot/stackoryn-com/.cache/stage3-mysql-data/")
    )
      throw new Error("unexpected test database");
    await migrateDatabase(pool);
    await migrateStage3(pool);
    await migrateStage6(pool);
    await migrateStage7(pool);
    await pool.execute(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'fixture', ?, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [owner, `${owner}@example.invalid`],
    );
    await pool.execute(
      "INSERT INTO workspace (id, name, createdByAccountId, createdAt, updatedAt) VALUES (?, 'fixture', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [workspace, owner],
    );
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const offerResponse = await fetch(`${base}/api/connectors/pairings`, {
      method: "POST",
      headers: { origin, "x-test-owner": owner },
    });
    assert.equal(offerResponse.status, 201);
    const offer = (await offerResponse.json()) as {
      pairingId: string;
      secret: string;
      platformPublicKey: string;
    };
    const result = await new Promise<{ status: number | null; output: string; error: string }>(
      (resolvePromise, reject) => {
        const child = spawn("go", ["run", "./testdata/stage4probe"], {
          cwd: resolve(apiPackageRoot(), "../../connector/go"),
          env: { ...process.env, GOARCH: "amd64" },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60_000,
        });
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (status) => resolvePromise({ status, output, error }));
        child.stdin.end(
          JSON.stringify({
            server: base,
            code: `${offer.pairingId}.${offer.secret}.${offer.platformPublicKey}`,
            owner,
            workspace,
            source,
            database: sourceDatabase,
            username,
            password,
          }),
        );
      },
    );
    assert.equal(result.status, 0, result.error);
    const outcome = JSON.parse(result.output) as { State: string; Payload: string };
    assert.equal(outcome.State, "completed");
    const payload = JSON.parse(Buffer.from(outcome.Payload, "base64url").toString("utf8")) as {
      columns: { name: string }[];
      rows: unknown[];
    };
    assert.deepEqual(
      payload.columns.map((column) => column.name),
      ["id", "name"],
    );
    assert.ok(Array.isArray(payload.rows));
    assert.ok(releaseCheck, "the result must be snapshotted before the probe releases it");
    await releaseCheck;
    assert.ok(completedBeforeRelease);
    const completedSnapshot = completedBeforeRelease;
    let records: ExecutionRecord[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      records = await executions();
      if (
        records.length &&
        records.every((entry) => !["queued", "running"].includes(entry.content.state))
      )
        break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.deepEqual(
      records.find((entry) => entry.id === completedSnapshot.id),
      completedSnapshot,
      "clearing cells, unbinding, and revocation must not rewrite a completed history record",
    );
    assert.ok(records.filter((entry) => entry.content.state === "completed").length >= 2);
    assert.ok(
      records.some((entry) => entry.content.state === "failed" && entry.content.code === "denied"),
    );
    assert.ok(records.filter((entry) => entry.content.state === "cancelled").length >= 3);
    for (const record of records) {
      assert.deepEqual(
        Object.keys(record).sort(),
        [
          "id",
          "revision",
          "content",
          "createdAt",
          "updatedAt",
          "deletedAt",
          "workspaceId",
          "sourceId",
        ].sort(),
      );
      assert.equal(record.workspaceId, workspace);
      assert.equal(record.sourceId, source);
      assert.equal(record.content.taskId, record.id);
      assert.equal(record.content.instanceId, service.instanceId);
      assert.ok(!["queued", "running"].includes(record.content.state));
      assert.ok(Number.isFinite(Date.parse(record.content.startedAt)));
      assert.ok(
        record.content.finishedAt && Number.isFinite(Date.parse(record.content.finishedAt)),
      );
      assert.ok(
        Number.isSafeInteger(record.content.durationMs) && Number(record.content.durationMs) >= 0,
      );
      assert.deepEqual(
        Object.keys(record.content).sort(),
        [
          "taskId",
          "connectorId",
          "instanceId",
          "state",
          "startedAt",
          "finishedAt",
          "durationMs",
          "rowCount",
          "truncated",
          "reason",
          "code",
        ].sort(),
      );
      if (record.content.state === "completed") {
        assert.equal(record.content.rowCount, payload.rows.length);
        assert.equal(record.content.truncated, false);
        assert.equal(record.content.reason, null);
        assert.equal(record.content.code, null);
      } else {
        assert.equal(record.content.rowCount, null);
        assert.equal(record.content.truncated, false);
      }
    }
    const metadata = JSON.stringify(records);
    for (const excluded of [
      "SELECT",
      "parameters",
      "payload",
      '"rows"',
      "fixture-secret",
      sourceDatabase,
      password,
    ])
      assert.equal(metadata.includes(excluded), false, `execution history leaked ${excluded}`);
    assert.equal((await fetch(`${base}/api/history/executions`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/history/${workspace}/${source}/export`, {
          method: "POST",
          headers: { origin, "x-test-owner": owner, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      404,
      "revoked Connector cannot authorize a cached result export",
    );
    const endpoint = `${base}/api/data-sources/workspaces/${workspace}/${source}/queries`;
    assert.equal(
      (
        await fetch(`${endpoint}/${completedSnapshot.id}`, {
          method: "DELETE",
          headers: { origin, "x-test-owner": owner },
        })
      ).status,
      404,
      "revocation must also deny result-clear requests",
    );
    assert.deepEqual(
      (await executions()).find((entry) => entry.id === completedSnapshot.id),
      completedSnapshot,
    );
    const body = JSON.stringify({
      requestId: randomUUID(),
      instanceId: randomUUID(),
      scopeToken: randomBytes(32).toString("base64url"),
      submittedAt: Date.now(),
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    });
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: "http://evil.example",
            "x-test-owner": owner,
            "content-type": "application/json",
          },
          body,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/data-sources/workspaces/${randomUUID()}/${source}/queries`, {
          method: "POST",
          headers: { origin, "x-test-owner": owner, "content-type": "application/json" },
          body,
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    modelServer.closeAllConnections();
    await new Promise<void>((resolvePromise) => modelServer.close(() => resolvePromise()));
    service.close();
    await registry.close();
    await rm(dir, { recursive: true, force: true });
    await pool.end();
    if (userCreated) await admin.query(`DROP USER '${username}'@'localhost'`);
    if (sourceCreated) await admin.query(`DROP DATABASE \`${sourceDatabase}\``);
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
