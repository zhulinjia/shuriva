import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ModelPlanner, type ScopedAccess } from "../src/ai/model-planner.js";
import { ModelStore } from "../src/ai/model-store.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import { ReadService } from "../src/queries/service.js";
import type { SemanticStore } from "../src/semantic/store.js";
import { emptySemanticDocument } from "../src/semantic/model.js";
import { semanticStructureHash } from "../src/semantic/structure.js";

const semanticSnapshot = {
  database: "demo",
  tables: [{ name: "customers", kind: "BASE TABLE" }],
  columns: [
    { table: "customers", name: "id", type: "int", nullable: false, position: 1 },
    { table: "customers", name: "name", type: "varchar(50)", nullable: false, position: 2 },
  ],
};

const original = {
  database: "demo",
  tables: [
    {
      name: "customers",
      columns: [
        { name: "id", type: "int" },
        { name: "name", type: "varchar" },
      ],
      version: "a".repeat(64),
      structureHash: semanticStructureHash(semanticSnapshot, "customers"),
    },
  ],
};
const answer = {
  kind: "query",
  explanation: "列出客户",
  table: "customers",
  columns: ["id"],
  filters: [],
  orderBy: [],
  maxRows: 10,
};

function fixture(options: ConstructorParameters<typeof ModelPlanner>[3] = {}) {
  const scope = {
    ownerId: "owner",
    workspaceId: randomUUID(),
    sourceId: randomUUID(),
    connectorId: randomUUID(),
  };
  const credentials = new Map<string, string>();
  const models = new ModelStore((owner) => ({
    getPassword: () => credentials.get(owner) ?? null,
    setPassword: (value) => {
      credentials.set(owner, value);
    },
    deletePassword: () => credentials.delete(owner),
  }));
  const config = { baseUrl: "http://127.0.0.1:1234/v1", model: "fixture", apiKey: "fixture-A" };
  models.set(scope.ownerId, config);
  const read = new ReadService({} as DataSourceStore, {} as ConnectorRegistry);
  const access: ScopedAccess = async (_owner, _workspace, _source, operation) => operation(scope);
  const planner = new ModelPlanner(read, models, access, options);
  const id = randomUUID();
  read.jobs.createModelSchema(scope, id);
  assert.equal(read.jobs.claim(scope.connectorId)?.type, "read");
  assert.equal(
    read.jobs.complete(
      scope,
      id,
      "ok",
      Buffer.from(JSON.stringify(original)).toString("base64url"),
    ),
    true,
  );
  const grant = read.issueScope(scope);
  return { scope, models, config, read, planner, id, grant };
}

async function request(f: ReturnType<typeof fixture>) {
  const preview = await f.planner.preview(
    f.scope.ownerId,
    f.scope.workspaceId,
    f.scope.sourceId,
    f.id,
  );
  assert.ok(preview);
  return {
    ...f.grant,
    submittedAt: Date.now(),
    question: "查询客户",
    schemaHash: preview.schemaHash,
    ...preview.destination,
  };
}

function connector(f: ReturnType<typeof fixture>, schema: typeof original = original) {
  const timer = setInterval(() => {
    const work = f.read.jobs.claim(f.scope.connectorId);
    if (work?.type !== "read" || work.task.operation !== "model_authorize") return;
    clearInterval(timer);
    f.read.jobs.complete(
      f.scope,
      work.task.id,
      "ok",
      Buffer.from(JSON.stringify({ ...schema, leaseExpiresAt: work.task.expiresAt })).toString(
        "base64url",
      ),
    );
  }, 5);
  return () => clearInterval(timer);
}

test("model disclosure contains only reviewed non-sensitive semantics and rejects changed semantic state", async () => {
  let calls = 0;
  const doc = {
    ...emptySemanticDocument(),
    fields: [
      {
        name: "编号",
        description: "客户编号",
        aliases: ["客户号"],
        sensitivity: "normal" as const,
        table: "customers",
        column: "id",
        type: "int",
      },
      {
        name: "秘密名称",
        description: "机密",
        aliases: [],
        sensitivity: "sensitive" as const,
        table: "customers",
        column: "name",
        type: "varchar(50)",
      },
    ],
  };
  const store = {
    get: async () => ({ document: doc, stale: [], snapshot: semanticSnapshot }),
  } as unknown as SemanticStore;
  const f = fixture({
    semantics: store,
    invoke: async (_config, _question, schema, _signal, events) => {
      calls++;
      assert.deepEqual(schema.tables[0]?.columns, [{ name: "id", type: "int" }]);
      assert.doesNotMatch(JSON.stringify(events?.semantics), /秘密名称|机密|"column":"name"/);
      events?.beforeRequest?.();
      events?.onRequestSent?.();
      return answer;
    },
  });
  try {
    const input = await request(f);
    const field = doc.fields[0];
    assert.ok(field);
    field.description = "修改后的编号";
    await assert.rejects(
      () =>
        f.planner.generate(
          f.scope.ownerId,
          f.scope.workspaceId,
          f.scope.sourceId,
          f.id,
          input,
          new AbortController().signal,
        ),
      /STALE/,
    );
    assert.equal(calls, 0);
    const next = await request(f);
    const stop = connector(f);
    try {
      const plan = await f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        next,
        new AbortController().signal,
      );
      assert.equal(plan.kind, "query");
      assert.equal(calls, 1);
    } finally {
      stop();
    }
  } finally {
    f.read.close();
  }
});

test("a sent model answer is discarded when business disclosure becomes sensitive or changes during generation", async () => {
  for (const changed of ["sensitivity", "description"] as const) {
    const field = {
      name: "编号",
      description: "客户编号",
      aliases: [],
      sensitivity: "normal" as "normal" | "sensitive",
      table: "customers",
      column: "id",
      type: "int",
    };
    const doc = { ...emptySemanticDocument(), fields: [field] };
    const store = {
      get: async () => ({ document: doc, stale: [], snapshot: semanticSnapshot }),
    } as unknown as SemanticStore;
    let sends = 0;
    const f = fixture({
      semantics: store,
      invoke: async (_config, _question, _schema, _signal, events) => {
        events?.beforeRequest?.();
        events?.onRequestSent?.();
        sends++;
        if (changed === "sensitivity") field.sensitivity = "sensitive";
        else field.description = "已撤销的说明";
        return answer;
      },
    });
    const stop = connector(f);
    try {
      const input = await request(f);
      await assert.rejects(
        () =>
          f.planner.generate(
            f.scope.ownerId,
            f.scope.workspaceId,
            f.scope.sourceId,
            f.id,
            input,
            new AbortController().signal,
          ),
        /STALE/,
      );
      assert.equal(sends, 1);
    } finally {
      stop();
      f.read.close();
    }
  }
});

test("changing model credentials invalidates an already displayed preview", async () => {
  let calls = 0;
  const f = fixture({
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  try {
    const input = await request(f);
    f.models.set(f.scope.ownerId, { ...f.config, apiKey: "fixture-B" });
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(calls, 0);
    assert.equal(f.read.jobs.claim(f.scope.connectorId), null);
  } finally {
    f.read.close();
  }
});

test("fresh Connector authorization must match every reviewed field and structure version", async () => {
  let calls = 0;
  const f = fixture({
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  const stop = connector(f, {
    ...original,
    tables: [{ ...original.tables[0], columns: [{ name: "id", type: "int" }] }],
  });
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(calls, 0);
  } finally {
    stop();
    f.read.close();
  }
});

test("same names with changed table version are rejected before model contact", async () => {
  let calls = 0;
  const f = fixture({
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  const stop = connector(f, {
    ...original,
    tables: [{ ...original.tables[0], version: "b".repeat(64) }],
  });
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(calls, 0);
  } finally {
    stop();
    f.read.close();
  }
});

test("matching fresh authorization returns a plan bound to the selected table version", async () => {
  const f = fixture({
    invoke: async (_config, _question, _schema, _signal, events) => {
      events?.onRequestSent?.();
      return answer;
    },
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    assert.deepEqual(
      await f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      {
        kind: "query",
        explanation: "列出客户",
        sql: "SELECT `id` FROM `customers`",
        parameters: [],
        maxRows: 10,
        schemaVersion: "a".repeat(64),
      },
    );
  } finally {
    stop();
    f.read.close();
  }
});

test("disconnect or configuration change during confirmation never contacts the model", async () => {
  let calls = 0;
  const f = fixture({
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  try {
    const input = await request(f);
    const pending = f.planner.generate(
      f.scope.ownerId,
      f.scope.workspaceId,
      f.scope.sourceId,
      f.id,
      input,
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.models.set(f.scope.ownerId, { ...f.config, apiKey: "fixture-B" });
    await assert.rejects(pending, /STALE/);
    assert.equal(calls, 0);
  } finally {
    f.read.close();
  }
});

test("missing Connector confirmation fails closed on cancellation", async () => {
  let calls = 0;
  const f = fixture({
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        AbortSignal.timeout(50),
      ),
      /STALE/,
    );
    assert.equal(calls, 0);
  } finally {
    f.read.close();
  }
});

test("configuration change aborts a model call already in progress", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const f = fixture({
    invoke: async (_config, _question, _schema, signal, events) =>
      new Promise((_resolve, reject) => {
        events?.onRequestSent?.();
        markStarted();
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("MODEL_UNAVAILABLE"));
          },
          { once: true },
        );
      }),
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    const pending = f.planner.generate(
      f.scope.ownerId,
      f.scope.workspaceId,
      f.scope.sourceId,
      f.id,
      input,
      new AbortController().signal,
    );
    await started;
    f.models.set(f.scope.ownerId, { ...f.config, apiKey: "fixture-B" });
    await assert.rejects(pending, /STALE/);
    assert.equal(aborted, true);
  } finally {
    stop();
    f.read.close();
  }
});

test("near-expired Connector authorization is never sent to the model", async () => {
  let calls = 0;
  const f = fixture({
    now: () => Date.now() + 28_000,
    invoke: async () => {
      calls++;
      return answer;
    },
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(calls, 0);
  } finally {
    stop();
    f.read.close();
  }
});

test("a stalled request body is aborted before the Connector authorization lease ends", {
  timeout: 12_000,
}, async () => {
  let aborted = false;
  const f = fixture({
    now: () => Date.now() + 22_000,
    invoke: async (_config, _question, _schema, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("MODEL_UNAVAILABLE"));
          },
          { once: true },
        );
      }),
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(aborted, true);
  } finally {
    stop();
    f.read.close();
  }
});

test("a completed request may receive a slow model response after the disclosure lease", async () => {
  let offset = 0;
  const f = fixture({
    now: () => Date.now() + offset,
    invoke: async (_config, _question, _schema, _signal, events) => {
      events?.onRequestSent?.();
      offset = 40_000;
      return answer;
    },
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    const result = await f.planner.generate(
      f.scope.ownerId,
      f.scope.workspaceId,
      f.scope.sourceId,
      f.id,
      input,
      new AbortController().signal,
    );
    assert.equal(result.kind, "query");
  } finally {
    stop();
    f.read.close();
  }
});

test("a request completing transmission after the disclosure deadline fails closed", async () => {
  let offset = 0;
  const f = fixture({
    now: () => Date.now() + offset,
    invoke: async (_config, _question, _schema, _signal, events) => {
      offset = 40_000;
      events?.onRequestSent?.();
      return answer;
    },
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
  } finally {
    stop();
    f.read.close();
  }
});

test("an expired lease prevents request creation after address resolution", async () => {
  let offset = 0;
  let created = false;
  const f = fixture({
    now: () => Date.now() + offset,
    invoke: async (_config, _question, _schema, _signal, events) => {
      offset = 40_000;
      events?.beforeRequest?.();
      created = true;
      return answer;
    },
  });
  const stop = connector(f);
  try {
    const input = await request(f);
    await assert.rejects(
      f.planner.generate(
        f.scope.ownerId,
        f.scope.workspaceId,
        f.scope.sourceId,
        f.id,
        input,
        new AbortController().signal,
      ),
      /STALE/,
    );
    assert.equal(created, false);
  } finally {
    stop();
    f.read.close();
  }
});
