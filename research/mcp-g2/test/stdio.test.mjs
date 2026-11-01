import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BoundedStdioInput } from "../dist/stdio-boundary.js";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

test("official default protocol profile works over stdio without a probe sibling", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture],
    env: { SystemRoot: process.env.SystemRoot ?? "", G2_PROTOCOL_PROFILE: "2025-11-25" },
    stderr: "pipe",
    maxBufferSize: 65536,
  });
  const client = new Client({ name: "g2-standard-profile-client", version: "0.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
    const result = await client.callTool({ name: "process_info", arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).pid, transport.pid);
  } finally {
    await client.close();
  }
});

test("real SDK stdio discovery/call has a minimal environment and closes its child", async () => {
  process.env.G2_PARENT_CANARY = "synthetic-parent-only";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture],
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    stderr: "pipe",
    maxBufferSize: 65536,
  });
  const client = new Client(
    { name: "g2-stdio-client", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 1);
    const result = await client.callTool({ name: "process_info", arguments: {} });
    const info = JSON.parse(result.content[0].text);
    assert.equal(info.pid, transport.pid);
    assert.equal(info.leaked, false);
    const pid = transport.pid;
    await client.close();
    assert.throws(() => process.kill(pid, 0));
  } finally {
    delete process.env.G2_PARENT_CANARY;
    await client.close();
  }
});

test("stdio rejects actual oversized or deep input before SDK parses it", async () => {
  for (const wire of ["x".repeat(65537), `${"[".repeat(34)}0${"]".repeat(34)}\n`]) {
    const input = new BoundedStdioInput(150);
    const forwarded = [];
    input.on("data", (v) => forwarded.push(v));
    const failed = once(input, "error");
    input.write(Buffer.from(wire));
    const [error] = await failed;
    assert.match(error.message, /MCP_(INPUT|STRUCTURE)_LIMIT/);
    assert.equal(forwarded.length, 0);
  }
});

test("stdio framing timer is absolute despite trickle, split UTF8 frames still pass", async () => {
  const slow = new BoundedStdioInput(100);
  const failed = once(slow, "error");
  slow.write("{");
  const trickle = setInterval(() => {
    if (!slow.destroyed) slow.write(" ");
  }, 15);
  try {
    const [error] = await failed;
    assert.equal(error.code, "MCP_FRAME_TIMEOUT");
  } finally {
    clearInterval(trickle);
    slow.destroy();
  }
  const good = new BoundedStdioInput(100);
  const chunks = [];
  good.on("data", (v) => chunks.push(v));
  const raw = Buffer.from('{"message":"中文"}\n');
  good.write(raw.subarray(0, 13));
  good.end(raw.subarray(13));
  await once(good, "end");
  assert.equal(Buffer.concat(chunks).toString(), raw.toString());
});

test("unframed malicious stdio fixture exits on deadline rather than keeping stdin alive", async () => {
  const child = spawn(process.execPath, [fixture], {
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot ?? "",
      G2_FRAME_TIMEOUT_MS: "100",
      G2_READY_NOTICE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.resume();
  const exited = once(child, "exit").then(
    ([code]) => ({ code }),
    (error) => ({ error }),
  );
  child.stdin.on("error", () => {});
  let startupTimer, frameTimer;
  const ready = new Promise((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > 1024) reject(new Error("G2_STARTUP_NOTICE_LIMIT"));
      else if (text === "G2_STDIO_READY\n") resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("G2_STARTUP_EXIT")));
    startupTimer = setTimeout(() => reject(new Error("G2_STARTUP_TIMEOUT")), 15000);
  });
  try {
    await ready;
    clearTimeout(startupTimer);
    child.stdin.write("{");
    // Measure the framing deadline only after the child has installed its
    // input boundary. Runtime/module startup has its own bounded budget.
    frameTimer = setTimeout(() => child.kill(), 2000);
    const outcome = await exited;
    if ("error" in outcome) throw outcome.error;
    assert.equal(outcome.code, 2);
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(frameTimer);
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
