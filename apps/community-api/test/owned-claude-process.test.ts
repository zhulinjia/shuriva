import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { privateDirectory } from "../src/mcp-client/programs.js";
import { pinExecutable } from "../src/mcp-client/windows-files.js";
import { apiPackageRoot } from "../src/package-path.js";
import { packageFixture } from "./external-program-fixture.js";
import {
  claudeTrace,
  expectClaudeFailure,
  finishClaudeOperation,
  ownedClaudeProgram,
  prepareClaudeProgram,
} from "./owned-claude-process.js";

test("G5 cleanup retains a primary failure unchanged when teardown succeeds", async () => {
  const primary = Error("operation failed");
  await assert.rejects(
    finishClaudeOperation(Promise.reject(primary), async () => {}),
    (error) => error === primary,
  );
});

test("G5 cleanup retains both the primary and teardown failures with their cause", async () => {
  const primary = Error("operation failed"),
    teardown = Error("Job accounting failed");
  await assert.rejects(
    finishClaudeOperation(Promise.reject(primary), async () => {
      throw teardown;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, teardown]);
      return true;
    },
  );
  await assert.rejects(
    finishClaudeOperation(Promise.resolve(), async () => {
      throw teardown;
    }),
    (error) => error === teardown,
  );
});

const windows = process.platform === "win32" && process.arch === "x64";
test("G5 query setup failure removes the already packaged owned fixture", {
  skip: !windows,
}, async () => {
  const packaged = await packageFixture("export {}"),
    primary = Error("query initialization failed");
  await assert.rejects(
    prepareClaudeProgram(packaged, async () => {
      throw primary;
    }),
    (error) => error === primary,
  );
  await assert.rejects(stat(packaged.root), { code: "ENOENT" });
});

test("G5 inspection failure closes query library and fixture while retaining cleanup categories", {
  skip: !windows,
}, async () => {
  const packaged = await packageFixture("export {}"),
    primary = Error("inspection failed"),
    query = Error("query unload failed"),
    files = Error("fixture deletion diagnostic");
  const remove = packaged.close;
  packaged.catalog.inspect = async () => {
    throw primary;
  };
  packaged.close = async () => {
    await remove();
    throw files;
  };
  let closed = 0;
  await assert.rejects(
    prepareClaudeProgram(packaged, async () => ({
      open: () => undefined,
      close: () => {
        closed++;
        throw query;
      },
    })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      const cleanup: unknown = error.errors[1];
      assert.ok(cleanup instanceof AggregateError);
      assert.deepEqual(
        cleanup.errors.map((failure: Error) => failure.message),
        ["Claude query library cleanup", "Claude packaged fixture cleanup"],
      );
      assert.deepEqual(
        cleanup.errors.map((failure: Error) => failure.cause),
        [query, files],
      );
      return true;
    },
  );
  assert.equal(closed, 1);
  await assert.rejects(stat(packaged.root), { code: "ENOENT" });
});

test("G5 protected config cannot be replaced and relay overflow invalidates exact-count evidence", {
  skip: !windows,
  timeout: 30000,
}, async (t) => {
  const root = resolve(apiPackageRoot(), "../../.cache", `g5-claude-observer-${randomUUID()}`);
  const config = join(root, "mcp.json"),
    trace = join(root, "trace.jsonl"),
    child = join(root, "input-consumer.mjs");
  let acquired = false,
    unpin: (() => void) | undefined;
  let program: Awaited<ReturnType<typeof ownedClaudeProgram>> | undefined;
  await finishClaudeOperation(
    (async () => {
      await privateDirectory(root, resolve(apiPackageRoot(), "bin/mcp-host.exe"), true);
      acquired = true;
      await writeFile(config, "{}", { flag: "wx" });
      unpin = await pinExecutable(config);
      await assert.rejects(writeFile(config, "replaced"));
      await assert.rejects(rename(root, `${root}-moved`));
      await writeFile(child, "process.stdin.resume();", { flag: "wx" });
      program = await ownedClaudeProgram();
      // Run the actual relay under the existing Job, not a mock recorder. Its
      // child simply consumes input, so no protocol/domain operation is executed.
      const relay = resolve(apiPackageRoot(), "test/fixtures/g5-claude-stdio-observer.mjs");
      const source = `import{spawn}from'node:child_process';const p=spawn(process.execPath,${JSON.stringify([relay, child, "synthetic-reference", trace])},{stdio:['pipe','ignore','ignore'],windowsHide:true});p.stdin.on('error',()=>{});for(let i=0;i<120;i++)p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method:'tools/call',params:{name:i===0?'UNTRUSTED_TOOL_DO_NOT_LOG':'workspaces_list',arguments:{marker:'UNTRUSTED_ARGUMENT_DO_NOT_LOG'}}})+'\\n');p.stdin.end();p.once('exit',code=>{process.exitCode=code??1;});`;
      const run = await program.start({
        executable: process.execPath,
        args: ["--input-type=module", "-e", source],
        cwd: root,
        env: { SystemRoot: process.env.SystemRoot ?? "" },
        trace,
        timeoutMs: 10000,
        signal: t.signal,
      });
      const result = await run.finished;
      assert.equal(result.code, 0);
      assert.equal(run.evidence.cleaned, true);
      assert.equal(run.evidence.finalAccounting?.active, 0);
      const raw = await readFile(trace, "utf8");
      assert.equal(raw.includes("UNTRUSTED_TOOL_DO_NOT_LOG"), false);
      assert.equal(raw.includes("UNTRUSTED_ARGUMENT_DO_NOT_LOG"), false);
      const recorded = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; tool?: string });
      assert.deepEqual(
        recorded.find((event) => event.event === "call"),
        { event: "call", tool: "other" },
      );
      assert.equal(recorded.filter((event) => event.event === "trace_overflow").length, 1);
      await assert.rejects(claudeTrace(trace), /G5_CLAUDE_TRACE_OVERFLOW/);
    })(),
    async () => {
      let cleaned = false;
      await finishClaudeOperation(
        (async () => {
          await program?.close();
          cleaned = true;
        })(),
        async () => {
          if (cleaned) {
            unpin?.();
            if (acquired) await rm(root, { recursive: true, force: true });
          }
        },
      );
    },
  );
});

test("G5 actual fault-file write failure and failed outcome assertion are both observed", {
  skip: !windows,
  timeout: 30000,
}, async (t) => {
  const root = resolve(apiPackageRoot(), "../../.cache", `g5-claude-fault-write-${randomUUID()}`);
  let acquired = false,
    program: Awaited<ReturnType<typeof ownedClaudeProgram>> | undefined;
  await finishClaudeOperation(
    (async () => {
      await privateDirectory(root, resolve(apiPackageRoot(), "bin/mcp-host.exe"), true);
      acquired = true;
      program = await ownedClaudeProgram();
      const run = await program.start({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: root,
        env: { SystemRoot: process.env.SystemRoot ?? "" },
        trace: join(root, "trace.jsonl"),
        timeoutMs: 10000,
        signal: t.signal,
      });
      await run.fault();
      // wx must now fail with EEXIST. The intentionally different expectation
      // also fails; neither rejected promise may escape as unhandled.
      await assert.rejects(
        expectClaudeFailure(run, /INTENTIONALLY_DIFFERENT_OUTCOME/, () => run.fault()),
        (error) => {
          assert.ok(error instanceof AggregateError);
          const primary: unknown = error.cause;
          assert.ok(primary instanceof Error && "code" in primary);
          assert.equal(primary.code, "EEXIST");
          assert.equal(error.errors[0], primary);
          const recovery: unknown = error.errors[1];
          assert.ok(recovery instanceof AggregateError);
          assert.ok(
            recovery.errors.some(
              (failure: Error) => failure.message === "Claude failure assertion",
            ),
          );
          return true;
        },
      );
      assert.equal(run.evidence.cleaned, true);
      assert.equal(run.evidence.finalAccounting?.active, 0);
    })(),
    async () => {
      await program?.close();
      if (acquired) await rm(root, { recursive: true, force: true });
    },
  );
});
