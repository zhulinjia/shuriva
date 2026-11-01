import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { publicModelAddress } from "../../../apps/community-api/dist/src/ai/model-network.js";
import { Admission, RateBudget } from "../dist/admission.js";
import { httpFixture } from "../dist/http-fixture.js";
import { boundedJson } from "../dist/limits.js";
import { guardedFetch } from "../dist/network.js";

function grant(overrides = {}) {
  return Object.freeze({
    id: randomUUID(),
    clientId: randomUUID(),
    ownerId: randomUUID(),
    familyId: randomUUID(),
    generation: 1,
    sessionId: randomUUID(),
    recipient: "shared-os-domain:synthetic-user",
    token: randomUUID(),
    scopes: ["metadata:read"],
    ...overrides,
  });
}
async function connect(f, token) {
  const transport = new StreamableHTTPClientTransport(new URL(f.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    onInsufficientScope: "throw",
  });
  const client = new Client(
    { name: "g2-real-sdk-client", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

test("real SDK HTTP discovery/call isolates immutable subjects and rechecks revocation", async (t) => {
  const a = grant(),
    b = grant();
  let revoked = false;
  let calls = 0;
  const f = await httpFixture(
    async (req) => {
      if (req.headers.authorization === `Bearer ${a.token}` && !revoked) return a;
      if (req.headers.authorization === `Bearer ${b.token}`) return b;
      throw new Error("invalid");
    },
    { onDispatch: () => calls++ },
  );
  t.after(() => f.close());
  const ca = await connect(f, a.token),
    cb = await connect(f, b.token);
  t.after(() => Promise.all([ca.close(), cb.close()]));
  assert.deepEqual((await ca.listTools()).tools.map((v) => v.name).sort(), ["hold", "read_scope"]);
  const [ra, rb] = await Promise.all([
    ca.callTool({ name: "read_scope", arguments: {} }),
    cb.callTool({ name: "read_scope", arguments: {} }),
  ]);
  assert.equal(JSON.parse(ra.content[0].text).clientId, a.clientId);
  assert.equal(JSON.parse(rb.content[0].text).clientId, b.clientId);
  assert.equal(JSON.parse(ra.content[0].text).recipient, a.recipient);
  assert.equal(calls, 2);
  revoked = true;
  await assert.rejects(() => ca.listTools());
  assert.equal(calls, 2);
  assert.ok((await cb.listTools()).tools.length > 0);
  await assert.rejects(
    () => cb.callTool({ name: "execute_sql", arguments: { sql: "DELETE FROM t" } }),
    (error) => error.code === -32602,
  );
  assert.equal(calls, 2);
});

test("cookie/clientId/Host/Origin never establish MCP authorization", async (t) => {
  const a = grant();
  const f = await httpFixture(async (req) => {
    if (req.headers.authorization !== `Bearer ${a.token}`) throw new Error("unauthorized");
    return a;
  });
  t.after(() => f.close());
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(
    (
      await fetch(f.url, {
        method: "POST",
        headers: { cookie: "fake=admin", "content-type": "application/json" },
        body,
      })
    ).status,
    401,
  );
  for (const header of [{ origin: "http://evil.invalid" }, { origin: "http://127.0.0.1:1" }]) {
    const r = await fetch(f.url, {
      method: "POST",
      headers: {
        ...header,
        authorization: `Bearer ${a.token}`,
        "content-type": "application/json",
      },
      body,
    });
    assert.equal(r.status, 403);
  }
  const address = new URL(f.url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  await once(socket, "connect");
  const chunks = [];
  const ended = new Promise((resolve) => socket.once("close", resolve));
  socket.on("error", () => {});
  socket.on("data", (data) => chunks.push(data));
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: evil.invalid\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
  );
  await ended;
  assert.match(Buffer.concat(chunks).toString(), /403/);
  assert.equal(f.factories(), 0);
});

test("stream byte/depth/compression/body limits reject before any SDK factory", async (t) => {
  const a = grant();
  const f = await httpFixture(async () => a, { timeoutMs: 120 });
  t.after(() => f.close());
  const address = new URL(f.url);
  async function exchange(headers, chunks) {
    const s = createConnection({ host: address.hostname, port: Number(address.port) });
    await once(s, "connect");
    const output = [];
    s.on("data", (v) => output.push(v));
    s.on("error", () => {});
    const ended = once(s, "close");
    s.write(`POST /mcp HTTP/1.1\r\nHost: ${address.host}\r\n${headers}\r\n`);
    for (const part of chunks) s.write(part);
    await ended;
    return Buffer.concat(output).toString();
  }
  const huge = "x".repeat(65537);
  assert.match(
    await exchange("Transfer-Encoding: chunked\r\n", [
      `${huge.length.toString(16)}\r\n${huge}\r\n0\r\n\r\n`,
    ]),
    /413/,
  );
  assert.match(await exchange("Content-Length: 100\r\n", ["{"]), /408/);
  const deep = `${"[".repeat(34)}0${"]".repeat(34)}`;
  assert.equal((await fetch(f.url, { method: "POST", body: deep })).status, 413);
  assert.equal(
    (await fetch(f.url, { method: "POST", body: "{}", headers: { "content-encoding": "gzip" } }))
      .status,
    415,
  );
  assert.equal(f.factories(), 0);
});

test("absolute incomplete-header deadline closes a trickling unauthenticated socket", async (t) => {
  const f = await httpFixture(
    async () => {
      throw new Error("unauthorized");
    },
    { timeoutMs: 150 },
  );
  t.after(() => f.close());
  const address = new URL(f.url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  await once(socket, "connect");
  const start = performance.now();
  socket.on("error", () => {});
  const ended = new Promise((resolve) => socket.once("close", resolve));
  socket.write("POST /mcp HTTP/1.1\r\nX-Slow:");
  const trickle = setInterval(() => {
    if (!socket.destroyed) socket.write("a");
  }, 25);
  try {
    await ended;
  } finally {
    clearInterval(trickle);
    socket.destroy();
  }
  assert.ok(performance.now() - start < 1500);
  assert.equal(f.factories(), 0);
});

test("authenticated rate/family/domain budgets survive transport rotation and capacity recovers", () => {
  let now = 0;
  const a = grant();
  const admission = new Admission(() => now);
  const holders = Array.from({ length: 4 }, () => admission.enter(a));
  assert.throws(() => admission.enter(a), /MCP_INFLIGHT_LIMIT/);
  holders.forEach((release) => {
    release();
    release();
  });
  admission.enter(a)();
  admission.enter({ ...a, id: randomUUID() })();
  admission.enter({ ...a, id: randomUUID() })();
  assert.throws(() => admission.enter({ ...a, id: randomUUID() }), /MCP_RATE_LIMIT/);
  now += 60_000;
  admission.enter(a)();
  const bounded = new RateBudget(1, 1, () => now, 1);
  bounded.take("verified-one");
  assert.throws(() => bounded.take("new-key"), /MCP_RATE_CAPACITY/);
  now += 60_000;
  bounded.take("new-key");
});

test("bounded decoder validates actual UTF8, node counts and argument limits", () => {
  assert.throws(() => boundedJson(Buffer.from([0xff])), /MCP_INPUT_INVALID/);
  assert.throws(
    () => boundedJson(Buffer.from(JSON.stringify(Array.from({ length: 257 }, () => 0)))),
    /MCP_STRUCTURE_LIMIT/,
  );
  assert.throws(
    () =>
      boundedJson(
        Buffer.from(
          JSON.stringify({
            params: {
              arguments: {
                a: "x".repeat(17000),
                b: "x".repeat(17000),
              },
            },
          }),
        ),
      ),
    /MCP_ARGUMENT_LIMIT/,
  );
  assert.deepEqual(boundedJson(Buffer.from('{"jsonrpc":"2.0","id":1}')), { jsonrpc: "2.0", id: 1 });
});

test("real SDK transport actually uses the guarded fetch injection", async (t) => {
  const a = grant();
  const f = await httpFixture(async () => a);
  t.after(() => f.close());
  const origin = new URL(f.url).origin;
  const guarded = guardedFetch(
    {
      destinations: [f.url],
      blockedOrigins: [],
      credentialOrigin: origin,
      credentialDestinations: [f.url],
      privateApprovals: [{ origin, addresses: ["127.0.0.1"] }],
      timeoutMs: 3000,
    },
    publicModelAddress,
  );
  let requests = 0;
  const transport = new StreamableHTTPClientTransport(new URL(f.url), {
    fetch: (input, init) => {
      requests++;
      return guarded(input, init);
    },
    onInsufficientScope: "throw",
    requestInit: { headers: { authorization: `Bearer ${a.token}` } },
  });
  const client = new Client(
    { name: "g2-guarded-client", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.length > 0);
  assert.ok(requests >= 2, "configuration must reach actual transport requests");
});

test("official stateless standard profile shares the same HTTP authorization boundary", async (t) => {
  const a = grant();
  let revoked = false;
  const f = await httpFixture(
    async () => {
      if (revoked) throw new Error("revoked");
      return a;
    },
    { legacy: "stateless" },
  );
  t.after(() => f.close());
  const transport = new StreamableHTTPClientTransport(new URL(f.url), {
    requestInit: { headers: { authorization: `Bearer ${a.token}` } },
    onInsufficientScope: "throw",
  });
  const client = new Client({ name: "g2-standard-profile-client", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25");
  assert.ok((await client.listTools()).tools.length > 0);
  revoked = true;
  await assert.rejects(() => client.listTools());
});

test("revocation during a real SDK tool wait prevents result disclosure without replay", async (t) => {
  const a = grant();
  let revoked = false,
    release,
    enter,
    calls = 0;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await httpFixture(
    async () => {
      if (revoked) throw new Error("revoked");
      return a;
    },
    {
      onTool: async () => {
        calls++;
        enter();
        await gate;
      },
    },
  );
  t.after(() => f.close());
  const client = await connect(f, a.token);
  t.after(() => client.close());
  const result = client.callTool({ name: "hold", arguments: {} });
  await entered;
  revoked = true;
  release();
  const denied = await result;
  assert.equal(denied.isError, true);
  assert.equal(JSON.stringify(denied).includes("finished"), false);
  assert.equal(calls, 1);
});

test("SDK cancellation reaches the actual handler but cannot claim its side effect never started", async (t) => {
  const a = grant();
  let enter,
    calls = 0,
    aborted = false;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const f = await httpFixture(async () => a, {
    onTool: async (signal) => {
      calls++;
      enter();
      await new Promise((resolve) => {
        if (signal.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  });
  t.after(() => f.close());
  const client = await connect(f, a.token);
  t.after(() => client.close());
  const controller = new AbortController();
  const result = client.callTool(
    { name: "hold", arguments: {} },
    { signal: controller.signal, timeout: 2000 },
  );
  const rejected = assert.rejects(() => result);
  await entered;
  controller.abort();
  await rejected;
  const deadline = performance.now() + 1500;
  while (!aborted && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test("SDK handler failures never disclose an adapter's raw canary message", async (t) => {
  const a = grant();
  const canary = `raw-secret-${randomUUID()}`;
  const f = await httpFixture(async () => a, {
    onTool: async () => {
      throw new Error(canary);
    },
  });
  t.after(() => f.close());
  const client = await connect(f, a.token);
  t.after(() => client.close());
  const result = await client.callTool({ name: "hold", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("disconnected abort-ignoring tool work retains permits until actual settlement", {
  timeout: 12000,
}, async (t) => {
  const a = grant();
  let now = 0,
    calls = 0,
    finished = 0,
    enter,
    release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await httpFixture(async () => a, {
    clock: () => now,
    onTool: async () => {
      if (++calls === 4) enter();
      await gate;
      finished++;
    },
  });
  t.after(async () => {
    release();
    await f.close();
  });
  const client = await connect(f, a.token);
  t.after(() => client.close());
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const results = controllers.map((controller) =>
    client
      .callTool({ name: "hold", arguments: {} }, { signal: controller.signal })
      .catch(() => null),
  );
  await entered;
  for (const controller of controllers) controller.abort();
  await Promise.all(results);
  const deadline = performance.now() + 2000;
  while (f.receivingRequests() > 0 && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    f.receivingRequests(),
    0,
    "response lifetimes must have ended before checking retained work",
  );
  now += 60000;
  await assert.rejects(() => connect(f, a.token));
  assert.equal(calls, 4);
  assert.equal(finished, 0);
  release();
  const settled = performance.now() + 2000;
  while (finished !== 4 && performance.now() < settled)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, 4);
  await new Promise((resolve) => setImmediate(resolve));
  now += 60000;
  const recovered = await connect(f, a.token);
  t.after(() => recovered.close());
  const result = await recovered.callTool({ name: "hold", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(calls, 5);
});
