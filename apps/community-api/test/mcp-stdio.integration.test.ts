import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { localEntry } from "../src/mcp/local-vault.js";
import { mcpFixture } from "./mcp-fixture.js";

test("real stdio child loads only synthetic OS-vault reference and shares the revoked local domain", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture("local_domain");
  t.after(() => f.close());
  const token = await f.token(),
    reference = randomUUID(),
    entry = localEntry(reference);
  entry.setPassword(
    JSON.stringify({
      token,
      resource: f.resource,
      clientId: f.client.clientId,
      expiresAt: Date.now() + 60000,
    }),
  );
  t.after(() => {
    entry.deletePassword();
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp-stdio.js", import.meta.url)), reference],
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    maxBufferSize: 1500000,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "isolated-stdio-client", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(
    tools.tools.some((x) => x.name === "query_prepare"),
    true,
  );
  assert.equal(
    tools.tools.some((x) => x.name === "change_propose"),
    false,
  );
  const result = await client.callTool({ name: "workspaces_list", arguments: {} });
  assert.equal(result.isError, false);
  assert.ok(JSON.stringify(result).includes("local_domain"));
  assert.equal(JSON.stringify(result).includes(token), false);
  await f.runtime.store.revoke(f.identity.ownerId, f.grant.id);
  const denied = await client.callTool({ name: "workspaces_list", arguments: {} });
  assert.equal(denied.isError, true);
  const pid = transport.pid;
  await client.close();
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0));
});

test("isolated change scope advertises only draft handoff through local stdio", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture("local_domain", undefined, undefined, true);
  t.after(() => f.close());
  const token = await f.token(),
    reference = randomUUID(),
    entry = localEntry(reference);
  entry.setPassword(
    JSON.stringify({
      token,
      resource: f.resource,
      clientId: f.client.clientId,
      expiresAt: Date.now() + 60000,
    }),
  );
  t.after(() => entry.deletePassword());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/mcp-stdio.js", import.meta.url)), reference],
    env: { SystemRoot: process.env.SystemRoot ?? "" },
    maxBufferSize: 1500000,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "isolated-change-stdio", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(
    tools.tools.some((tool) => tool.name === "change_propose"),
    true,
  );
  assert.equal(
    tools.tools.some((tool) => /confirm|execute/i.test(tool.name)),
    false,
  );
  const id = randomUUID();
  const result = await client.callTool({
    name: "change_propose",
    arguments: {
      requestId: id,
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      plan: {
        operation: "delete",
        table: "customers",
        where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
      },
    },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(JSON.stringify(result).includes("approval_required"));
  assert.equal(JSON.stringify(result).includes(token), false);
  await f.runtime.store.revoke(f.identity.ownerId, f.grant.id);
  const denied = await client.callTool({
    name: "change_propose",
    arguments: {
      requestId: randomUUID(),
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      plan: {
        operation: "delete",
        table: "customers",
        where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
      },
    },
  });
  assert.equal(denied.isError, true);
  const pid = transport.pid;
  await client.close();
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0));
});
