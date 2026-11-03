import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { MutationAccess, MutationTransport } from "../src/mutations/ports.js";
import { MutationError } from "../src/mutations/model.js";
import { mountMutationRoutes } from "../src/mutations/routes.js";
import { MutationService } from "../src/mutations/service.js";
import { mutationFixture } from "./mutation-fixture.js";

test("missing binding migration preserves authenticated read and recovery without granting any new write", {
  skip: process.env.STAGE8_G3_TEST !== "1",
}, async () => {
  const f = await mutationFixture({ bindingIdentities: false });
  const app = express();
  let dispatches = 0;
  const access: MutationAccess = {
    authenticate: async (headers) =>
      headers.cookie === "isolated-session"
        ? { ownerId: f.binding.ownerId, sessionId: f.sessionId }
        : undefined,
    withScope: async (scope, work) => {
      if (
        scope.ownerId !== f.binding.ownerId ||
        scope.workspaceId !== f.binding.workspaceId ||
        scope.sourceId !== f.binding.sourceId
      )
        throw new MutationError("NOT_FOUND");
      return work(f.binding);
    },
  };
  const service = new MutationService(
    f.store,
    access,
    {
      capability: async () =>
        assert.fail("missing identity must not ask Connector for write capability"),
      preview: async () => assert.fail("missing identity must not dispatch preview"),
      execute: async () => {
        dispatches++;
      },
      status: async () => ({ state: "outcome_unknown", code: "isolated" }),
      cancel: async () => {},
    },
    { sign: async () => assert.fail("no permit") },
    { enabled: true, executionEnabled: false },
  );
  const origin = "http://127.0.0.1:5199";
  mountMutationRoutes(app, origin, access, service);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/mutations/${f.binding.workspaceId}/${f.binding.sourceId}`;
  const get = { headers: { cookie: "isolated-session" } };
  const post = (body: unknown) => ({
    method: "POST",
    headers: { cookie: "isolated-session", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const capability = await (await fetch(`${base}/capability`, get)).json();
    assert.equal(capability.enabled, true);
    assert.equal(capability.available, false);
    assert.equal(capability.executionEnabled, false);
    assert.equal(capability.code, "binding_identity_required");
    assert.equal((await fetch(`${base}/executions`, get)).status, 200);
    assert.equal((await fetch(`${base}/confirmations/${randomUUID()}`, get)).status, 200);
    assert.equal((await fetch(`${base}/recovery`, post({}))).status, 200);
    assert.equal((await fetch(`${base}/executions/${randomUUID()}`, get)).status, 404);
    const plan = {
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    };
    assert.equal((await fetch(`${base}/previews`, post({ plan }))).status, 503);
    assert.equal(dispatches, 0);
    assert.equal((await fetch(`${base}/executions`)).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
});

test("mutation HTTP checks authentication, Origin, strict inputs and preserves IDs through recovery", {
  skip: process.env.STAGE8_G3_TEST !== "1",
}, async () => {
  const f = await mutationFixture();
  const application = express();
  const access: MutationAccess = {
    async authenticate(headers) {
      return headers.cookie === "isolated-session"
        ? { ownerId: f.binding.ownerId, sessionId: f.sessionId }
        : undefined;
    },
    async withScope(scope, operation) {
      if (
        scope.ownerId !== f.binding.ownerId ||
        scope.workspaceId !== f.binding.workspaceId ||
        scope.sourceId !== f.binding.sourceId
      )
        throw new MutationError("NOT_FOUND");
      return operation(f.binding);
    },
  };
  let dispatched = 0;
  const transport: MutationTransport = {
    async capability() {
      return { available: true, code: "ready", tables: ["customers"] };
    },
    async preview(_binding, _boot, plan) {
      return {
        metadata: f.preview({ operation: plan.operation, table: plan.table }),
        presentation: [{ before: { id: { kind: "integer", value: "1" } }, after: null }],
      };
    },
    async execute() {
      dispatched++;
    },
    async status(_binding, execution) {
      return { state: execution.state, code: execution.code };
    },
    async cancel() {},
  };
  const service = new MutationService(
    f.store,
    access,
    transport,
    {
      async sign() {
        return randomBytes(64).toString("base64url");
      },
    },
    { enabled: true, executionEnabled: true },
  );
  const origin = "http://127.0.0.1:5199";
  mountMutationRoutes(application, origin, access, service);
  const server = application.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing isolated HTTP address");
  const base = `http://127.0.0.1:${address.port}/api/mutations/${f.binding.workspaceId}/${f.binding.sourceId}`;
  const json = (body: unknown, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: "isolated-session", ...extra },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${base}/capability`)).status, 401);
    assert.equal(
      (await fetch(`${base}/recovery`, json({}, { origin: "http://evil.invalid" }))).status,
      403,
    );
    assert.equal(
      (await fetch(`${base}/previews`, json({ plan: { sql: "DELETE FROM customers" } }))).status,
      400,
    );
    const previewResponse = await fetch(
      `${base}/previews`,
      json({
        plan: {
          operation: "delete",
          table: "customers",
          where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
        },
      }),
    );
    assert.equal(previewResponse.status, 201);
    const p = await previewResponse.json();
    const confirmation = {
      confirmationId: randomUUID(),
      previewId: p.previewId,
      commitment: p.commitment,
      revision: p.revision,
    };
    const response = await fetch(`${base}/previews/${p.previewId}/confirm`, json(confirmation));
    assert.equal(response.status, 202);
    const record = await response.json();
    assert.equal(typeof record.executionId, "string");
    assert.equal("sessionId" in record, false);
    assert.equal(dispatched, 1);
    const retried = await fetch(`${base}/previews/${p.previewId}/confirm`, json(confirmation));
    assert.equal((await retried.json()).executionId, record.executionId);
    assert.equal(dispatched, 1);
    const status = await fetch(`${base}/executions/${record.executionId}`, {
      headers: { cookie: "isolated-session" },
    });
    assert.equal(status.status, 200);
    const recovery = await fetch(`${base}/recovery`, json({}));
    assert.equal(recovery.status, 200);
    const recovered = await recovery.json();
    assert.equal(recovered.items[0]?.executionId, record.executionId);
    assert.equal("sessionId" in recovered.items[0], false);
    const wrongScope = base.replace(f.binding.workspaceId, randomUUID());
    assert.equal(
      (
        await fetch(`${wrongScope}/executions/${record.executionId}`, {
          headers: { cookie: "isolated-session" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/executions?after=1&unknown=1`, {
          headers: { cookie: "isolated-session" },
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
});
