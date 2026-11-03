import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { test } from "node:test";
import { z } from "zod";
import { apiPackageRoot } from "../src/package-path.js";
import { externalFixture } from "./external-mcp-fixture.js";

async function selectedReferenceRoot() {
  const packagePath = process.env.G5_EVERYTHING_PACKAGE_DIR;
  if (!packagePath || !isAbsolute(packagePath))
    throw Error("G5_EVERYTHING_PACKAGE_DIR must be absolute");
  const root = await realpath(packagePath);
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== "@modelcontextprotocol/server-everything" ||
    !("version" in metadata) ||
    metadata.version !== "2.1.0" ||
    !("license" in metadata) ||
    metadata.license !== "SEE LICENSE IN LICENSE"
  )
    throw Error("expected Everything Server 2.1.0 metadata");
  if (
    !(await readFile(join(root, "README.md"), "utf8")).includes(
      "This MCP server is licensed under the MIT License",
    )
  )
    throw Error("expected upstream MIT license statement");
  const workspace = resolve(apiPackageRoot(), "../..");
  if ((await realpath(process.cwd())).toLowerCase() !== workspace.toLowerCase())
    throw Error("run this isolated test from the workspace root");
  return root;
}

async function closeReferenceServer(server: ChildProcess, reader: Interface) {
  reader.close();
  if (server.exitCode !== null || server.signalCode !== null || !server.pid) return;
  const closed = new Promise<void>((done) => server.once("close", () => done()));
  server.kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("reference process exit unknown")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (server.exitCode === null && server.signalCode === null)
    throw Error("reference process exit unknown");
}

// Explicit opt-in; operator selects and trusts the pre-installed package.
test("G5 selected Everything Server disables unsupported tools and confirms synthetic echo", {
  skip: process.env.STAGE9_G5_EVERYTHING_TEST !== "1" || process.platform !== "win32",
}, async () => {
  const root = await selectedReferenceRoot();
  const relay = resolve(apiPackageRoot(), "test/fixtures/g5-everything-http-observer.mjs");
  const server = spawn(process.execPath, [relay, join(root, "dist/transports/streamableHttp.js")], {
    cwd: root,
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: Array<{
    event?: string;
    port?: number;
    method?: string;
    echo?: boolean;
    customHeader?: boolean;
    protocol?: string;
  }> = [];
  let failure: Error | undefined;
  let traceOverflow = false;
  server.once("error", (error) => {
    failure = error;
  });
  // Server diagnostic output is discarded; request arguments are never recorded.
  server.stderr.resume();
  const reader = createInterface({ input: server.stdout });
  reader.on("line", (line) => {
    if (events.length >= 200 || line.length > 1024) {
      traceOverflow = true;
      return;
    }
    try {
      const value: unknown = JSON.parse(line);
      const event = z
        .object({
          event: z.enum(["ready", "request"]),
          port: z.number().int().min(1).max(65535).optional(),
          method: z.string().max(64).optional(),
          echo: z.boolean().optional(),
          customHeader: z.boolean().optional(),
          protocol: z.enum(["2026-07-28", "other"]).optional(),
        })
        .strict()
        .safeParse(value);
      if (event.success) events.push(event.data);
    } catch {
      /* upstream diagnostics are not protocol evidence */
    }
  });
  let testFailure: { error: unknown } | undefined;
  try {
    const deadline = performance.now() + 10000;
    while (!events.some((event) => event.event === "ready")) {
      if (failure) throw failure;
      if (server.exitCode !== null || server.signalCode !== null)
        throw Error("reference server exited before ready");
      if (performance.now() > deadline) throw Error("reference server readiness timed out");
      await new Promise((done) => setTimeout(done, 20));
    }
    const port = events.find((event) => event.event === "ready")?.port;
    assert.ok(Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535);
    const f = await externalFixture();
    try {
      const resource = `http://127.0.0.1:${port}/mcp`;
      const { id } = await f.service.create(f.identity, {
        workspaceId: f.binding.workspaceId,
        name: "Synthetic reference",
        config: {
          ...f.httpConfig,
          resource,
          privateApprovals: [{ origin: new URL(resource).origin, addresses: ["127.0.0.1"] }],
        },
      });
      let c = await f.service.connection(f.identity, f.binding.workspaceId, id);
      await f.service.discover(c, f.identity);
      c = await f.service.connection(f.identity, f.binding.workspaceId, id);
      const available = c.snapshot.find((tool) => tool.name === "echo");
      assert.equal(available?.status, "available");
      for (const name of [
        "get-header-params",
        "gzip-file-as-resource",
        "trigger-url-elicitation",
      ]) {
        assert.equal(c.snapshot.find((tool) => tool.name === name)?.status, "unsupported");
        await assert.rejects(
          f.service.approve(c, f.identity, c.snapshotHash ?? "", [name]),
          /EXTERNAL_MCP_SNAPSHOT_CHANGED/,
        );
        await assert.rejects(
          f.service.invocations.prepare(c, f.identity, name, {}),
          /EXTERNAL_MCP_TOOL_NOT_APPROVED/,
        );
      }
      await assert.rejects(
        f.service.invocations.prepare(c, f.identity, "echo", { message: "synthetic" }),
        /EXTERNAL_MCP_TOOL_NOT_APPROVED/,
      );
      assert.equal(events.filter((event) => event.method === "tools/call").length, 0);
      await f.service.approve(c, f.identity, c.snapshotHash ?? assert.fail("missing snapshot"), [
        "echo",
      ]);
      c = await f.service.connection(f.identity, f.binding.workspaceId, id);
      const q = await f.service.invocations.prepare(c, f.identity, "echo", {
        message: "synthetic",
      });
      await f.service.invocations.confirm(c, f.identity, q.id);
      let state = "";
      for (let i = 0; i < 160; i++) {
        state =
          (await f.service.invocations.history(c, f.identity)).find((row) => row.id === q.id)
            ?.state ?? "";
        if (state && !["pending_approval", "running", "cancel_requested"].includes(state)) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(state, "succeeded");
      const response = await f.request(`${f.base}/${id}/calls/${q.id}/result`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.content[0].text, "Echo: synthetic");
      const requests = events.filter((event) => event.event === "request");
      assert.equal(traceOverflow, false);
      assert.equal(
        requests.some((event) => event.customHeader),
        false,
      );
      assert.equal(
        requests.filter((event) => event.method === "tools/call" && event.echo).length,
        1,
      );
      assert.ok(
        requests.some(
          (event) => event.method === "server/discover" && event.protocol === "2026-07-28",
        ),
      );
      assert.ok(requests.some((event) => event.echo && event.protocol === "2026-07-28"));
      assert.equal(
        requests.some((event) => event.method === "tools/call" && !event.echo),
        false,
      );
      console.log(
        "G5_EVERYTHING_EVIDENCE",
        JSON.stringify({
          version: "2.1.0",
          discovered: c.snapshot.length,
          unsupported: c.snapshot.filter((tool) => tool.status === "unsupported").length,
          echoCalls: 1,
          protocol: "2026-07-28",
          customParameterHeaders: false,
        }),
      );
    } finally {
      await f.close();
    }
  } catch (error) {
    testFailure = { error };
  }
  try {
    await closeReferenceServer(server, reader);
  } catch (error) {
    if (testFailure)
      throw new AggregateError([testFailure.error, error], "G5 test and process cleanup failed");
    throw error;
  }
  if (testFailure) throw testFailure.error;
});

test("G5 reference process is reaped when the isolated test fails", {
  skip: process.env.STAGE9_G5_EVERYTHING_TEST !== "1" || process.platform !== "win32",
}, async () => {
  const root = await selectedReferenceRoot();
  const modulePath = join(root, "dist/transports/streamableHttp.js");
  const relay = resolve(apiPackageRoot(), "test/fixtures/g5-everything-http-observer.mjs");
  const server = spawn(process.execPath, [relay, modulePath], {
    cwd: root,
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure: Error | undefined;
  server.once("error", (error) => {
    failure = error;
  });
  server.stderr.resume();
  const reader = createInterface({ input: server.stdout });
  let ready = false;
  reader.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (message && typeof message === "object" && "event" in message && message.event === "ready")
        ready = true;
    } catch {
      /* only the synthetic readiness event matters */
    }
  });
  let caught = false;
  try {
    try {
      const deadline = performance.now() + 10000;
      while (!ready) {
        if (failure) throw failure;
        if (server.exitCode !== null || server.signalCode !== null)
          throw Error("reference process exited before ready");
        if (performance.now() > deadline) throw Error("reference process readiness timed out");
        await new Promise((done) => setTimeout(done, 20));
      }
      throw Error("synthetic test failure");
    } finally {
      await closeReferenceServer(server, reader);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "synthetic test failure") throw error;
    caught = true;
  }
  assert.equal(caught, true);
  assert.ok(server.exitCode !== null || server.signalCode !== null);
});
