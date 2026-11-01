import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { listenLoopback } from "../dist/loopback-listener.js";

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("owned loopback fixture binds a Fetch-compatible dynamic port", async (t) => {
  const server = createServer((_request, response) => response.end("owned"));
  const port = await listenLoopback(server);
  t.after(() => close(server));
  assert.equal(server.address().address, "127.0.0.1");
  assert.ok(port >= 49152 && port <= 65535);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "owned");
});

test("occupied candidates fail within budget without replacing or stopping another listener", async (t) => {
  const original = createServer((_request, response) => response.end("original"));
  const port = await listenLoopback(original);
  t.after(() => close(original));
  const candidate = createServer();
  let attempts = 0;
  await assert.rejects(
    () =>
      listenLoopback(candidate, () => {
        attempts++;
        return port;
      }),
    /G2_LISTENER_CAPACITY/,
  );
  assert.ok(attempts > 0 && attempts <= 16);
  assert.equal(candidate.listening, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "original");
  await assert.rejects(() => listenLoopback(candidate, () => 3306), /G2_LISTENER_PORT_REJECTED/);
  assert.equal(candidate.listening, false);
});
