import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { authMutationIdentity } from "../src/auth.js";
import { HistoryStore } from "../src/history/store.js";
import type { MutationAccess } from "../src/mutations/ports.js";
import { mountMutationRoutes } from "../src/mutations/routes.js";
import type { MutationService } from "../src/mutations/service.js";
import { mcpFixture } from "./mcp-fixture.js";

test("versioned source preview retains browser origin after external revocation and records changed plan", {
  skip: process.env.STAGE9_G3_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  let f: Awaited<ReturnType<typeof mcpFixture>>;
  let previewCalls = 0;
  f = await mcpFixture(
    "http",
    undefined,
    (app, auth, origin) => {
      const access = { authenticate: authMutationIdentity(auth) } as MutationAccess;
      const preview = {
        preview: async (
          _scope: unknown,
          _plan: unknown,
          proof: { connectorId: string; bindingGeneration: string },
        ) => {
          previewCalls++;
          assert.equal(proof.connectorId, f.binding.connectorId);
          assert.equal(proof.bindingGeneration, f.binding.bindingGeneration);
          return { previewId: randomUUID() };
        },
      } as unknown as MutationService;
      mountMutationRoutes(app, origin, access, preview, {
        verify: (who, scope, id, plan) =>
          f.runtime.invocations.verifyChangeOrigin({
            id,
            ...scope,
            sessionId: who.sessionId,
            plan,
          }),
        record: async (who, scope, proof, previewId) => {
          await new HistoryStore(f.pool, f.sources).appendAudit(
            who.ownerId,
            scope,
            {
              event: "mcp.change_preview_origin_verified",
              outcome: "success",
              mcpInvocationId: proof.invocationId,
              mcpPlanChanged: proof.planChanged,
              targetId: previewId,
            },
            previewId,
          );
        },
      });
    },
    true,
  );
  t.after(() => f.close());
  const token = await f.token(),
    headers = { authorization: `Bearer ${token}` };
  const grant = await f.runtime.oauth.verify(headers);
  const id = randomUUID(),
    plan = {
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    };
  await f.runtime.invocations.prepareChange(grant, headers, {
    requestId: id,
    workspaceId: f.scope.workspaceId,
    sourceId: f.scope.sourceId,
    plan,
  });
  const review = await f.request(`/api/mcp/change-drafts/${id}`);
  assert.equal(review.status, 200);
  const body: { commitment: string } = await review.json();
  const claimed = await f.request(`/api/mcp/change-drafts/${id}/claim`, {
    commitment: body.commitment,
  });
  assert.equal(claimed.status, 200);
  const payload: { receipt: string } = await claimed.json();
  const second = await f.auth.api.signInUsername({
    body: { username: f.username, password: f.password },
    returnHeaders: true,
  });
  const otherCookie = second.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const wrong = await f.request(
    `/api/mcp/change-drafts/${id}/acknowledge`,
    { receipt: payload.receipt },
    { ...f.headers, cookie: otherCookie },
  );
  assert.equal(wrong.status, 403);
  const acknowledged = await f.request(`/api/mcp/change-drafts/${id}/acknowledge`, {
    receipt: payload.receipt,
  });
  assert.equal(acknowledged.status, 200);
  const durable = await f.runtime.store.invocation(f.identity.ownerId, id);
  assert.equal(durable?.state, "handoff_unknown");
  const replay = await f.request(`/api/mcp/change-drafts/${id}/claim`, {
    commitment: body.commitment,
  });
  assert.notEqual(replay.status, 200);
  await f.runtime.store.revoke(f.identity.ownerId, f.grant.id);
  const edited = { ...plan, where: [{ ...plan.where[0], value: { kind: "integer", value: "2" } }] };
  const preview = await f.request(
    `/api/mutations/${f.scope.workspaceId}/${f.scope.sourceId}/previews`,
    { plan: edited, originInvocationId: id },
  );
  assert.equal(preview.status, 201, await preview.clone().text());
  const result = (await preview.json()) as {
    previewId: string;
    origin: { invocationId: string; planChanged: boolean };
  };
  assert.equal(result.origin.invocationId, id);
  assert.equal(result.origin.planChanged, true);
  assert.equal(previewCalls, 1);
  const saved = await new HistoryStore(f.pool, f.sources).get(f.binding, "audit", result.previewId);
  assert.equal((saved.content as { mcpInvocationId: string }).mcpInvocationId, id);
});
