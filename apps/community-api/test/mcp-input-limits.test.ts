import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { boundedJson } from "../src/mcp/input-limits.js";
import { BoundedStdioInput } from "../src/mcp/stdio-boundary.js";
import { localAddress, localFetch } from "../src/mcp/local-vault.js";

test("HTTP predecoder rejects invalid UTF8, deep, wide, oversized and overlong strings", () => {
  for (const raw of [
    Buffer.from([0xff]),
    Buffer.from(`${"[".repeat(34)}0${"]".repeat(34)}`),
    Buffer.from(JSON.stringify(Array(257).fill(0))),
    Buffer.from(JSON.stringify({ text: "x".repeat(65537) })),
    Buffer.from(JSON.stringify({ text: "x".repeat(32769) })),
  ])
    assert.throws(() => boundedJson(raw));
  assert.deepEqual(boundedJson(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
});
test("stdio rejects unframed oversized/deep input and trickle cannot renew its deadline", async () => {
  for (const bytes of [
    Buffer.from("x".repeat(65537)),
    Buffer.from(`${"[".repeat(34)}0${"]".repeat(34)}\n`),
  ]) {
    const input = new BoundedStdioInput(100);
    let sent = false;
    input.on("data", () => {
      sent = true;
    });
    const failed = once(input, "error");
    input.write(bytes);
    await failed;
    assert.equal(sent, false);
    input.destroy();
  }
  const slow = new BoundedStdioInput(60);
  const failure = once(slow, "error");
  slow.write("{");
  const trickle = setInterval(() => {
    if (!slow.destroyed) slow.write(" ");
  }, 10);
  try {
    const [error] = await failure;
    assert.equal(error.code, "MCP_FRAME_TIMEOUT");
  } finally {
    clearInterval(trickle);
    slow.destroy();
  }
});
test("stdio bridge rejects all non-exact targets before network access", async () => {
  for (const address of [
    "http://localhost:3001/mcp",
    "http://127.0.0.1:3001/mcp?q=1",
    "https://127.0.0.1:3001/mcp",
    "http://user:pass@127.0.0.1:3001/mcp",
    "http://169.254.169.254:80/mcp",
  ])
    assert.throws(() => localAddress(address, "/mcp"));
  const request = localFetch("http://127.0.0.1:3001/mcp");
  await assert.rejects(
    () => request("http://127.0.0.1:3001/api/auth", { method: "POST" }),
    /MCP_LOCAL_TARGET_REJECTED/,
  );
});
