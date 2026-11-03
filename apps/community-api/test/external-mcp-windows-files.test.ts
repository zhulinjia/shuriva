import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readExternalConfig } from "../src/mcp-client/config.js";
import { fileHash } from "../src/mcp-client/program-files.js";
import { pinExecutable } from "../src/mcp-client/windows-files.js";

test("G4 default control-plane ports remain excluded for aliases", () => {
  for (const [origin, port] of [
    ["http://localhost", 80],
    ["https://localhost", 443],
  ] as const) {
    const c = readExternalConfig(
      { ENABLE_STAGE9_MCP_CLIENT: "1", ENABLE_STAGE7_HISTORY: "1" },
      origin,
      3000,
    );
    assert.ok(c?.controlPorts.includes(port));
  }
});
test("G4 approved host image cannot be changed or replaced while pinned", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "shuriva-g4-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "owned-host.exe");
  await writeFile(file, "synthetic image file for handle sharing policy", { flag: "wx" });
  const expected = (await fileHash(file)).sha256;
  const unpin = await pinExecutable(file, expected);
  try {
    await assert.rejects(writeFile(file, "tampered"));
    await assert.rejects(rename(file, join(root, "moved.exe")));
  } finally {
    unpin();
  }
  await writeFile(file, "tampered");
  await assert.rejects(pinExecutable(file, expected), /PROGRAM_CHANGED/);
});
