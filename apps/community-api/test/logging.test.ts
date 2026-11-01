import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Writable } from "node:stream";
import express from "express";
import {
  createDiagnosticLogger,
  createDiagnosticRuntime,
  diagnostics,
  installRequestDiagnostics,
  readLoggingConfig,
  withDiagnostics,
} from "../src/logging/public.js";

test("diagnostic allowlist omits secret bodies, credentials and error messages while retaining code locations", async () => {
  const lines: string[] = [],
    logger = createDiagnosticLogger({ write: (line) => lines.push(line) }, "debug");
  const sourceId = randomUUID(),
    canary = "CANARY_mysql_password_sql_question_结果";
  const error = Object.assign(new Error(canary), {
    code: "ER_LOCK_WAIT_TIMEOUT",
    stack: `Error: ${canary}\n    at query (I:/workspace/dist/src/example.js:42:9)\n    at request (I:/workspace/node_modules/mysql2/client.js:88:2)`,
  });
  const untrusted = {
    sourceId,
    code: "UNAVAILABLE",
    password: canary,
    sql: canary,
    question: canary,
    err: error,
  };
  logger.error("query.failed", untrusted, error);
  logger.info(`bad event ${canary}`);
  const record = JSON.parse(lines[0]);
  assert.equal(record.sourceId, sourceId);
  assert.equal(record.errorCode, "ER_LOCK_WAIT_TIMEOUT");
  assert.ok(Array.isArray(record.locations));
  assert.equal(JSON.stringify(record.locations).includes("example.js"), false);
  assert.equal(lines.join("").includes(canary), false);
  assert.equal(lines.join("").includes("I:/workspace"), false);
  assert.equal(JSON.parse(lines[1]).event, "diagnostic.invalid_event");
  logger.info("query.result_received", { state: "ok", operation: "read_query" });
  const success = JSON.parse(lines[lines.length - 1]);
  assert.equal(success.state, "ok");
  assert.equal(success.operation, "read_query");
  assert.doesNotThrow(() =>
    logger.error(
      "query.failed",
      {},
      {
        get stack() {
          throw Error(canary);
        },
      },
    ),
  );
  logger.error("query.failed", {}, new Error("fake\n    at /src/fixture_private_marker.js:1:2"));
  assert.equal(lines.join("").includes("fixture_private_marker"), false);
  logger.info("query.failed", {
    code: "secret_encoded_as_code",
    state: "secret_encoded_as_state",
    operation: "secret_encoded_as_operation",
  });
  logger.info("secret.encoded_as_event");
  assert.equal(lines.join("").includes("secret_encoded"), false);
  assert.equal(lines.join("").includes("secret.encoded"), false);
});

test("HTTP correlation is unique, ignores forged IDs and follows concurrent asynchronous failures", async () => {
  const lines: string[] = [],
    logger = createDiagnosticLogger({ write: (line) => lines.push(line) });
  const app = express();
  installRequestDiagnostics(app, logger);
  app.get("/jobs/:id", async (req, res) => {
    await delay(req.params.id === "slow" ? 20 : 1);
    diagnostics.warn("job.failed", { code: "UNAVAILABLE" }, Error("secret request text"));
    res.status(503).json({ error: "UNAVAILABLE" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const responses = await Promise.all(
      ["slow", "fast"].map((id) =>
        fetch(`http://127.0.0.1:${address.port}/jobs/${id}?password=secret`, {
          headers: { "X-Request-Id": "forged\r\nvalue".replaceAll("\r\n", "") },
        }),
      ),
    );
    const ids = responses.map((r) => r.headers.get("x-request-id"));
    assert.notEqual(ids[0], ids[1]);
    const records = lines.map((line) => JSON.parse(line));
    for (const id of ids) {
      assert.equal(records.filter((r) => r.requestId === id && r.event === "job.failed").length, 1);
      assert.equal(
        records.filter((r) => r.requestId === id && r.event === "http.completed").length,
        1,
      );
    }
    assert.equal(lines.join("").includes("secret"), false);
    assert.ok(records.some((r) => r.route === "/jobs/:id" && r.status === 503));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("independent logger contexts do not leak IDs and levels suppress debug", async () => {
  const first: string[] = [],
    second: string[] = [];
  const a = createDiagnosticLogger({ write: (line) => first.push(line) }),
    b = createDiagnosticLogger({ write: (line) => second.push(line) });
  const requestId = randomUUID();
  await Promise.all([
    withDiagnostics(a, { requestId }, async () => {
      await delay(2);
      diagnostics.info("task.finished");
      diagnostics.debug("task.detail");
    }),
    withDiagnostics(b, {}, async () => diagnostics.info("task.finished")),
  ]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(JSON.parse(first[0]).requestId, requestId);
  assert.equal("requestId" in JSON.parse(second[0]), false);
});

test("local file logging rotates within retention limits, flushes, and excludes concurrent writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackoryn-diagnostics-"));
  try {
    const runtime = await createDiagnosticRuntime(
      { directory, level: "info", maxBytes: 1024, maxFiles: 2 },
      { write() {} },
    );
    await assert.rejects(
      createDiagnosticRuntime(
        { directory, level: "info", maxBytes: 1024, maxFiles: 2 },
        { write() {} },
      ),
    );
    for (let i = 0; i < 60; i++)
      runtime.logger.info("task.finished", { taskId: randomUUID(), durationMs: i });
    await runtime.close();
    assert.equal(runtime.health().closed, true);
    const names = await readdir(directory);
    assert.equal(names.includes("community-api.lock"), false);
    assert.ok(names.length >= 2 && names.length <= 3, names.join(","));
    let records = 0;
    for (const name of names)
      for (const line of (await readFile(join(directory, name), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)) {
        const record = JSON.parse(line);
        assert.equal(record.event, "task.finished");
        records++;
      }
    assert.ok(records > 0, "rotation lost every accepted log record");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logging config is bounded and an unavailable required file destination fails startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackoryn-log-config-"));
  try {
    assert.throws(() => readLoggingConfig({ LOG_LEVEL: "verbose" }, directory));
    assert.throws(() => readLoggingConfig({ LOG_MAX_BYTES: "0" }, directory));
    assert.throws(() => readLoggingConfig({ LOG_MAX_FILES: "100000" }, directory));
    assert.throws(() => readLoggingConfig({ LOG_DIR: "relative" }, directory));
    assert.equal(readLoggingConfig({ LOG_STDOUT_ONLY: "1" }, directory).directory, undefined);
    const file = join(directory, "not-a-directory");
    await writeFile(file, "owned-test");
    await assert.rejects(
      createDiagnosticRuntime(
        { directory: file, level: "info", maxBytes: 1024, maxFiles: 2 },
        { write() {} },
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostic output failure/backpressure is visible without interrupting business work", async () => {
  const asynchronous = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Error("sensitive EPIPE message"));
    },
  });
  const asynchronousRuntime = await createDiagnosticRuntime(
    { level: "info", maxBytes: 1024, maxFiles: 1 },
    asynchronous,
  );
  assert.doesNotThrow(() => asynchronousRuntime.logger.info("task.finished"));
  await delay(5);
  assert.equal(asynchronousRuntime.health().available, false);
  await asynchronousRuntime.close();
  assert.equal(asynchronous.listenerCount("error"), 0);
  let failures = 0;
  const direct = createDiagnosticLogger(
    {
      write() {
        throw Error("secret sink error");
      },
    },
    "info",
    () => {
      failures++;
    },
  );
  assert.doesNotThrow(() => direct.info("task.finished"));
  assert.equal(failures, 1);
  for (const output of [
    {
      write() {
        throw Error("sensitive destination error");
      },
    },
    {
      writableLength: 1024 * 1024,
      write() {
        throw Error("must not enqueue");
      },
    },
  ]) {
    const runtime = await createDiagnosticRuntime(
      { level: "info", maxBytes: 1024, maxFiles: 1 },
      output,
    );
    assert.doesNotThrow(() => runtime.logger.error("task.failed", { code: "UNAVAILABLE" }));
    assert.equal(runtime.health().available, false);
    await runtime.close();
  }
});

test("direct and shared loggers contain asynchronous sink failures without leaking errors", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(() => callback(Error("private output failure body")), 5);
    },
  });
  let failures = 0;
  const first = createDiagnosticLogger(output, "info", () => {
    failures++;
  });
  const second = createDiagnosticLogger(output);
  assert.equal(output.listenerCount("error"), 1);
  assert.doesNotThrow(() => first.info("task.finished"));
  await delay(20);
  assert.equal(failures, 1);
  assert.equal(output.destroyed, true);
  assert.equal(output.listenerCount("error"), 0);
  assert.doesNotThrow(() => second.error("task.failed"));
  const throwingObserver = createDiagnosticLogger(
    {
      write() {
        throw Error("sink failure");
      },
    },
    "info",
    () => {
      throw Error("observer failure");
    },
  );
  assert.doesNotThrow(() => throwingObserver.info("task.finished"));
});

test("shutdown awaits queued output and keeps one destination listener for late failures", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      setTimeout(() => callback(Error("late private EPIPE details")), 30);
    },
  });
  const first = await createDiagnosticRuntime(
    { level: "info", maxBytes: 1024, maxFiles: 1 },
    output,
  );
  const second = await createDiagnosticRuntime(
    { level: "info", maxBytes: 1024, maxFiles: 1 },
    output,
  );
  assert.equal(output.listenerCount("error"), 1);
  first.logger.info("task.finished");
  const closed = first.close();
  assert.equal(first.close(), closed);
  await Promise.all([closed, second.close()]);
  assert.equal(first.health().available, false);
  assert.equal(
    output.listenerCount("error"),
    0,
    "owned destination closed and listener was released",
  );
});

test("missing or unreadable diagnostic locks cannot cause unhandled shutdown rejections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackoryn-log-close-"));
  try {
    const lines: string[] = [];
    const runtime = await createDiagnosticRuntime(
      { directory, level: "info", maxBytes: 1024, maxFiles: 1 },
      { write: (line) => lines.push(line) },
    );
    await unlink(join(directory, "community-api.lock"));
    await mkdir(join(directory, "community-api.lock"));
    await assert.doesNotReject(runtime.close());
    assert.ok(lines.some((line) => JSON.parse(line).event === "diagnostic.close_failed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
