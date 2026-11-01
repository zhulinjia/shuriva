import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const binary = fileURLToPath(new URL("../../../.cache/stage9-g2-bridge.exe", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/bridge-host.mjs", import.meta.url));
const invoke = (mode) =>
  promisify(execFile)(binary, ["-node", process.execPath, "-script", script, "-mode", mode], {
    windowsHide: true,
    timeout: 7000,
    env: {
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      DATABASE_URL: "synthetic-parent-only",
      BETTER_AUTH_SECRET: "synthetic-parent-only",
    },
  });

test("real Go process owns a Node private-pipe handshake and waits for its exit", async () => {
  const { stdout } = await invoke("echo");
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.privatePipe, true);
  assert.throws(() => process.kill(result.hostPid, 0));
});

test("Go context cancellation, crash and oversized private-pipe frames fail closed", async () => {
  for (const mode of ["hang", "crash", "oversized"])
    await assert.rejects(
      () => invoke(mode),
      (error) => !error.killed && JSON.parse(error.stdout).code === "G2_IPC_FAILED",
    );
});
