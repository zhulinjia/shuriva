import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { g4Runtime, base, origin } from "./g4-runtime/runtime.js";

test("MCP SDK to real Go Connector enforces delegated fields and returns only approved results", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 120000,
}, async (t) => {
  const f = await g4Runtime({ mcp: true });
  t.after(() => f.close());
  const resource = "http://127.0.0.1:43131/mcp",
    headers = { cookie: f.cookie(), origin, "content-type": "application/json" };
  const post = async (path: string, data: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(data) });
    assert.ok(r.ok, await r.clone().text());
    return r.json() as Promise<Record<string, unknown>>;
  };
  const registered = await post("/api/mcp/clients", {
    name: "real Go fixture",
    redirectUri: "http://127.0.0.1:19492/callback",
    mode: "http",
  });
  const clientId = String(registered.clientId),
    binding = f.fixture.binding;
  await post("/api/mcp/grants", {
    clientId,
    workspaceId: binding.workspaceId,
    sourceId: binding.sourceId,
    tables: [["orders", ["id"]]],
    scopes: ["metadata:read", "query:prepare", "operation:read", "operation:cancel"],
    durationMinutes: 60,
  });
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:19492/callback",
    response_type: "code",
    scope: "metadata:read query:prepare operation:read operation:cancel",
    state,
    resource,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const response = await fetch(`${base}/api/auth/oauth2/authorize?${params}`, {
    headers,
    redirect: "manual",
  });
  assert.equal(response.status, 302, await response.clone().text());
  const consent = new URL(response.headers.get("location") as string).searchParams.get(
    "mcpConsent",
  );
  assert.ok(consent);
  const accepted = await post(`/api/mcp/consents/${consent}`, { accept: true });
  const code = new URL(String(accepted.redirectUrl)).searchParams.get("code");
  assert.ok(code);
  const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:19492/callback",
      resource,
    }),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const credential: { access_token: string } = await exchanged.json();
  const client = new Client(
    { name: "real-go-integration", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${credential.access_token}` } },
    }),
  );
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const text = Array.isArray(r.content) ? r.content[0] : undefined;
    assert.ok(text?.type === "text");
    return JSON.parse(text.text) as Record<string, unknown>;
  };
  const unchanged = await f.observe();
  for (const { sql, expected } of [
    { sql: "SELECT id FROM orders", expected: "completed" },
    { sql: "SELECT amount FROM orders", expected: "failed" },
    { sql: "DELETE FROM orders WHERE id = 1", expected: "failed" },
    { sql: "ALTER TABLE orders ADD forbidden_column INT", expected: "failed" },
  ]) {
    const id = randomUUID();
    await tool("query_prepare", {
      requestId: id,
      workspaceId: binding.workspaceId,
      sourceId: binding.sourceId,
      sql,
      parameters: [],
      maxRows: 10,
      schemaVersion: null,
    });
    const reviewResponse = await fetch(`${base}/api/mcp/invocations/${id}`, { headers });
    assert.ok(reviewResponse.ok, await reviewResponse.clone().text());
    const review: { commitment: string } = await reviewResponse.json();
    await post(`/api/mcp/invocations/${id}/decision`, {
      accept: true,
      commitment: review.commitment,
    });
    let result: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 1100));
      result = await tool("operation_status", { id });
      if (!["running", "queued"].includes(String(result.state))) break;
    }
    assert.ok(result);
    assert.equal(result.state, expected);
    if (expected === "failed") assert.equal(result.resultAvailable, false);
    else
      assert.deepEqual(result.result, {
        columns: [{ name: "id", type: "UNSIGNED BIGINT" }],
        rows: [[{ null: false, encoding: "text", value: "1" }]],
        timezone: "UTC",
        truncated: false,
      });
    assert.deepEqual(await f.observe(), unchanged);
  }
  assert.equal((await f.observe()).length, 1);
});
