import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transport } from "@modelcontextprotocol/client";
import { validatedTransport } from "../src/mcp-client/transport.js";
import { Discovery, type ToolRevision } from "../src/mcp-client/discovery.js";
import { digest, snapshotTools } from "../src/mcp-client/tool-policy.js";
import { schemaValidator } from "../src/mcp-client/tool-policy.js";
import { ExternalDriver, ResolverBudget } from "../src/mcp-client/driver.js";
import { ExternalCalls } from "../src/mcp-client/calls.js";
import { ExternalMcpService } from "../src/mcp-client/service.js";
import { TerminalUpdates } from "../src/mcp-client/terminals.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer } from "node:http";
import { z } from "zod";

test("G4 correlated tool listings are validated before SDK consumers see unsafe definitions", async () => {
  let delivered = 0,
    closed = 0,
    errors = 0,
    sent = 0;
  const raw: Transport = {
    async start() {},
    async send() {
      sent++;
    },
    async close() {
      closed++;
    },
  };
  const discovery = new Discovery();
  discovery.begin();
  const transport = validatedTransport(raw, undefined, () => discovery);
  transport.onmessage = () => {
    delivered++;
  };
  transport.onerror = () => {
    errors++;
  };
  await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(sent, 1);
  raw.onmessage?.({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} });
  raw.onmessage?.({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [{ name: "bad\nremote-name", inputSchema: { $ref: "https://unapproved.invalid" } }],
    },
  });
  assert.equal(delivered, 1);
  assert.equal(errors, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});

test("discovery projects unsupported schemas before SDK and binds their complete original definitions", () => {
  const collector = new Discovery();
  collector.begin();
  const unsupported = {
    name: "headers",
    inputSchema: {
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" } },
    },
  };
  collector.request(undefined);
  const received = collector.page({ tools: [unsupported], nextCursor: "page-two" });
  assert.equal(JSON.stringify(received).includes("x-mcp-header"), false);
  collector.request("page-two");
  collector.page({ tools: [{ name: "safe", inputSchema: { type: "object" } }] });
  const snapshot = collector.complete([{ name: "headers" }, { name: "safe" }]);
  assert.equal(snapshot[0]?.status, "unsupported");
  assert.equal(snapshot[1]?.status, "available");
  const changed = new Discovery();
  changed.begin();
  changed.request(undefined);
  changed.page({
    tools: [
      { ...unsupported, annotations: { readOnlyHint: true } },
      { name: "safe", inputSchema: { type: "object" } },
    ],
  });
  assert.notEqual(
    digest(snapshot),
    digest(changed.complete([{ name: "headers" }, { name: "safe" }])),
  );
});

test("discovery fails closed for incomplete, repeated, mismatched and excessive pages", () => {
  const start = () => {
    const d = new Discovery();
    d.begin();
    d.request(undefined);
    return d;
  };
  const a = start();
  a.page({ tools: [], nextCursor: "one" });
  assert.throws(() => a.complete([]), /RESPONSE_REJECTED/);
  assert.throws(() => a.request("wrong"), /RESPONSE_REJECTED/);
  a.request("one");
  assert.throws(() => a.page({ tools: [], nextCursor: "one" }), /RESPONSE_REJECTED/);
  const b = start();
  b.page({ tools: [{ name: "same", inputSchema: { type: "object" } }], nextCursor: "next" });
  b.request("next");
  assert.throws(
    () => b.page({ tools: [{ name: "same", inputSchema: { type: "object" } }] }),
    /TOOL_REJECTED/,
  );
  const c = start();
  c.page({ tools: [] });
  assert.throws(() => c.complete([{ name: "invented" }]), /RESPONSE_REJECTED/);
  const d = start();
  assert.throws(
    () =>
      d.page({
        tools: [
          { name: "large", inputSchema: { type: "object", description: "x".repeat(270000) } },
        ],
      }),
    /LIMIT/,
  );
  const e = start();
  assert.throws(() => e.request(undefined), /RESPONSE_REJECTED/);
  const f = start();
  const manyNodes = Object.fromEntries(
    Array.from({ length: 5 }, (_, group) => [
      `g${group}`,
      {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`x${i}`, {}])),
      },
    ]),
  );
  assert.throws(
    () =>
      f.page({
        tools: [{ name: "excess", inputSchema: { type: "object", properties: manyNodes } }],
      }),
    /STRUCTURE_LIMIT/,
  );
  const largeUnknown = Array.from({ length: 5 }, () => ({
    anyOf: Array.from({ length: 110 }, () => ({})),
  }));
  assert.throws(
    () =>
      snapshotTools([
        { name: "unknown-large", inputSchema: { type: "object", anyOf: largeUnknown } },
      ]),
    /STRUCTURE_LIMIT/,
  );
  assert.throws(
    () =>
      snapshotTools([
        {
          name: "output-large",
          inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" } } },
          outputSchema: { type: "object", properties: manyNodes },
        },
      ]),
    /STRUCTURE_LIMIT/,
  );
  assert.throws(
    () => snapshotTools([{ name: "bad-dialect", inputSchema: { type: "object", $schema: 42 } }]),
    /SCHEMA_REJECTED/,
  );
  assert.equal(
    snapshotTools([
      {
        name: "union",
        inputSchema: { type: "object", properties: { x: { type: ["string", "number"] } } },
      },
    ])[0]?.status,
    "unsupported",
  );
  assert.throws(
    () =>
      snapshotTools([
        {
          name: "malformed-mixed",
          inputSchema: { type: "object", properties: { x: { type: 42, format: "uri" } } },
        },
      ]),
    /SCHEMA_REJECTED/,
  );
  const booleans = Array.from({ length: 3 }, () => ({
    anyOf: Array.from({ length: 200 }, () => false),
  }));
  assert.throws(
    () =>
      snapshotTools([
        { name: "boolean-overflow", inputSchema: { type: "object", anyOf: booleans } },
      ]),
    /STRUCTURE_LIMIT/,
  );
  assert.equal(
    snapshotTools([
      { name: "boolean-property", inputSchema: { type: "object", properties: { x: false } } },
    ])[0]?.status,
    "unsupported",
  );
  assert.equal(
    snapshotTools([
      { name: "scalar-output", inputSchema: { type: "object" }, outputSchema: { type: "string" } },
    ])[0]?.status,
    "available",
  );
  assert.equal(
    snapshotTools([
      {
        name: "strict-types",
        inputSchema: { type: "object", properties: { x: { minLength: 1 } } },
      },
    ])[0]?.status,
    "unsupported",
  );
  for (const description of [null, 123, {}]) {
    const malformed = start();
    assert.throws(
      () =>
        malformed.page({
          tools: [
            {
              name: "malformed",
              description,
              inputSchema: {
                type: "object",
                properties: { url: { type: "string", format: "uri" } },
              },
            },
          ],
        }),
      /TOOL_REJECTED/,
    );
  }
});

test("list-changed notification during discovery invalidates the entire multi-page snapshot", async () => {
  let closed = 0;
  const raw: Transport = {
    async start() {},
    async send() {},
    async close() {
      closed++;
    },
  };
  const collector = new Discovery();
  collector.begin();
  const transport = validatedTransport(raw, undefined, () => collector);
  collector.request(undefined);
  collector.page({
    tools: [{ name: "first", inputSchema: { type: "object" } }],
    nextCursor: "next",
  });
  raw.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await assert.rejects(
    transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "next" } }),
    /RESPONSE_REJECTED/,
  );
  assert.throws(() => collector.complete([{ name: "first" }]), /RESPONSE_REJECTED/);
  assert.equal(closed, 0);
  const lastPage = new Discovery();
  lastPage.begin();
  lastPage.request(undefined);
  lastPage.page({ tools: [] });
  const second = validatedTransport(raw, undefined, () => lastPage);
  second.onmessage = () => {};
  raw.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  assert.throws(() => lastPage.complete([]), /RESPONSE_REJECTED/);
});

test("transport errors invalidate an in-progress discovery even if a response arrives later", async () => {
  let closed = 0;
  let delivered = 0;
  const raw: Transport = {
    async start() {},
    async send() {},
    async close() {
      closed++;
    },
  };
  const collector = new Discovery();
  collector.begin();
  const transport = validatedTransport(raw, undefined, () => collector);
  transport.onmessage = () => {
    delivered++;
  };
  transport.onerror = () => {};
  collector.request(undefined);
  await transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  raw.onerror?.(new Error("synthetic transport error"));
  raw.onmessage?.({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered, 0);
  assert.ok(closed >= 1);
  assert.throws(() => collector.complete([]), /RESPONSE_REJECTED/);
});

test("transport close failure stays unknown and reuses one owned cleanup", async () => {
  let closes = 0,
    failures = 0;
  const raw: Transport = {
    async start() {},
    async send() {},
    async close() {
      if (++closes === 1) throw new Error("untrusted close detail");
    },
  };
  const collector = new Discovery();
  collector.begin();
  const transport = validatedTransport(
    raw,
    undefined,
    () => collector,
    undefined,
    () => {
      failures++;
    },
  );
  const errors: string[] = [];
  transport.onerror = (error) => errors.push(error.message);
  raw.onerror?.(new Error("untrusted network detail"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["EXTERNAL_MCP_NETWORK_FAILED", "EXTERNAL_MCP_CLEANUP_UNKNOWN"]);
  await assert.rejects(transport.close(), /CLEANUP_UNKNOWN/);
  assert.equal(closes, 1);
  assert.equal(failures, 1);
  assert.throws(() => collector.complete([]), /RESPONSE_REJECTED/);
});

test("transport start, send and close failures expose only fixed errors", async () => {
  const raw: Transport = {
    async start() {
      throw new Error("private provider path start");
    },
    async send() {
      throw new Error("private provider path send");
    },
    async close() {
      throw new Error("private provider path close");
    },
  };
  const transport = validatedTransport(raw);
  for (const operation of [
    () => transport.start(),
    () => transport.send({ jsonrpc: "2.0", id: 3, method: "server/discover" }),
    () => transport.close(),
  ]) {
    await assert.rejects(operation(), (error: Error) =>
      /^EXTERNAL_MCP_(NETWORK_FAILED|CLEANUP_UNKNOWN)$/.test(error.message),
    );
  }
});

test("disconnect reports unknown cleanup and keeps capacity even to concurrent requests", async () => {
  const service = Object.create(ExternalMcpService.prototype) as ExternalMcpService;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const idle = setTimeout(() => {}, 10000);
  const driver = {
    async close() {
      await gate;
      throw new Error("private process path");
    },
  };
  Reflect.set(service, "drivers", new Map([["connection", { driver, who: {}, idle }]]));
  Reflect.set(service, "disconnecting", new Map());
  Reflect.set(service, "cleanupUnknown", new Set());
  Reflect.set(service, "physical", 1);
  Reflect.set(service, "invocations", { invalidate() {} });
  Reflect.set(service, "config", { executionHostId: "fixture-host" });
  Reflect.set(service, "vault", { get: () => ({}) });
  const connection = { id: "connection", executionHostId: "fixture-host", approvedTools: [] };
  const first = service.disconnectForUser("connection");
  const second = service.disconnectForUser("connection");
  const closing = service.summary(connection as never, { ownerId: "owner", sessionId: "session" });
  assert.equal(closing.lifecycle, "closing");
  assert.equal(closing.connected, null);
  assert.equal(closing.toolsVerified, false);
  release();
  await assert.rejects(first, /CLEANUP_UNKNOWN/);
  await assert.rejects(second, /CLEANUP_UNKNOWN/);
  await assert.rejects(service.disconnectForUser("connection"), /CLEANUP_UNKNOWN/);
  assert.equal(Reflect.get(service, "physical"), 1);
  const unknown = service.summary(connection as never, { ownerId: "owner", sessionId: "session" });
  assert.equal(unknown.lifecycle, "cleanup_unknown");
  assert.equal(unknown.connected, null);
  assert.equal(unknown.toolsVerified, false);
});

test("service shutdown waits for a cleanup already in progress", async () => {
  const service = Object.create(ExternalMcpService.prototype) as ExternalMcpService;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(service, "closed", false);
  Reflect.set(
    service,
    "monitor",
    setInterval(() => {}, 10000),
  );
  Reflect.set(service, "oauth", { close() {} });
  Reflect.set(service, "invocations", { async close() {} });
  Reflect.set(service, "drivers", new Map());
  Reflect.set(service, "disconnecting", new Map([["connection", pending]]));
  Reflect.set(service, "cleanupUnknown", new Set());
  Reflect.set(service, "lease", { async close() {} });
  let finished = false;
  const closing = service.close().then(() => {
    finished = true;
  });
  assert.equal(service.close(), Reflect.get(service, "shutdown"));
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  await closing;
  assert.equal(finished, true);
});

test("service shutdown drains other owners before reporting an earlier failure", async () => {
  const service = Object.create(ExternalMcpService.prototype) as ExternalMcpService;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  Reflect.set(
    service,
    "monitor",
    setInterval(() => {}, 10000),
  );
  Reflect.set(service, "oauth", { close() {} });
  Reflect.set(service, "invocations", {
    async close() {
      throw Error("private cleanup detail");
    },
  });
  Reflect.set(service, "drivers", new Map());
  Reflect.set(service, "disconnecting", new Map([["other", pending]]));
  Reflect.set(service, "cleanupUnknown", new Set());
  let leaseClosed = false;
  Reflect.set(service, "lease", {
    async close() {
      leaseClosed = true;
    },
  });
  let settled = false;
  const closing = service.close();
  const rejected = assert.rejects(closing, /^Error: EXTERNAL_MCP_CLEANUP_UNKNOWN$/).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(leaseClosed, false);
  release();
  await rejected;
  assert.equal(leaseClosed, true);
});

test("a late retained-state write cannot overwrite the observed unknown revision", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const writes: string[] = [];
  const updates = new TerminalUpdates(async (value) => {
    writes.push(value.state);
    if (value.state === "result_retained") await gate;
  });
  updates.enqueue({ owner: "owner", id: "call", state: "result_retained" });
  updates.revise({ owner: "owner", id: "call", state: "outcome_unknown" });
  assert.equal(updates.get("call")?.state, "outcome_unknown");
  assert.deepEqual(writes, ["result_retained"]);
  release();
  await updates.settle();
  assert.deepEqual(writes, ["result_retained", "outcome_unknown"]);
  assert.equal(updates.health().pending, 0);
});

test("direct driver close never exposes an owned filesystem error", async () => {
  type DriverArgs = ConstructorParameters<typeof ExternalDriver>;
  const driver = new ExternalDriver(
    {} as DriverArgs[0],
    {} as DriverArgs[1],
    {} as DriverArgs[2],
    {} as DriverArgs[3],
    new ResolverBudget(),
    {} as DriverArgs[5],
  );
  Reflect.set(driver, "closer", async () => {
    throw Error("private run directory path");
  });
  const closing = driver.close();
  assert.equal(driver.close(), closing);
  await assert.rejects(closing, /^Error: EXTERNAL_MCP_CLEANUP_UNKNOWN$/);
});

test("unknown or duplicate response IDs cannot complete discovery; same-ID requests are not responses", async () => {
  let delivered = 0;
  let errors = 0;
  const raw: Transport = { async start() {}, async send() {}, async close() {} };
  const collector = new Discovery();
  collector.begin();
  const transport = validatedTransport(raw, undefined, () => collector);
  transport.onmessage = () => {
    delivered++;
  };
  transport.onerror = () => {
    errors++;
  };
  collector.request(undefined);
  await transport.send({ jsonrpc: "2.0", id: 1, method: "server/discover" });
  raw.onmessage?.({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} });
  assert.equal(delivered, 1);
  raw.onmessage?.({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  assert.equal(errors, 1);
  raw.onmessage?.({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  assert.equal(delivered, 1);
  assert.throws(() => collector.complete([]), /RESPONSE_REJECTED/);

  const nextRaw: Transport = { async start() {}, async send() {}, async close() {} };
  const nextCollector = new Discovery();
  nextCollector.begin();
  const next = validatedTransport(nextRaw, undefined, () => nextCollector);
  let nextErrors = 0;
  next.onerror = () => {
    nextErrors++;
  };
  nextCollector.request(undefined);
  await next.send({ jsonrpc: "2.0", id: 3, method: "server/discover" });
  nextRaw.onmessage?.({ jsonrpc: "2.0", id: 3, result: { tools: [], nextCursor: "next" } });
  nextRaw.onmessage?.({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
  assert.equal(nextErrors, 1);
  assert.throws(() => nextCollector.complete([]), /RESPONSE_REJECTED/);

  const idleRaw: Transport = { async start() {}, async send() {}, async close() {} };
  const idle = validatedTransport(idleRaw);
  let idleErrors = 0;
  idle.onerror = () => {
    idleErrors++;
  };
  idleRaw.onmessage?.({ jsonrpc: "2.0", id: "1", result: {} });
  assert.equal(idleErrors, 1);
});

test("unexpected schema compiler errors abort discovery instead of becoming unsupported tools", () => {
  const original = AjvJsonSchemaValidator.prototype.getValidator;
  AjvJsonSchemaValidator.prototype.getValidator = () => {
    throw new RangeError("synthetic compiler failure");
  };
  try {
    assert.throws(
      () => snapshotTools([{ name: "safe", inputSchema: { type: "object" } }]),
      RangeError,
    );
  } finally {
    AjvJsonSchemaValidator.prototype.getValidator = original;
  }
});

test("direct calls require a verified tool-change subscription", async () => {
  const lease = {
    run: async (
      _c: unknown,
      _who: unknown,
      work: (check: () => void, signal: AbortSignal, remaining: () => number) => Promise<void>,
    ) =>
      work(
        () => {},
        new AbortController().signal,
        () => 1000,
      ),
  };
  type DriverArgs = ConstructorParameters<typeof ExternalDriver>;
  const driver = new ExternalDriver(
    { config: { kind: "http" } } as DriverArgs[0],
    {} as DriverArgs[1],
    {} as DriverArgs[2],
    lease as unknown as DriverArgs[3],
    new ResolverBudget(),
    {} as DriverArgs[5],
  );
  Reflect.set(driver, "connected", true);
  Reflect.set(driver, "op", { who: {}, signal: new AbortController().signal, check() {} });
  const revision = Reflect.get(driver, "toolRevision") as ToolRevision;
  const tool = snapshotTools([{ name: "safe", inputSchema: { type: "object" } }])[0];
  assert.ok(tool && tool.status === "available");
  const raw: Transport = { async start() {}, async send() {}, async close() {} };
  validatedTransport(
    raw,
    undefined,
    () => undefined,
    () => revision.changed(),
  );
  let sent = 0;
  Reflect.set(driver.client, "callTool", async () => {
    sent++;
    return { content: [] };
  });
  Reflect.set(driver, "verifiedToolRevision", revision.capture());
  await assert.rejects(driver.call(tool, {}), /SUBSCRIPTION_UNAVAILABLE|SNAPSHOT_CHANGED/);
  await Promise.resolve().then(() =>
    raw.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }),
  );
  await assert.rejects(driver.call(tool, {}), /SUBSCRIPTION_UNAVAILABLE|SNAPSHOT_CHANGED/);
  assert.equal(sent, 0);
});

test("revoking approvals ignores historical snapshot and invalidates queued work", async () => {
  const service = Object.create(ExternalMcpService.prototype) as ExternalMcpService;
  const events: string[] = [];
  Reflect.set(service, "audit", async (_owner: string, event: string) => {
    events.push(event);
  });
  Reflect.set(service, "store", {
    revokeTools: async (owner: string, id: string, version: number) => {
      assert.deepEqual([owner, id, version], ["owner", "connection", 2]);
      events.push("revoked");
    },
  });
  Reflect.set(service, "invocations", {
    invalidate: () => {
      events.push("invalidated");
    },
  });
  Reflect.set(service, "drivers", new Map());
  Reflect.set(service, "disconnecting", new Map());
  Reflect.set(service, "cleanupUnknown", new Set());
  const connection = { id: "connection", workspaceId: "workspace", version: 2 };
  const who = { ownerId: "owner", sessionId: "session" };
  await service.approve(connection as never, who as never, "irrelevant-old-snapshot", []);
  assert.deepEqual(events, ["tool_approval_revocation_requested", "revoked", "invalidated"]);
  events.length = 0;
  Reflect.set(service, "ready", () => {
    throw Error("EXTERNAL_MCP_RECONNECT_REQUIRED");
  });
  await assert.rejects(
    service.approve(connection as never, who as never, "", ["safe"]),
    /RECONNECT_REQUIRED/,
  );
  assert.deepEqual(events, []);
  Reflect.set(service, "store", {
    revokeTools: async () => {
      throw Error("EXTERNAL_MCP_SESSION_EXPIRED");
    },
  });
  await assert.rejects(
    service.approve(connection as never, who as never, "", []),
    /SESSION_EXPIRED/,
  );
  assert.deepEqual(events, ["tool_approval_revocation_requested"]);
});

test("an already queued call fails before creating a driver or marking handoff", async () => {
  let drivers = 0;
  type CallArgs = ConstructorParameters<typeof ExternalCalls>;
  const calls = new ExternalCalls(
    { terminal: async () => {} } as unknown as CallArgs[0],
    {} as CallArgs[1],
    Buffer.alloc(32),
    async () => {},
    {
      check() {},
      async active() {},
      async disconnect() {},
      ready() {},
      driver() {
        drivers++;
        throw new Error("unexpected driver");
      },
    },
  );
  const call = {
    connection: { id: "connection", workspaceId: "workspace", approvedTools: [] },
    who: { ownerId: "owner" },
    record: { ownerId: "owner", id: "queued" },
    state: "running",
    handed: false,
    abort: new AbortController(),
    discard() {},
    timer: setTimeout(() => {}, 10000),
  };
  const execute = Reflect.get(calls, "execute");
  await Reflect.apply(execute, calls, [call]);
  assert.equal(drivers, 0);
  assert.equal(call.state, "failed");
  assert.equal(call.handed, false);
  assert.equal(Reflect.get(call, "error"), "EXTERNAL_MCP_TOOL_NOT_APPROVED");
  clearTimeout(call.timer);
  await calls.close();
});

test("actual SDK discovers projected tools but cannot bypass a missing call permit", async (t) => {
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  let calls = 0;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "mixed-fixture", version: "1" });
      server.registerTool(
        "safe",
        { inputSchema: z.strictObject({ text: z.string() }) },
        async ({ text }) => {
          calls++;
          return { content: [{ type: "text", text }] };
        },
      );
      server.registerTool("uri", { inputSchema: z.strictObject({ url: z.url() }) }, async () => {
        calls++;
        return { content: [] };
      });
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((req, res) => {
    seen.push(req.headers);
    void toNodeHandler(handler)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const collector = new Discovery();
  const raw = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client(
    { name: "fixture", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      listMaxPages: 5,
      enforceStrictCapabilities: true,
      jsonSchemaValidator: schemaValidator(),
    },
  );
  t.after(() => client.close());
  await client.connect(validatedTransport(raw, undefined, () => collector));
  collector.begin();
  assert.equal(calls, 0);
  const listed = await client.listTools(undefined, { cacheMode: "refresh" });
  assert.equal(collector.complete(listed.tools).length, 2);
  const afterDiscovery = seen.length;
  await assert.rejects(
    client.callTool(
      { name: "safe", arguments: { text: "hello" } },
      {
        toolDefinition: {
          name: "safe",
          inputSchema: { type: "object" },
        },
      },
    ),
    /CALL_SAFETY_UNAVAILABLE/,
  );
  assert.equal(calls, 0);
  assert.equal(seen.length, afterDiscovery);
  const disguised = {
    method: "tools/list" as const,
    toJSON: () => ({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: { name: "safe", arguments: { text: "forbidden" } },
    }),
  };
  await assert.rejects(client.request(disguised, { timeout: 2000 }), /CALL_SAFETY_UNAVAILABLE/);
  assert.equal(seen.length, afterDiscovery);
  assert.equal(calls, 0);
  assert.equal(
    seen.some((headers) => headers["mcp-method"] === "tools/call"),
    false,
  );
  assert.equal(
    seen.some((headers) => Object.keys(headers).some((name) => name.startsWith("mcp-param-"))),
    false,
  );
});

test("actual SDK cannot complete discovery after an error or a response ID type mismatch", {}, async (t) => {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "response-fixture", version: "1" });
      server.registerTool(
        "safe",
        { inputSchema: z.strictObject({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: "text", text }] }),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((req, res) => {
    void toNodeHandler(handler)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const mode of ["error", "id-type"] as const) {
    const upstream = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    let listId: string | number | undefined;
    const adapter: Transport = {
      start: () => upstream.start(),
      send(message, options) {
        if ("method" in message && message.method === "tools/list" && "id" in message)
          listId = message.id;
        return upstream.send(message, options);
      },
      close: () => upstream.close(),
      setProtocolVersion: (version) => upstream.setProtocolVersion(version),
    };
    upstream.onmessage = (message) => {
      if ("result" in message && "id" in message && message.id === listId) {
        assert.equal(typeof message.id, "number");
        if (mode === "error")
          adapter.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "synthetic rejection" },
          });
        else adapter.onmessage?.({ ...message, id: String(message.id) });
      } else adapter.onmessage?.(message);
    };
    upstream.onclose = () => adapter.onclose?.();
    upstream.onerror = (error) => adapter.onerror?.(error);
    const collector = new Discovery();
    const client = new Client(
      { name: "fixture", version: "1" },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        listMaxPages: 5,
        enforceStrictCapabilities: true,
        jsonSchemaValidator: schemaValidator(),
      },
    );
    await client.connect(validatedTransport(adapter, undefined, () => collector));
    collector.begin();
    await assert.rejects(client.listTools(undefined, { cacheMode: "refresh", timeout: 2000 }));
    assert.throws(() => collector.complete([]), /RESPONSE_REJECTED/);
    await client.close();
  }
});
