import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { RowDataPacket } from "mysql2/promise";
import { base, g4Runtime, origin, until } from "./g4-runtime/runtime.js";

test("versioned MCP draft requires administrator preview and one confirmation for one real Connector execution", {
  skip:
    process.env.STAGE9_G3_TEST !== "1" ||
    process.env.STAGE8_G3_TEST !== "1" ||
    process.env.STAGE8_G4_ACCEPTANCE !== "1",
  timeout: 120000,
}, async (t) => {
  const f = await g4Runtime({ mcp: true, mcpChangeDrafts: true });
  t.after(() => f.close());
  const resource = "http://127.0.0.1:43131/mcp";
  const headers = { cookie: f.cookie(), origin, "content-type": "application/json" };
  const post = async (path: string, data: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json() as Promise<Record<string, unknown>>;
  };
  const registered = await post("/api/mcp/clients", {
    name: "isolated draft fixture",
    redirectUri: "http://127.0.0.1:19492/callback",
    mode: "http",
  });
  const clientId = String(registered.clientId),
    binding = f.fixture.binding;
  await post("/api/mcp/grants", {
    clientId,
    workspaceId: binding.workspaceId,
    sourceId: binding.sourceId,
    tables: [["orders", ["id", "label"]]],
    scopes: ["metadata:read", "change:propose", "operation:read"],
    durationMinutes: 60,
  });
  const verifier = randomBytes(32).toString("base64url"),
    state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:19492/callback",
    response_type: "code",
    scope: "metadata:read change:propose operation:read",
    state,
    resource,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  const authorization = await fetch(`${base}/api/auth/oauth2/authorize?${params}`, {
    headers,
    redirect: "manual",
  });
  assert.equal(authorization.status, 302);
  const consent = new URL(String(authorization.headers.get("location"))).searchParams.get(
    "mcpConsent",
  );
  assert.ok(consent);
  const accepted = await post(`/api/mcp/consents/${consent}`, { accept: true });
  const code = new URL(String(accepted.redirectUrl)).searchParams.get("code");
  assert.ok(code);
  const exchange = await fetch(`${base}/api/auth/oauth2/token`, {
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
  assert.equal(exchange.status, 200);
  const credential: { access_token: string } = await exchange.json();
  const client = new Client(
    { name: "isolated-change", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${credential.access_token}` } },
    }),
  );
  const id = randomUUID(),
    plan = {
      operation: "update",
      table: "orders",
      changes: [{ column: "label", value: { kind: "string", value: "draft only" } }],
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    };
  const before = await f.observe();
  const proposed = await client.callTool({
    name: "change_propose",
    arguments: {
      requestId: id,
      workspaceId: binding.workspaceId,
      sourceId: binding.sourceId,
      plan,
    },
  });
  assert.equal(proposed.isError, undefined, JSON.stringify(proposed));
  const reviewResponse = await fetch(`${base}/api/mcp/change-drafts/${id}`, { headers });
  assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
  const review: { commitment: string } = await reviewResponse.json();
  const claim = await post(`/api/mcp/change-drafts/${id}/claim`, { commitment: review.commitment });
  await post(`/api/mcp/change-drafts/${id}/acknowledge`, { receipt: claim.receipt });
  const preview = await f.request("/previews", { plan, originInvocationId: id });
  assert.equal(preview.status, 201, await preview.clone().text());
  const previewed = (await preview.json()) as Record<string, unknown>;
  assert.deepEqual(await f.observe(), before, "proposing and previewing must not write");
  const confirmation = f.confirmation(previewed);
  const executed = await f.json(`/previews/${previewed.previewId}/confirm`, confirmation);
  await until(
    async () =>
      (await f.json(`/executions/${executed.executionId}`)).state === "committed" || undefined,
  );
  const repeated = await f.json(`/previews/${previewed.previewId}/confirm`, confirmation);
  assert.equal(repeated.executionId, executed.executionId);
  const retry = await client.callTool({
    name: "change_propose",
    arguments: {
      requestId: id,
      workspaceId: binding.workspaceId,
      sourceId: binding.sourceId,
      plan,
    },
  });
  assert.equal(retry.isError, undefined, JSON.stringify(retry));
  assert.ok(JSON.stringify(retry).includes("handoff_unknown"));
  const [executions] = await f.fixture.pool.query<RowDataPacket[]>(
    "SELECT id FROM mutation_execution",
  );
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.id, executed.executionId);
  const control = `stackoryn_write_${createHash("sha256").update(f.catalog()).digest("hex").slice(0, 16)}`;
  assert.match(control, /^stackoryn_write_[0-9a-f]{16}$/);
  const [totalReceipts] = await f.fixture.pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM \`${control}\`.receipts`,
  );
  assert.equal(Number(totalReceipts[0]?.count), 1);
  const after = await f.observe();
  assert.equal(after.find((row) => row.id === "1")?.label, "draft only");
  assert.deepEqual(
    after.filter((row) => row.id !== "1"),
    before.filter((row) => row.id !== "1"),
  );
});
