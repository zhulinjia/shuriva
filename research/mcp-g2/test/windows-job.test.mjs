import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const broker = fileURLToPath(new URL("../windows/job-broker.ps1", import.meta.url));
const shell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ["wait", "graceful"]) {
  test(`owned Windows Job reaps real SDK child and descendant on ${mode === "wait" ? "broker crash" : "normal shutdown"}`, {
    skip: process.platform !== "win32",
    timeout: 40000,
  }, async () => {
    const root = await mkdtemp(path.join(workspace, ".cache", "g2-job-"));
    const metadata = path.join(root, "metadata.json");
    const processHandle = spawn(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        broker,
        "-JobName",
        `stackoryn-g2-${randomUUID().replaceAll("-", "")}`,
        "-MetadataFile",
        metadata,
        "-NodePath",
        process.execPath,
        "-Mode",
        mode,
      ],
      {
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          ProgramFiles: process.env.ProgramFiles,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          PATH: `${path.dirname(process.execPath)};${path.join(process.env.SystemRoot, "System32")}`,
          ComSpec: path.join(process.env.SystemRoot, "System32/cmd.exe"),
          windir: process.env.SystemRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let errorOutput = "";
    processHandle.stdout.on("data", (v) => {
      errorOutput = (errorOutput + v).slice(-2000);
    });
    processHandle.stderr.on("data", (v) => {
      errorOutput = (errorOutput + v).slice(-2000);
    });
    const exited = once(processHandle, "exit");
    let info;
    try {
      // Broker compilation/startup precedes its own 15s worker deadline. Do not
      // terminate the test before that owned lifecycle budget can be observed.
      const deadline = performance.now() + 20000;
      while (performance.now() < deadline && !info) {
        try {
          info = JSON.parse(await readFile(metadata, "utf8"));
        } catch {
          if (processHandle.exitCode !== null)
            throw new Error(
              `G2_JOB_START_FAILED_${processHandle.exitCode}: ${root} ${errorOutput}`,
            );
          await delay(30);
        }
      }
      assert.ok(info, "owned job must report actual SDK child identities");
      assert.ok(Object.values(info).every((pid) => Number.isInteger(pid) && pid > 0));
      if (mode === "wait") {
        assert.ok(Object.values(info).every(alive));
        processHandle.kill(); // only the child object created by this test
      }
      await exited;
      const deadlineExit = performance.now() + 3000;
      while (Object.values(info).some(alive) && performance.now() < deadlineExit) await delay(30);
      assert.ok(
        Object.values(info).every((pid) => !alive(pid)),
        "job must reap the owned descendants",
      );
    } finally {
      if (processHandle.exitCode === null) processHandle.kill();
    }
  });
}

test("broker and worker reject an owned-prefix junction before writing any artifact", {
  skip: process.platform !== "win32",
}, async () => {
  const target = await mkdtemp(path.join(workspace, ".cache", "g2-junction-target-"));
  const link = path.join(workspace, ".cache", `g2-job-${randomUUID().replaceAll("-", "")}`);
  await symlink(target, link, "junction");
  for (const script of [
    broker,
    fileURLToPath(new URL("../windows/job-worker.ps1", import.meta.url)),
  ]) {
    await assert.rejects(() =>
      promisify(execFile)(
        shell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          "-JobName",
          `stackoryn-g2-${randomUUID().replaceAll("-", "")}`,
          "-MetadataFile",
          path.join(link, "metadata.json"),
          "-NodePath",
          process.execPath,
        ],
        { windowsHide: true, timeout: 5000 },
      ),
    );
    assert.deepEqual(await readdir(target), []);
  }
});
