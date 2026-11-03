import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ExternalDriver, ResolverBudget } from "../src/mcp-client/driver.js";
import type { Connection } from "../src/mcp-client/model.js";
import type { ExternalConfig } from "../src/mcp-client/config.js";
import type { ExternalLease } from "../src/mcp-client/lease.js";
import type { ClientVault } from "../src/mcp-client/vault.js";
import type { ProgramCatalog } from "../src/mcp-client/programs.js";

test("real SDK subscription survives its discovery operation and protects local call handoff", async (t) => {
  let calls = 0;
  let handoffs = 0;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "subscription-fixture", version: "1" });
      server.registerTool(
        "echo",
        { inputSchema: z.strictObject({ text: z.string() }) },
        async (args) => {
          calls++;
          return { content: [{ type: "text", text: args.text }] };
        },
      );
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    void toNodeHandler(handler)(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection: Connection = {
    id: randomUUID(),
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    name: "fixture",
    executionHostId: "a".repeat(64),
    version: 1,
    disabled: false,
    credentialRef: randomUUID(),
    snapshot: [],
    snapshotHash: null,
    approvedTools: [],
    installationHash: null,
    config: {
      kind: "http",
      resource: `http://127.0.0.1:${address.port}/mcp`,
      privateApprovals: [{ origin: `http://127.0.0.1:${address.port}`, addresses: ["127.0.0.1"] }],
      authentication: "none",
      oauth: null,
      connectTimeoutMs: 10000,
      callTimeoutMs: 10000,
    },
  };
  const who = { ownerId: connection.ownerId, sessionId: randomUUID() };
  const lease = {
    async run(
      _c: unknown,
      _who: unknown,
      action: (check: () => void, signal: AbortSignal, remaining: () => number) => Promise<unknown>,
    ) {
      return action(
        () => {},
        new AbortController().signal,
        () => 5000,
      );
    },
  } as unknown as ExternalLease;
  const driver = new ExternalDriver(
    connection,
    { origin: "http://127.0.0.1:1", controlPorts: [1] } as ExternalConfig,
    { has: () => true, get: () => ({}) } as unknown as ClientVault,
    lease,
    new ResolverBudget(),
    {} as ProgramCatalog,
  );
  t.after(() => driver.close());
  const firstAbort = new AbortController();
  const tools = await driver.within(
    { who, signal: firstAbort.signal, check() {} },
    () => driver.discover(),
    async () => {},
  );
  const tool = tools.find((item) => item.name === "echo");
  assert.ok(tool && tool.status === "available");
  // Completing/cancelling the short discovery request must not own the acknowledged subscription.
  firstAbort.abort();
  await driver.within(
    { who, signal: AbortSignal.timeout(10000), check() {} },
    async () => {
      const result = await driver.call(tool, { text: "synthetic" }, undefined, () => {
        handoffs++;
      });
      assert.equal(result.content[0]?.type, "text");
    },
    async () => {},
  );
  assert.equal(calls, 1);
  assert.equal(handoffs, 1);
  handler.notify.toolsChanged();
  await new Promise((done) => setTimeout(done, 25));
  await assert.rejects(
    driver.within(
      { who, signal: AbortSignal.timeout(10000), check() {} },
      () =>
        driver.call(tool, { text: "stale" }, undefined, () => {
          handoffs++;
        }),
      async () => {},
    ),
    /SNAPSHOT_CHANGED/,
  );
  assert.equal(calls, 1);
  assert.equal(handoffs, 1);
  await driver.within(
    { who, signal: AbortSignal.timeout(10000), check() {} },
    () => driver.discover(),
    async () => {},
  );
  await handler.close();
  await new Promise((done) => setTimeout(done, 25));
  await assert.rejects(
    driver.within(
      { who, signal: AbortSignal.timeout(10000), check() {} },
      () =>
        driver.call(tool, { text: "after lost subscription" }, undefined, () => {
          handoffs++;
        }),
      async () => {},
    ),
    /NETWORK_FAILED|CLOSED|SNAPSHOT_CHANGED/,
  );
  assert.equal(calls, 1);
  assert.equal(handoffs, 1);
});

test("close owns in-flight catalog setup and returns the same shutdown outcome", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((done) => {
    release = done;
  });
  let inspected = false;
  const connection = {
    id: randomUUID(),
    credentialRef: randomUUID(),
    config: { kind: "stdio", programId: randomUUID() },
  } as Connection;
  const driver = new ExternalDriver(
    connection,
    {} as ExternalConfig,
    { has: () => true } as unknown as ClientVault,
    {} as ExternalLease,
    new ResolverBudget(),
    {
      async inspect() {
        inspected = true;
        await pending;
        return { installationHash: "not-used" };
      },
    } as unknown as ProgramCatalog,
  );
  let closed = false;
  const opening = driver.within(
    {
      who: { ownerId: randomUUID(), sessionId: randomUUID() },
      signal: new AbortController().signal,
      check() {},
    },
    () => driver.connect(),
    async () => {},
  );
  await Promise.resolve();
  assert.equal(inspected, true);
  const closing = driver.close();
  assert.equal(driver.close(), closing);
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await assert.rejects(opening, /^Error: EXTERNAL_MCP_/);
  await closing;
  assert.equal(closed, true);
});

test("real SDK refuses a server that does not honor tool-list subscriptions", async (t) => {
  let lists = 0;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "no-change-subscription", version: "1" },
        { capabilities: { tools: { listChanged: false } } },
      );
      server.registerTool("echo", { inputSchema: z.strictObject({}) }, async () => ({
        content: [],
      }));
      return server;
    },
    { legacy: "reject" },
  );
  const server = createServer((request, response) => {
    if (request.headers["mcp-method"] === "tools/list") lists++;
    void toNodeHandler(handler)(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const connection = {
    id: randomUUID(),
    credentialRef: randomUUID(),
    config: {
      kind: "http",
      resource: `${origin}/mcp`,
      privateApprovals: [{ origin, addresses: ["127.0.0.1"] }],
      authentication: "none",
      oauth: null,
      connectTimeoutMs: 10000,
      callTimeoutMs: 10000,
    },
  } as Connection;
  const lease = {
    async run(
      _c: unknown,
      _who: unknown,
      work: (check: () => void, signal: AbortSignal, remaining: () => number) => Promise<unknown>,
    ) {
      return work(
        () => {},
        new AbortController().signal,
        () => 5000,
      );
    },
  } as unknown as ExternalLease;
  const driver = new ExternalDriver(
    connection,
    { origin: "http://127.0.0.1:1", controlPorts: [1] } as ExternalConfig,
    { has: () => true, get: () => ({}) } as unknown as ClientVault,
    lease,
    new ResolverBudget(),
    {} as ProgramCatalog,
  );
  t.after(() => driver.close());
  await assert.rejects(
    driver.within(
      {
        who: { ownerId: randomUUID(), sessionId: randomUUID() },
        signal: AbortSignal.timeout(10000),
        check() {},
      },
      () => driver.discover(),
      async () => {},
    ),
    /SUBSCRIPTION_UNAVAILABLE/,
  );
  assert.equal(lists, 0);
  assert.throws(() => driver.verifySnapshot("a".repeat(64)), /NETWORK_FAILED|CLOSED/);
});
