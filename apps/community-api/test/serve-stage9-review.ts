/** Explicit isolated browser fixture. Never an application/deployment entry point. */
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { mountWebAssets } from "../src/web-assets.js";
import { apiPackageRoot } from "../src/package-path.js";
import { externalFixture } from "./external-mcp-fixture.js";

if (process.env.STAGE9_BROWSER_REVIEW !== "1")
  throw Error("Explicit isolated browser fixture required");
if (!process.stdin.isTTY)
  throw Error("Browser fixture requires an owned interactive terminal for deterministic stop");
const f = await externalFixture();
const input = createInterface({ input: process.stdin });
let stopping: Promise<void> | undefined;
let done: () => void = () => {};
const finished = new Promise<void>((resolve) => {
  done = resolve;
});
const lifetime = setTimeout(() => void stop(), 15 * 60 * 1000);
lifetime.unref();
function stop() {
  stopping ??= (async () => {
    try {
      await f.close();
    } finally {
      clearTimeout(lifetime);
      input.close();
      done();
    }
  })();
  return stopping;
}
try {
  // Synthetic fixture password, valid only for a new guarded schema that close() removes.
  const password = "Synthetic-browser-only-2026!";
  const [updated] = await f.pool.execute<
    { affectedRows: number } & import("mysql2/promise").ResultSetHeader
  >("UPDATE account SET password=? WHERE userId=? AND providerId='credential'", [
    await hashPassword(password),
    f.identity.ownerId,
  ]);
  assert.equal(updated.affectedRows, 1);
  await f.pool.execute(
    "UPDATE workspace SET name='MCP 浏览器隔离验收' WHERE id=? AND createdByAccountId=?",
    [f.binding.workspaceId, f.identity.ownerId],
  );
  await mountWebAssets(f.app, resolve(apiPackageRoot(), "../community-web/dist"), f.origin);
  input.on("line", (line) => {
    if (line === "notify") {
      f.notifyToolsChanged();
      console.log(JSON.stringify({ event: "tools_changed" }));
    } else if (line === "stats")
      console.log(JSON.stringify({ event: "observed_calls", calls: f.stats().calls }));
    else if (line === "stop")
      void stop().catch(() => {
        process.exitCode = 1;
      });
  });
  input.once("close", () => void stop());
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  console.log(
    JSON.stringify({
      event: "browser_fixture_ready",
      origin: f.origin,
      username: f.username,
      resource: f.resource,
    }),
  );
  await finished;
} finally {
  await stop();
}
