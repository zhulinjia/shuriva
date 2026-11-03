import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { mcpFixture } from "./mcp-fixture.js";

test("lost HTTP handoff response does not mark receipt or resend the draft", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const f = await mcpFixture("http", undefined, undefined, true);
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` };
  const subject = await f.runtime.oauth.verify(headers),
    id = randomUUID();
  await f.runtime.invocations.prepareChange(subject, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    plan: {
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    },
  });
  const response = await f.request(`/api/mcp/change-drafts/${id}`);
  assert.equal(response.status, 200);
  const review: { commitment: string } = await response.json();
  const body = JSON.stringify({ commitment: review.commitment });
  await new Promise<void>((resolve, reject) => {
    const outgoing = request(
      `${f.origin}/api/mcp/change-drafts/${id}/claim`,
      {
        method: "POST",
        headers: { ...f.headers, "content-length": Buffer.byteLength(body) },
      },
      (incoming) => {
        // Discard the socket immediately on headers. No browser code consumes the payload.
        incoming.destroy();
        resolve();
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
  const row = await f.runtime.store.invocation(f.identity.ownerId, id);
  assert.equal(row?.state, "handoff_unknown");
  const replay = await f.request(`/api/mcp/change-drafts/${id}/claim`, {
    commitment: review.commitment,
  });
  assert.notEqual(replay.status, 200);
});
