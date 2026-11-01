import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import type {
  AuthorizedModelContext,
  AuthorizedModelInvocation,
  ModelPlanner,
  PlanRequest,
  PlanStage,
} from "../src/ai/public.js";
import { MutationAIPlanner } from "../src/mutations/ai/planner.js";
import { mountMutationAIRoutes } from "../src/mutations/ai/routes.js";
import { askMutationCandidate } from "../src/mutations/ai/provider.js";
import type { MutationAccess, MutationCapability } from "../src/mutations/ports.js";

function aiFixture(now?: () => number) {
  const binding = {
    sessionId: randomUUID(),
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const apiBoot = randomBytes(32).toString("hex");
  const capability: MutationCapability = {
    available: true,
    code: "ready",
    connectorBoot: randomBytes(32).toString("hex"),
    targetIdentity: "isolated",
    targetEpoch: randomBytes(32).toString("hex"),
    policyGeneration: "1",
    installationGeneration: "1",
    writeColumns: {
      customers: {
        insert: ["name", "secret"],
        update: ["name", "secret"],
        filter: ["id", "secret"],
        delete: true,
      },
    },
  };
  const schema = {
    database: "isolated",
    tables: [
      {
        name: "customers",
        columns: [
          { name: "id", type: "int" },
          { name: "name", type: "varchar" },
          { name: "read_only", type: "varchar" },
        ],
      },
      {
        name: "salaries",
        columns: [
          { name: "id", type: "int" },
          { name: "amount", type: "decimal" },
        ],
      },
    ],
  };
  const destination = {
    baseUrl: "http://127.0.0.1:9999/v1",
    model: "mock",
    configVersion: randomBytes(32).toString("base64url"),
  };
  const semantics = {
    entities: [
      { name: "客户", description: "正常业务说明", aliases: [], table: "customers" },
      { name: "工资", description: "不可发送", aliases: [], table: "salaries" },
    ],
    fields: [
      {
        name: "名称",
        description: "可公开业务说明",
        aliases: ["客户名"],
        table: "customers",
        column: "name",
      },
      {
        name: "只读列",
        description: "不属于写范围",
        aliases: [],
        table: "customers",
        column: "read_only",
      },
    ],
    relationships: [],
    metrics: [],
  };
  let active = true,
    authorizations = 0,
    requested = 0;
  let metadataRetained = true;
  let afterSend: (() => void) | undefined;
  let answer: unknown = {
    kind: "mutation",
    explanation: "候选修改，尚未执行",
    plan: {
      operation: "update",
      table: "customers",
      changes: [{ column: "name", value: { kind: "string", value: "内部测试值" } }],
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    },
  };
  const access: MutationAccess = {
    async authenticate() {
      return { ownerId: binding.ownerId, sessionId: binding.sessionId };
    },
    async withScope(scope, operation) {
      if (
        !active ||
        scope.ownerId !== binding.ownerId ||
        scope.workspaceId !== binding.workspaceId ||
        scope.sourceId !== binding.sourceId
      )
        throw Error("STALE");
      return operation(binding);
    },
  };
  const base: Pick<ModelPlanner, "preview" | "generateAuthorized"> = {
    async preview() {
      if (!active) throw Error("STALE");
      if (!metadataRetained) return null;
      return { schema, semantics, schemaHash: "a".repeat(64), destination };
    },
    async generateAuthorized<T>(
      _actor: { ownerId: string; sessionId: string },
      _workspace: string,
      _source: string,
      _task: string,
      input: PlanRequest,
      signal: AbortSignal,
      invoke: AuthorizedModelInvocation,
      validate: (value: unknown, context: AuthorizedModelContext) => T,
      progress?: (stage: PlanStage) => void,
    ): Promise<T> {
      authorizations++;
      if (!active || signal.aborted) throw Error("STALE");
      progress?.("confirming_access");
      const value = await invoke(
        { ...destination, apiKey: "mock-key-not-disclosed" },
        input.question,
        schema,
        signal,
        {
          semantics,
          beforeRequest: () => {
            if (!active || signal.aborted) throw Error("STALE");
          },
          onRequestSent: () => {},
        },
      );
      if (!active || signal.aborted) throw Error("STALE");
      return validate(value, {
        schema,
        semantics,
        versions: new Map([["customers", "b".repeat(64)]]),
      });
    },
  };
  const planner = new MutationAIPlanner(base, access, async () => capability, apiBoot, {
    ...(now ? { now } : {}),
    invoke: async (_config, _question, sentSchema, writes, _signal, options) => {
      await options.beforeRequest?.();
      options.onRequestSent?.();
      requested++;
      assert.deepEqual(
        sentSchema.tables.map((table) => [table.name, table.columns.map((column) => column.name)]),
        [["customers", ["id", "name"]]],
      );
      assert.equal(JSON.stringify(options.semantics).includes("不可发送"), false);
      assert.equal(JSON.stringify(options.semantics).includes("不属于写范围"), false);
      assert.equal(JSON.stringify(writes).includes("secret"), false);
      afterSend?.();
      return answer;
    },
  });
  const prepare = () =>
    planner.prepare(binding, {
      question: "把客户 1 的名称改为内部测试值",
      taskId: randomUUID(),
      instanceId: randomUUID(),
      scopeToken: "opaque",
      submittedAt: Date.now(),
    });
  return {
    planner,
    prepare,
    binding,
    capability,
    destination,
    access,
    setActive(value: boolean) {
      active = value;
    },
    expireMetadata() {
      metadataRetained = false;
    },
    setAfterSend(effect: () => void) {
      afterSend = effect;
    },
    setAnswer(value: unknown) {
      answer = value;
    },
    stats: () => ({ requested, authorizations }),
  };
}

test("AI disclosure tickets are bounded under concurrent preparation and expire without model contact", async () => {
  let now = Date.now();
  const f = aiFixture(() => now);
  const prepared = await Promise.allSettled(Array.from({ length: 12 }, () => f.prepare()));
  assert.equal(prepared.filter((value) => value.status === "fulfilled").length, 4);
  const first = prepared.find((value) => value.status === "fulfilled");
  assert.ok(first?.status === "fulfilled");
  now += 46000;
  await assert.rejects(
    () =>
      f.planner.generate(
        f.binding,
        {
          ticketId: first.value.ticketId,
          disclosureHash: first.value.disclosureHash,
          confirmed: true,
        },
        new AbortController().signal,
      ),
    /STALE/,
  );
  assert.equal(f.stats().requested, 0);
});

test("dedicated mutation AI HTTP requires login, Origin and exact reviewed consent before a single send", async () => {
  const f = aiFixture();
  const app = express();
  mountMutationAIRoutes(
    app,
    "http://localhost:5177",
    {
      ...f.access,
      authenticate: async (headers) =>
        headers["x-test-auth"] === "yes"
          ? { ownerId: f.binding.ownerId, sessionId: f.binding.sessionId }
          : undefined,
    },
    f.planner,
  );
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("mock address unavailable");
  const base = `http://127.0.0.1:${address.port}/api/mutations/${f.binding.workspaceId}/${f.binding.sourceId}/ai`;
  const headers = {
    origin: "http://localhost:5177",
    "content-type": "application/json",
    "x-test-auth": "yes",
    connection: "close",
  };
  const input = {
    question: "把客户 1 的名称改为内部测试值",
    taskId: randomUUID(),
    instanceId: randomUUID(),
    scopeToken: "opaque",
    submittedAt: Date.now(),
  };
  try {
    assert.equal(
      (
        await fetch(`${base}/prepare`, {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.invalid" },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/prepare`, {
          method: "POST",
          headers: { ...headers, "x-test-auth": "" },
          body: JSON.stringify(input),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/prepare`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, sendImmediately: true }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/prepare`, { method: "POST", headers, body: "{" })).status,
      400,
    );
    const prepared = await fetch(`${base}/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(prepared.status, 200);
    const disclosure = (await prepared.json()) as {
      ticketId: string;
      disclosureHash: string;
      question: string;
    };
    assert.equal(disclosure.question, input.question);
    assert.equal(f.stats().requested, 0);
    const consent = {
      ticketId: disclosure.ticketId,
      disclosureHash: disclosure.disclosureHash,
      confirmed: true,
    };
    assert.equal(
      (
        await fetch(`${base}/generate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...consent, confirmed: false }),
        })
      ).status,
      400,
    );
    assert.equal(f.stats().requested, 0);
    const generated = await fetch(`${base}/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(consent),
    });
    assert.equal(generated.status, 200);
    assert.equal(((await generated.json()) as { plan: { kind: string } }).plan.kind, "mutation");
    assert.equal(
      (await fetch(`${base}/generate`, { method: "POST", headers, body: JSON.stringify(consent) }))
        .status,
      409,
    );
    assert.equal(f.stats().requested, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.planner.close();
  }
});

test("mutation AI prepares exact minimum disclosure without contacting a model; explicit single consent is required", async () => {
  const f = aiFixture();
  const prepared = await f.prepare();
  assert.equal(f.stats().requested, 0);
  assert.equal(JSON.stringify(prepared).includes("mock-key-not-disclosed"), false);
  assert.equal(JSON.stringify(prepared.schema).includes("read_only"), false);
  assert.equal(JSON.stringify(prepared.schema).includes("salaries"), false);
  assert.equal(prepared.question, "把客户 1 的名称改为内部测试值");
  await assert.rejects(() =>
    f.planner.generate(
      f.binding,
      { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: false },
      new AbortController().signal,
    ),
  );
  assert.equal(f.stats().requested, 0);
  const result = await f.planner.generate(
    f.binding,
    { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
    new AbortController().signal,
  );
  assert.equal(result.kind, "mutation");
  assert.deepEqual(f.stats(), { requested: 1, authorizations: 1 });
  await assert.rejects(
    () =>
      f.planner.generate(
        f.binding,
        { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
        new AbortController().signal,
      ),
    /STALE/,
  );
  assert.equal(f.stats().requested, 1);
});

test("mutation AI rejects changed write policy, destination, scope and cancelled intent before model contact", async () => {
  for (const change of ["policy", "model", "scope", "cancel"] as const) {
    const f = aiFixture(),
      prepared = await f.prepare();
    const scope = { ...f.binding };
    const abort = new AbortController();
    if (change === "policy") f.capability.policyGeneration = "2";
    if (change === "model") f.destination.model = "changed";
    if (change === "scope") scope.workspaceId = randomUUID();
    if (change === "cancel") abort.abort();
    await assert.rejects(() =>
      f.planner.generate(
        scope,
        { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
        abort.signal,
      ),
    );
    assert.equal(f.stats().requested, 0);
  }
});

test("untrusted mutation candidates cannot invent columns, write raw SQL or exceed the displayed write scope", async () => {
  for (const plan of [
    {
      operation: "update",
      table: "customers",
      changes: [{ column: "secret", value: { kind: "string", value: "x" } }],
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    },
    {
      operation: "delete",
      table: "customers",
      where: [{ column: "read_only", operator: "is_null" }],
    },
    { operation: "delete", table: "customers", where: [], sql: "DELETE FROM customers" },
  ]) {
    const f = aiFixture(),
      prepared = await f.prepare();
    f.setAnswer({ kind: "mutation", explanation: "do it", plan });
    await assert.rejects(
      () =>
        f.planner.generate(
          f.binding,
          { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
          new AbortController().signal,
        ),
      /INVALID_PLAN/,
    );
  }
});

test("a model request already sent before revocation never returns a usable mutation draft", async () => {
  const f = aiFixture(),
    prepared = await f.prepare();
  f.setAfterSend(() => f.setActive(false));
  await assert.rejects(
    () =>
      f.planner.generate(
        f.binding,
        { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
        new AbortController().signal,
      ),
    /STALE/,
  );
  assert.equal(f.stats().requested, 1);
});

test("a valid slow model response may outlive metadata task retention; changed write policy still rejects it", async () => {
  for (const policyChanged of [false, true]) {
    const f = aiFixture(),
      prepared = await f.prepare();
    f.setAfterSend(() => {
      f.expireMetadata();
      if (policyChanged) f.capability.policyGeneration = "2";
    });
    const request = () =>
      f.planner.generate(
        f.binding,
        { ticketId: prepared.ticketId, disclosureHash: prepared.disclosureHash, confirmed: true },
        new AbortController().signal,
      );
    if (policyChanged) await assert.rejects(request, /STALE/);
    else assert.equal((await request()).kind, "mutation");
    assert.equal(f.stats().requested, 1);
  }
});

test("existing AI SDK and guarded compatible transport produce only a structured mutation candidate against a local mock", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(request && typeof request === "object" && "messages" in request);
    const messages = Reflect.get(request, "messages");
    assert.ok(Array.isArray(messages));
    const sent = JSON.parse(String(messages[1]?.content));
    assert.equal(sent.question, "仅生成候选");
    assert.equal("apiKey" in sent, false);
    assert.deepEqual(sent.schema.tables[0].columns, [{ name: "id", type: "int" }]);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ kind: "clarification", question: "需要修改哪一行？" }),
            },
          },
        ],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing mock address");
  try {
    const result = await askMutationCandidate(
      { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "mock", apiKey: "mock-key" },
      "仅生成候选",
      { database: "example", tables: [{ name: "items", columns: [{ name: "id", type: "int" }] }] },
      { items: { insert: ["id"], update: [], filter: ["id"], delete: false } },
      new AbortController().signal,
      {},
    );
    assert.deepEqual(result, { kind: "clarification", question: "需要修改哪一行？" });
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
