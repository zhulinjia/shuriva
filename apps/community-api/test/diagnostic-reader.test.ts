import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { test } from "node:test";
import { apiPackageRoot } from "../src/package-path.js";

test("local diagnostic lookup supports configured JSON/log basenames and bounds corrupt records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackoryn-log-reader-"));
  try {
    const taskId = randomUUID();
    const records = ["custom-service.jsonl", "custom-connector.log", "custom-service.jsonl.1"];
    for (const file of records)
      await writeFile(
        join(directory, file),
        `${JSON.stringify({ taskId, event: "task.finished" })}\n${JSON.stringify({ taskId: randomUUID(), event: "task.finished" })}\n`,
      );
    await writeFile(join(directory, "ignored.txt"), `private file\n`);
    await writeFile(
      join(directory, "corrupt.log"),
      `not JSON\n${"x".repeat(100000)}\n${JSON.stringify({ taskId, event: "task.failed" })}\n`,
    );
    const result = await promisify(execFile)(process.execPath, [
      resolve(apiPackageRoot(), "../../scripts/read-diagnostics.mjs"),
      "--dir",
      directory,
      "--id",
      taskId,
    ]);
    const found = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(found.length, 4);
    assert.ok(found.every((row) => row.taskId === taskId));
    assert.equal(result.stdout.includes("private file"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
