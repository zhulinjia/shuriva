import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mcpFixture } from "./mcp-fixture.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

test("HTTP SDK discovery and calls enforce bearer, host, origin, bounds and closed writes", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token();
  const unauthorized = await fetch(f.resource, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: f.cookie },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  const client = new Client(
    { name: "isolated-client", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(f.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "datasources_list",
    "operation_cancel",
    "operation_status",
    "query_prepare",
    "schema_get",
    "workspaces_list",
  ]);
  const result = await client.callTool({ name: "workspaces_list", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.ok(JSON.stringify(result).includes(f.scope.workspaceId));
  const outside = await fetch(f.resource, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://unapproved.example",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(outside.status, 403);
  const oversized = await fetch(f.resource, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ canary: "x".repeat(65537) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await f.request("/api/auth/oauth2/consent", { accept: true })).status, 404);
  const write = await f.request("/api/mcp/grants", { ...f.scope, scopes: ["change:propose"] });
  assert.equal(write.status, 403);
  await f.runtime.store.revoke(f.identity.ownerId, f.grant.id);
  await assert.rejects(() => client.listTools());
});
test("MCP Server real OAuth, consent, durable binding, human query approval and revocation", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 90000,
}, async (t) => {
  const f = await mcpFixture();
  t.after(() => f.close());
  const token = await f.token();
  const subject = await f.runtime.oauth.verify({ authorization: `Bearer ${token}` });
  assert.equal(subject.id, f.grant.id);
  assert.equal((await f.request("/api/auth/mcp-internal/token-check", { token })).status, 404);
  const id = randomUUID(),
    query = {
      requestId: id,
      workspaceId: f.scope.workspaceId,
      sourceId: f.scope.sourceId,
      sql: "SELECT id FROM customers",
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    };
  const result = await f.runtime.invocations.prepare(
    subject,
    { authorization: `Bearer ${token}` },
    query,
  );
  assert.equal(result.state, "approval_required");
  assert.equal(f.reads.jobs.status(f.binding, id), null);
  await assert.rejects(
    () =>
      f.runtime.invocations.prepare(
        subject,
        { authorization: `Bearer ${token}` },
        { ...query, sql: "SELECT secret FROM customers" },
      ),
    /MCP_REQUEST_CONFLICT/,
  );
  const review = await f.runtime.invocations.review(f.identity, id);
  await assert.rejects(
    () => f.runtime.invocations.approve(f.identity, id, "a".repeat(64), true),
    /MCP_APPROVAL_STALE/,
  );
  await f.runtime.invocations.approve(f.identity, id, String(review.commitment), true);
  const work = f.reads.jobs.claim(f.binding.connectorId);
  assert.ok(work?.type === "read");
  const task = JSON.parse(Buffer.from(work.task.payload, "base64url").toString());
  assert.deepEqual(task.delegatedScope, { customers: ["id"] });
  assert.equal((await f.request(`/api/mcp/grants/${f.grant.id}/revoke`, {})).status, 200);
  await assert.rejects(() => f.runtime.oauth.verify({ authorization: `Bearer ${token}` }));
  await assert.rejects(() => f.runtime.invocations.status(subject, id), /MCP_GRANT_REJECTED/);
});
