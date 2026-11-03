import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { mcpFixture } from "./mcp-fixture.js";
test("actual HTTP incomplete headers and trickled bodies have absolute deadlines", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 30000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token(),
    url = new URL(f.resource);
  for (const part of ["header", "body"]) {
    const started = performance.now();
    let reply = "";
    await new Promise<void>((resolve, reject) => {
      const socket = connect(Number(url.port), "127.0.0.1");
      let timer: ReturnType<typeof setInterval>;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(Error("absolute receive deadline missing"));
      }, 8000);
      socket.once("connect", () => {
        socket.write(
          part === "header"
            ? `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: slow`
            : `POST /mcp HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{`,
        );
        timer = setInterval(() => socket.write(" "), 100);
      });
      socket.on("data", (bytes) => {
        reply += bytes.toString();
      });
      socket.on("error", () => {});
      socket.once("close", () => {
        clearTimeout(timeout);
        clearInterval(timer);
        resolve();
      });
    });
    assert.ok(performance.now() - started < 7500);
    if (part === "body") assert.match(reply, /408/);
  }
});
