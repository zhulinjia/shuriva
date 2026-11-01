import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readLoggingConfig } from "../src/logging/config.js";
import { safeError } from "../src/logging/fields.js";
import { readMigrationCommand } from "../src/migration-command.js";
import { MigrationVerificationError } from "../src/migration-error.js";

test("logging and migration configuration use fixed distinct guidance and never echo rejected values", () => {
  const actions = [
    () => readLoggingConfig({ LOG_LEVEL: "CANARY_LOG_LEVEL" }, process.cwd()),
    () => readLoggingConfig({ LOG_STDOUT_ONLY: "CANARY_STDOUT" }, process.cwd()),
    () => readLoggingConfig({ LOG_MAX_BYTES: "CANARY_BYTES" }, process.cwd()),
    () => readLoggingConfig({ LOG_DIR: "CANARY_PRIVATE_RELATIVE_DIR" }, process.cwd()),
    () => readMigrationCommand({}, ["--CANARY_OPTION"]),
    () => readMigrationCommand({}, []),
  ];
  const expected = [
    "LOG_LEVEL_INVALID",
    "LOG_STDOUT_ONLY_INVALID",
    "LOG_LIMITS_INVALID",
    "LOG_DIR_INVALID",
    "MIGRATION_OPTION_INVALID",
    "MIGRATION_DATABASE_REQUIRED",
  ];
  for (const [index, run] of actions.entries()) {
    assert.throws(run, (error: unknown) => {
      const safe = safeError(error);
      assert.equal(safe.errorCode, expected[index]);
      assert.equal(typeof safe.operatorMessage, "string");
      assert.doesNotMatch(JSON.stringify(safe), /CANARY_/);
      return true;
    });
  }
  assert.equal(
    readMigrationCommand({ DATABASE_URL: "mysql://u:p@127.0.0.1:13308/example" }, ["--stage3"])
      .stage,
    "stage3",
  );
  const integrity = safeError(new MigrationVerificationError("CANARY_SCHEMA_METADATA"));
  assert.equal(integrity.errorCode, "MIGRATION_SCHEMA_INVALID");
  assert.doesNotMatch(JSON.stringify(integrity), /CANARY_SCHEMA_METADATA/);
});

test("actual terminal entrypoints emit safe actionable codes before any database connection", {
  timeout: 60000,
}, () => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "PATHEXT",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const cases = [
    {
      file: "main.js",
      args: [],
      env: { LOG_LEVEL: "CANARY_INVALID_LOG_LEVEL", LOG_STDOUT_ONLY: "1" },
      code: "LOG_LEVEL_INVALID",
    },
    {
      file: "migrations.js",
      args: ["--CANARY_UNKNOWN_OPTION"],
      env: {},
      code: "MIGRATION_OPTION_INVALID",
    },
    { file: "migrations.js", args: [], env: {}, code: "MIGRATION_DATABASE_REQUIRED" },
    { file: "create-admin.js", args: [], env: {}, code: "ADMIN_TERMINAL_REQUIRED" },
    { file: "reset-admin.js", args: [], env: {}, code: "ADMIN_TERMINAL_REQUIRED" },
  ];
  for (const item of cases) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../src/${item.file}`, import.meta.url)), ...item.args],
      {
        env: { ...env, ...item.env },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    const records = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { errorCode?: string; operatorMessage?: string });
    assert.ok(
      records.some(
        (record) => record.errorCode === item.code && typeof record.operatorMessage === "string",
      ),
    );
    assert.doesNotMatch(output, /CANARY_/);
  }
});
