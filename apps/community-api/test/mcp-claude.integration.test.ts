import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { localEntry } from "../src/mcp/local-vault.js";
import { apiPackageRoot } from "../src/package-path.js";
import { mcpFixture } from "./mcp-fixture.js";
import {
  type ClaudeExit,
  claudeTrace,
  expectClaudeFailure,
  finishClaudeOperation,
  ownedClaudeProgram,
} from "./owned-claude-process.js";
import { pinExecutable } from "../src/mcp-client/windows-files.js";
import { fileHash } from "../src/mcp-client/program-files.js";
import { privateDirectory } from "../src/mcp-client/programs.js";

async function removeOwned(root: string) {
  if (
    dirname(await realpath(root)).toLowerCase() !==
    resolve(apiPackageRoot(), "../../.cache").toLowerCase()
  )
    throw Error("fixture cleanup path rejected");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function cleanupOwned(options: {
  root: string;
  program?: Pick<Awaited<ReturnType<typeof ownedClaudeProgram>>, "close">;
  entry?: ReturnType<typeof localEntry>;
  model?: ReturnType<typeof createServer>;
  fixture?: Pick<Awaited<ReturnType<typeof mcpFixture>>, "close">;
  releaseFiles?: (() => void)[];
}) {
  const failures: Error[] = [];
  let preserve = false;
  let jobsClosed = false;
  try {
    options.entry?.deletePassword();
  } catch (error) {
    failures.push(new Error("synthetic credential cleanup", { cause: error }));
    preserve = true;
  }
  try {
    await options.program?.close();
    jobsClosed = true;
  } catch (error) {
    failures.push(new Error("owned Claude Job cleanup unknown", { cause: error }));
    preserve = true;
  }
  try {
    if (options.model) {
      options.model.closeAllConnections();
      await new Promise<void>((done, reject) =>
        options.model?.close((error) => (error ? reject(error) : done())),
      );
    }
  } catch (error) {
    failures.push(new Error("synthetic model shutdown", { cause: error }));
  }
  try {
    await options.fixture?.close();
  } catch (error) {
    failures.push(new Error("isolated MCP fixture cleanup", { cause: error }));
  }
  // Failed Job shutdown leaves the inputs protected for diagnosis/recovery.
  for (const release of jobsClosed ? (options.releaseFiles ?? []) : []) {
    try {
      release();
    } catch (error) {
      failures.push(new Error("synthetic file protection cleanup", { cause: error }));
      preserve = true;
    }
  }
  if (!preserve) {
    try {
      await removeOwned(options.root);
    } catch (error) {
      failures.push(new Error("synthetic working directory cleanup", { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, "G5 fixture cleanup incomplete");
}

test("G5 unproven Job cleanup retains pins and recovery material while other teardown continues", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const root = resolve(apiPackageRoot(), "../../.cache", `g5-claude-pins-${randomUUID()}`);
  let acquired = false,
    unpin: (() => void) | undefined;
  await finishClaudeOperation(
    (async () => {
      await privateDirectory(root, resolve(apiPackageRoot(), "bin/mcp-host.exe"), true);
      acquired = true;
      const config = join(root, "mcp.json");
      await writeFile(config, "{}", { flag: "wx" });
      unpin = await pinExecutable(config);
      const unknown = Error("synthetic Job shutdown remains unknown");
      let released = 0,
        fixtureClosed = false;
      await assert.rejects(
        cleanupOwned({
          root,
          program: {
            close: async () => {
              throw unknown;
            },
          },
          fixture: {
            close: async () => {
              fixtureClosed = true;
            },
          },
          releaseFiles: [
            () => {
              released++;
              unpin?.();
            },
          ],
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors[0]?.cause, unknown);
          return true;
        },
      );
      assert.equal(fixtureClosed, true);
      assert.equal(released, 0);
      assert.equal(await realpath(root), root);
      await assert.rejects(writeFile(config, "replaced"));
      await assert.rejects(rename(root, `${root}-moved`));
    })(),
    async () => {
      // This scenario never started a Job; explicitly release the simulated
      // retained ownership only after asserting the unknown-state boundary.
      unpin?.();
      if (acquired) await removeOwned(root);
    },
  );
});

// This test is intentionally opt-in: it launches the installed third-party CLI,
// but the model endpoint, credentials, working directory and database are synthetic.
test("G5 real Claude Code discovers, calls and loses access to a revoked local-domain MCP grant", {
  skip:
    process.env.STAGE9_G5_CLAUDE_TEST !== "1" ||
    process.platform !== "win32" ||
    process.arch !== "x64",
  timeout: 120000,
}, async (t) => {
  const executable = process.env.G5_CLAUDE_EXE;
  if (!executable || !isAbsolute(executable))
    throw Error("G5_CLAUDE_EXE must be an absolute executable path");
  const cache = resolve(apiPackageRoot(), "../../.cache");
  if ((await realpath(cache)).toLowerCase() !== cache.toLowerCase())
    throw Error("fixture cache path rejected");
  const root = resolve(cache, `g5-claude-${randomUUID()}`);
  const trace = join(root, "protocol.jsonl");
  let program: Awaited<ReturnType<typeof ownedClaudeProgram>> | undefined;
  const releaseFiles: (() => void)[] = [];
  let fixture: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  let model: ReturnType<typeof createServer> | undefined;
  let entry: ReturnType<typeof localEntry> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    // The existing host creates the directory with an owner-only protected DACL
    // atomically. Pin a sentinel to deny deletion of its ancestors during use.
    await privateDirectory(root, resolve(apiPackageRoot(), "bin/mcp-host.exe"), true);
    if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
      throw Error("fixture root path rejected");
    const sentinel = join(root, "owner-boundary");
    await writeFile(sentinel, "G5 owned fixture", { flag: "wx" });
    releaseFiles.push(await pinExecutable(sentinel));
    releaseFiles.push(await pinExecutable(executable));
    const image = await fileHash(executable, 536870912);
    program = await ownedClaudeProgram();
    const baseEnv = {
      SystemRoot: process.env.SystemRoot ?? "",
      HOME: join(root, "profile"),
      USERPROFILE: join(root, "profile"),
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "local"),
      TEMP: root,
      TMP: root,
      CLAUDE_CONFIG_DIR: join(root, "config"),
      CLAUDE_CODE_SIMPLE: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      ANTHROPIC_API_KEY: "g5-local-synthetic-key",
    };
    for (const path of [
      baseEnv.HOME,
      baseEnv.APPDATA,
      baseEnv.LOCALAPPDATA,
      baseEnv.CLAUDE_CONFIG_DIR,
    ])
      await mkdir(path);
    const versionRun = await program.start({
      executable,
      args: ["--bare", "--version"],
      cwd: root,
      env: baseEnv,
      trace,
      timeoutMs: 10000,
      signal: t.signal,
    });
    const version = await versionRun.finished;
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^2\.1\.312 \(Claude Code\)/);
    assert.equal(versionRun.evidence.cleaned, true);
    const helpRun = await program.start({
      executable,
      args: ["--bare", "--help"],
      cwd: root,
      env: baseEnv,
      trace,
      timeoutMs: 10000,
      signal: t.signal,
    });
    const help = await helpRun.finished;
    assert.equal(help.code, 0);
    for (const flag of [
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      "--allowedTools",
      "--output-format",
    ])
      assert.ok(help.stdout.includes(flag), `installed CLI must expose ${flag}`);
    console.log(
      "G5_CLAUDE_IMAGE",
      JSON.stringify({ version: "2.1.312", sha256: image.sha256, size: image.size }),
    );
    fixture = await mcpFixture("local_domain");
    const token = await fixture.token(),
      reference = randomUUID();
    entry = localEntry(reference);
    entry.setPassword(
      JSON.stringify({
        token,
        resource: fixture.resource,
        clientId: fixture.client.clientId,
        expiresAt: Date.now() + 120000,
      }),
    );
    const relay = resolve(apiPackageRoot(), "test/fixtures/g5-claude-stdio-observer.mjs");
    const config = join(root, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          shuriva_g5: {
            type: "stdio",
            command: process.execPath,
            args: [relay, resolve(apiPackageRoot(), "dist/src/mcp-stdio.js"), reference, trace],
          },
        },
      }),
      { flag: "wx" },
    );
    releaseFiles.push(await pinExecutable(config));
    type Observations = {
      requests: number;
      advertised: string[];
      toolResult: boolean;
      workspaceVisible: boolean;
      projectPromptVisible: boolean;
    };
    let observation: Observations = {
      requests: 0,
      advertised: [],
      toolResult: false,
      workspaceVisible: false,
      projectPromptVisible: false,
    };
    let held: { enter(): void; blocked: Promise<void>; release(): void } | undefined;
    model = createServer(async (request, response) => {
      let raw = "";
      for await (const part of request) {
        raw += part;
        if (raw.length > 1000000) {
          response.writeHead(413).end();
          return;
        }
      }
      if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end();
        return;
      }
      let body: {
        tools?: { name?: string }[];
        messages?: unknown;
        system?: unknown;
        model?: string;
      };
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400).end();
        return;
      }
      observation.requests++;
      const names = (body.tools ?? [])
        .map((tool) => tool.name)
        .filter((name): name is string => typeof name === "string");
      observation.advertised = [
        ...new Set([
          ...observation.advertised,
          ...names.filter((name) => name.startsWith("mcp__shuriva_g5__")),
        ]),
      ];
      const message = JSON.stringify(body.messages ?? []);
      observation.toolResult ||= message.includes("tool_result");
      observation.workspaceVisible ||= message.includes(
        fixture?.binding.workspaceId ?? "NO_WORKSPACE",
      );
      const visibleMessages = JSON.stringify({
        system: body.system,
        messages: body.messages,
      });
      observation.projectPromptVisible ||= [
        "禁止以猜测代替事实或业务规则",
        "Claude Code 项目规则",
        "@AGENTS.md",
      ].some((marker) => visibleMessages.includes(marker));
      if (observation.requests === 1 && held) {
        held.enter();
        await held.blocked;
        if (response.destroyed) return;
      }
      const name = "mcp__shuriva_g5__workspaces_list",
        invoke = observation.requests === 1 && names.includes(name);
      const block = invoke
        ? { type: "tool_use", id: "toolu_g5_fixture", name, input: {} }
        : { type: "text", text: "" };
      const delta = invoke
        ? { type: "input_json_delta", partial_json: "{}" }
        : {
            type: "text_delta",
            text: names.includes(name) ? "synthetic exchange complete" : "MCP tool unavailable",
          };
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_g5_fixture",
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: invoke ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "request-id": "g5-synthetic",
      });
      for (const event of events)
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>((done, reject) => {
      model?.once("error", reject);
      model?.listen(0, "127.0.0.1", done);
    });
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    const args = [
      "--mcp-config",
      config,
      "--bare",
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__shuriva_g5__workspaces_list",
      "--model",
      "claude-sonnet-4-20250514",
      "--output-format",
      "json",
      "-p",
      "Use the isolated Shuriva workspaces_list tool once.",
    ];
    const options = {
      cwd: root,
      timeoutMs: 45000,
      trace,
      env: {
        ...baseEnv,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        ANTHROPIC_API_KEY: "g5-local-synthetic-key",
      },
    };
    const run = async (
      mode: "normal" | "timeout" | "cancel" | "fault" = "normal",
      expectMcp = true,
    ) => {
      assert.ok(program);
      observation = {
        requests: 0,
        advertised: [],
        toolResult: false,
        workspaceVisible: false,
        projectPromptVisible: false,
      };
      const clientRoot = join(root, `client-${randomUUID()}`);
      await mkdir(clientRoot);
      const env = {
        ...options.env,
        HOME: join(clientRoot, "profile"),
        USERPROFILE: join(clientRoot, "profile"),
        APPDATA: join(clientRoot, "appdata"),
        LOCALAPPDATA: join(clientRoot, "local"),
        CLAUDE_CONFIG_DIR: join(clientRoot, "config"),
        TEMP: clientRoot,
        TMP: clientRoot,
      };
      for (const path of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR])
        await mkdir(path);
      let enter: () => void = () => {},
        release: () => void = () => {};
      const arrived = new Promise<void>((done) => {
        enter = done;
      });
      const blocked = new Promise<void>((done) => {
        release = done;
      });
      held = { enter, blocked, release };
      const earlier = (await claudeTrace(trace)).length;
      const controller = new AbortController();
      let owned: Awaited<ReturnType<typeof program.start>> | undefined;
      let runFailure: { error: unknown } | undefined;
      let result: ClaudeExit | undefined;
      try {
        owned = await program.start({
          executable,
          args,
          ...options,
          cwd: clientRoot,
          env,
          timeoutMs: mode === "timeout" ? 8000 : 45000,
          signal: AbortSignal.any([controller.signal, t.signal]),
        });
        await Promise.race([
          arrived,
          owned.finished.then(() => {
            throw Error("CLI finished before ownership inspection");
          }),
        ]);
        const observed = (await claudeTrace(trace)).slice(earlier);
        const cli = observed.find((event) => event.event === "claude_started");
        assert.ok(cli && Number.isSafeInteger(cli.pid) && Number.isSafeInteger(cli.wrapperPid));
        const members = owned.members();
        assert.equal(members.includes(cli.pid ?? 0), true);
        assert.equal(members.includes(cli.wrapperPid ?? 0), true);
        assert.equal(owned.evidence.beforeResume?.[0], cli.wrapperPid);
        if (expectMcp) {
          const child = observed.find((event) => event.event === "child_started");
          assert.ok(
            child && Number.isSafeInteger(child.pid) && Number.isSafeInteger(child.relayPid),
          );
          assert.equal(members.includes(child.pid ?? 0), true);
          assert.equal(members.includes(child.relayPid ?? 0), true);
          assert.ok(observation.advertised.includes("mcp__shuriva_g5__workspaces_list"));
        }
        if (mode === "normal") {
          release();
          result = await owned.finished;
          assert.equal(result.code, 0, result.stderr);
        } else {
          const expected =
            mode === "timeout"
              ? /OWNED_CLAUDE_TIMEOUT/
              : mode === "cancel"
                ? /OWNED_CLAUDE_CANCELLED/
                : /OWNED_CLAUDE_INJECTED_FAULT/;
          const current = owned;
          await expectClaudeFailure(current, expected, async () => {
            if (mode === "cancel") controller.abort();
            if (mode === "fault") await current.fault();
          });
          if (mode === "fault") {
            const injected = (await claudeTrace(trace))
              .slice(earlier)
              .filter((event) => event.event === "wrapper_fault_consumed");
            assert.deepEqual(injected, [
              { event: "wrapper_fault_consumed", code: 91, wrapperPid: cli.wrapperPid },
            ]);
          }
          assert.equal(observation.toolResult, false);
        }
        assert.equal(owned.evidence.cleaned, true);
        assert.equal(owned.evidence.finalAccounting?.active, 0);
        console.log(
          "G5_CLAUDE_JOB",
          JSON.stringify({
            mode,
            observedMembers: members.length,
            beforeResumeMembers: owned.evidence.beforeResume?.length,
            ...owned.evidence.finalAccounting,
          }),
        );
      } catch (error) {
        runFailure = { error };
      }
      await finishClaudeOperation(
        runFailure ? Promise.reject(runFailure.error) : Promise.resolve(),
        async () => {
          release();
          held = undefined;
          await owned?.close();
        },
      );
      return { result, events: (await claudeTrace(trace)).slice(earlier) };
    };
    const { result } = await run();
    assert.ok(result);
    const output: unknown = JSON.parse(result.stdout);
    assert.ok(
      output && typeof output === "object" && "is_error" in output && output.is_error === false,
    );
    assert.ok(observation.advertised.includes("mcp__shuriva_g5__workspaces_list"));
    assert.equal(observation.requests, 2);
    assert.equal(observation.toolResult, true);
    assert.equal(observation.workspaceVisible, true);
    assert.equal(observation.projectPromptVisible, false);
    const events = await claudeTrace(trace);
    console.log("G5_CLAUDE_TRACE", JSON.stringify(events));
    assert.ok(
      events.some((event) => event.event === "child_started" && Number.isInteger(event.pid)),
    );
    assert.ok(
      events.some((event) => event.event === "discover" && event.versions?.includes("2026-07-28")),
    );
    assert.ok(
      events.some(
        (event) => event.event === "discover_result" && event.versions?.includes("2026-07-28"),
      ),
    );
    assert.ok(events.some((event) => event.event === "call"));
    assert.ok(events.some((event) => event.event === "call_result" && event.ok));
    const versions = events.filter(
      (event) => event.event === "discover" || event.event === "discover_result",
    );
    console.log(
      "G5_CLAUDE_EVIDENCE",
      JSON.stringify({
        client: "Claude Code",
        versions,
        successfulCall: true,
        modelEndpoint: "synthetic loopback",
        projectPromptVisible: observation.projectPromptVisible,
      }),
    );
    for (const mode of ["timeout", "cancel", "fault"] as const) await run(mode);
    const beforeRevocation = await claudeTrace(trace);
    assert.equal(beforeRevocation.filter((event) => event.event === "call").length, 1);
    await fixture.runtime.store.revoke(fixture.identity.ownerId, fixture.grant.id);
    // Explicitly probe the original grant token against the same resource;
    // absence of tools alone is not evidence of an authorization rejection.
    const denied = await fetch(fixture.resource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      redirect: "error",
      signal: t.signal,
    });
    assert.equal(
      denied.status,
      401,
      "the original revoked grant must be rejected before body processing",
    );
    await denied.body?.cancel();
    observation = {
      requests: 0,
      advertised: [],
      toolResult: false,
      workspaceVisible: false,
      projectPromptVisible: false,
    };
    const { result: after, events: revokedEvents } = await run("normal", false);
    assert.ok(after);
    const revoked: unknown = JSON.parse(after.stdout);
    assert.ok(
      revoked && typeof revoked === "object" && "is_error" in revoked && revoked.is_error === false,
    );
    assert.equal(observation.advertised.includes("mcp__shuriva_g5__workspaces_list"), false);
    assert.equal(observation.toolResult, false);
    assert.equal(observation.workspaceVisible, false);
    assert.equal(observation.projectPromptVisible, false);
    const revokedChild = revokedEvents.find((event) => event.event === "child_started");
    assert.ok(revokedChild && Number.isSafeInteger(revokedChild.pid));
    assert.ok(
      revokedEvents.some((event) => event.event === "discover"),
      "revoked invocation must attempt MCP discovery in its own trace",
    );
    assert.equal(revokedEvents.filter((event) => event.event === "call").length, 0);
    console.log(
      "G5_CLAUDE_REVOCATION",
      JSON.stringify({
        attemptedDiscovery: true,
        originalGrantStatus: denied.status,
        toolAdvertised: false,
        toolResult: false,
      }),
    );
  } catch (error) {
    failure = { error };
  }
  await finishClaudeOperation(failure ? Promise.reject(failure.error) : Promise.resolve(), () =>
    cleanupOwned({ root, program, entry, model, fixture, releaseFiles: releaseFiles.reverse() }),
  );
});
