import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RowDataPacket } from "mysql2/promise";
import { authSessionReferenceActive } from "../src/auth.js";
import {
  bindingIdentitiesAvailable,
  migrateBindingIdentities,
} from "../src/datasources/binding-migration.js";
import { ScopeCoordinator } from "../src/datasources/scope-coordinator.js";
import { DataSourceStore } from "../src/datasources/store.js";
import { executionBindingSchema, type MutationBinding } from "../src/mutations/model.js";
import { MutationService } from "../src/mutations/service.js";
import { MutationStore } from "../src/mutations/store.js";
import { mutationFixture } from "./mutation-fixture.js";

const integration = { skip: process.env.STAGE9_G3_TEST !== "1", timeout: 120000 };
const run = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof mutationFixture>>;
async function identities(f: Fixture) {
  const c = await f.pool.getConnection();
  try {
    return await bindingIdentitiesAvailable(c);
  } finally {
    c.release();
  }
}
async function businessRows(f: Fixture) {
  const result: unknown[] = [];
  for (const table of [
    "user",
    "workspace",
    "data_source",
    "workspace_data_source",
    "mutation_preview",
    "_workspace_migrations",
  ]) {
    const [rows] = await f.pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
    result.push(rows);
  }
  return result;
}
async function rebindInOtherProcess(f: Fixture): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/rebind-source.js", import.meta.url)),
      f.database,
      f.binding.ownerId,
      f.binding.workspaceId,
      f.binding.sourceId,
    ],
    { env: process.env, timeout: 20000 },
  );
  assert.match(stdout, /^[0-9a-f-]{36}$/);
  return stdout;
}
async function current(f: Fixture): Promise<MutationBinding> {
  const binding = await f.sources.boundSource(
    f.binding.ownerId,
    f.binding.workspaceId,
    f.binding.sourceId,
  );
  assert.ok(binding?.bindingGeneration);
  return { ...f.binding, ...binding };
}

test(
  "explicit binding migration preserves existing rows, is reentrant and does not invent preview provenance",
  integration,
  async (t) => {
    const f = await mutationFixture({ bindingIdentities: false });
    t.after(() => f.close());
    const preview = f.preview();
    const unversionedCoordinator = new ScopeCoordinator(f.sources, {
      withActiveOwner: async (_o, _c, work) => work(),
    });
    const unavailable = async () => {
      throw Error("must not contact Connector without binding identity");
    };
    const unversionedService = new MutationService(
      f.store,
      {
        authenticate: async () => undefined,
        withScope: unversionedCoordinator.withScope.bind(unversionedCoordinator),
      },
      {
        capability: unavailable,
        preview: unavailable,
        execute: unavailable,
        status: unavailable,
        cancel: unavailable,
      },
      { sign: unavailable },
      { enabled: true, executionEnabled: true },
    );
    assert.equal(
      (await unversionedService.capability(f.binding)).code,
      "binding_identity_required",
    );
    await assert.rejects(
      unversionedService.preview(f.binding, {
        operation: "delete",
        table: "customers",
        where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
      }),
      /UNAVAILABLE/,
    );
    const secondWorkspace = randomUUID();
    await f.pool.execute(
      "INSERT INTO workspace (id,name,createdByAccountId,createdAt,updatedAt) VALUES (?,'second existing binding',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
      [secondWorkspace, f.binding.ownerId],
    );
    await f.sources.bind(f.binding.ownerId, secondWorkspace, f.binding.sourceId);
    await assert.rejects(f.store.savePreview(f.binding, preview), /UNAVAILABLE/);
    await f.pool.execute(
      "INSERT INTO mutation_preview (id,ownerId,workspaceId,sourceId,connectorId,commitment,revision,apiBoot,connectorBoot,targetIdentity,targetEpoch,policyGeneration,installationGeneration,operation,tableName,rowCount,expiresAt,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',UTC_TIMESTAMP(3))",
      [
        preview.previewId,
        f.binding.ownerId,
        f.binding.workspaceId,
        f.binding.sourceId,
        f.binding.connectorId,
        preview.commitment,
        preview.revision,
        preview.apiBoot,
        preview.connectorBoot,
        preview.targetIdentity,
        preview.targetEpoch,
        preview.policyGeneration,
        preview.installationGeneration,
        preview.operation,
        preview.table,
        preview.rowCount,
        new Date(preview.expiresAt),
      ],
    );
    const before = await businessRows(f);
    assert.equal(await identities(f), false);
    await migrateBindingIdentities(f.pool);
    assert.equal(await identities(f), true);
    assert.deepEqual(await businessRows(f), before);
    const sources = new DataSourceStore(f.pool, true);
    const binding = await sources.boundSource(
      f.binding.ownerId,
      f.binding.workspaceId,
      f.binding.sourceId,
    );
    assert.ok(binding?.bindingGeneration);
    await migrateBindingIdentities(f.pool);
    assert.deepEqual(
      await sources.boundSource(f.binding.ownerId, f.binding.workspaceId, f.binding.sourceId),
      binding,
    );
    const store = new MutationStore(f.pool, sources, f.boot, authSessionReferenceActive, true);
    await assert.rejects(
      store.confirm({ ...f.binding, ...binding }, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: preview.previewId,
        commitment: preview.commitment,
        revision: 1,
      }),
      /DENIED/,
    );
    const [mapped] = await f.pool.query<RowDataPacket[]>("SELECT * FROM mutation_preview_binding");
    assert.equal(mapped.length, 0);
  },
);

for (const step of [
  "table:source_binding_identity",
  "table:mutation_preview_binding",
  "table:binding_identity_schema",
  "backfill-row",
  "backfill-batch",
  "verified",
  "recorded",
]) {
  test(
    `binding migration resumes after failure at ${step} without changing business data`,
    integration,
    async (t) => {
      const f = await mutationFixture({ bindingIdentities: false });
      t.after(() => f.close());
      const before = await businessRows(f);
      await assert.rejects(
        migrateBindingIdentities(f.pool, async (actual) => {
          if (actual === step) throw Error("synthetic migration interruption");
        }),
        /synthetic migration interruption/,
      );
      assert.deepEqual(await businessRows(f), before);
      await migrateBindingIdentities(f.pool);
      assert.equal(await identities(f), true);
      const sources = new DataSourceStore(f.pool, true);
      const binding = await sources.boundSource(
        f.binding.ownerId,
        f.binding.workspaceId,
        f.binding.sourceId,
      );
      assert.ok(binding?.bindingGeneration);
      await migrateBindingIdentities(f.pool);
      assert.deepEqual(
        await sources.boundSource(f.binding.ownerId, f.binding.workspaceId, f.binding.sourceId),
        binding,
      );
      assert.deepEqual(await businessRows(f), before);
    },
  );
}

test(
  "binding migration rejects foreign structure and corrupt identity without repairing it",
  integration,
  async (t) => {
    const f = await mutationFixture();
    t.after(() => f.close());
    await f.pool.execute("ALTER TABLE source_binding_identity ADD COLUMN unexpected int NULL");
    await assert.rejects(migrateBindingIdentities(f.pool), /columns differ/);
    await assert.rejects(identities(f), /columns differ/);
    await f.pool.execute("ALTER TABLE source_binding_identity DROP COLUMN unexpected");
    await f.pool.execute(
      "UPDATE source_binding_identity SET generation='invalid' WHERE workspaceId=? AND sourceId=?",
      [f.binding.workspaceId, f.binding.sourceId],
    );
    await assert.rejects(migrateBindingIdentities(f.pool), /generation format differs/);
    const [rows] = await f.pool.query<RowDataPacket[]>(
      "SELECT generation FROM source_binding_identity",
    );
    assert.equal(rows[0]?.generation, "invalid");
  },
);

test(
  "new process rebind invalidates saved preview and all first-execution authority",
  integration,
  async (t) => {
    const f = await mutationFixture();
    t.after(() => f.close());
    const preview = f.preview();
    await f.store.savePreview(f.binding, preview);
    const input = {
      confirmationId: randomUUID(),
      previewId: preview.previewId,
      commitment: preview.commitment,
      revision: 1,
    };
    const { execution } = await f.store.confirm(f.binding, f.sessionId, input);
    const request = executionBindingSchema.parse(
      Object.fromEntries(
        Object.keys(executionBindingSchema.shape).map((key) => [
          key,
          execution[key as keyof typeof execution],
        ]),
      ),
    );
    const generation = await rebindInOtherProcess(f);
    assert.notEqual(generation, f.binding.bindingGeneration);
    const binding = await current(f);
    await assert.rejects(f.store.confirm(binding, f.sessionId, input), /DENIED/);
    await assert.rejects(f.store.claim(binding, request), /DENIED/);
    let signatures = 0;
    await assert.rejects(
      f.store.permit(
        binding,
        { ...request, challenge: "A".repeat(43) },
        {
          sign: async () => {
            signatures++;
            return "unused";
          },
        },
      ),
      /DENIED/,
    );
    assert.equal(signatures, 0);
    const [permits] = await f.pool.query<RowDataPacket[]>("SELECT * FROM mutation_permit");
    assert.equal(permits.length, 0);
    await assert.rejects(f.store.savePreview(f.binding, f.preview()), /DENIED/);
    await f.store.savePreview(binding, f.preview());
  },
);

test(
  "database binding lock prevents another process rebinding until sensitive handoff finishes",
  integration,
  async (t) => {
    const f = await mutationFixture();
    t.after(() => f.close());
    const coordinator = new ScopeCoordinator(f.sources, {
      withActiveOwner: async (_o, _c, work) => work(),
    });
    let pending: Promise<string> | undefined;
    try {
      await coordinator.withBoundIdentity(f.binding, async (binding) => {
        assert.equal(binding.bindingGeneration, f.binding.bindingGeneration);
        pending = rebindInOtherProcess(f);
        void pending.catch(() => {});
        let observed = false;
        const deadline = performance.now() + 3000;
        while (performance.now() < deadline) {
          const [rows] = await f.pool.execute<RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='workspace'",
            [f.database],
          );
          if (Number(rows[0]?.count) > 0) {
            observed = true;
            break;
          }
          await delay(20);
        }
        assert.equal(observed, true, "child must actually wait on the platform workspace row lock");
        assert.equal((await current(f)).bindingGeneration, binding.bindingGeneration);
      });
      assert.ok(pending);
      assert.notEqual(await pending, f.binding.bindingGeneration);
    } finally {
      await pending?.catch(() => {});
    }
  },
);

for (const [name, sql, reason] of [
  [
    "default",
    "ALTER TABLE source_binding_identity ALTER COLUMN generation SET DEFAULT '00000000-0000-4000-8000-000000000000'",
    /columns differ/,
  ],
  [
    "invisible index",
    "ALTER TABLE source_binding_identity ALTER INDEX source_binding_generation INVISIBLE",
    /indexes differ/,
  ],
  [
    "foreign key action",
    "ALTER TABLE source_binding_identity ADD CONSTRAINT source_binding_identity_fk FOREIGN KEY(workspaceId,sourceId) REFERENCES workspace_data_source(workspaceId,sourceId) ON DELETE RESTRICT",
    /foreign keys differ/,
  ],
  ["checksum", "UPDATE binding_identity_schema SET checksum=REPEAT('0',64)", /checksum differs/],
] as const) {
  test(
    `binding migration rejects unexpected ${name} without overwriting it`,
    integration,
    async (t) => {
      const f = await mutationFixture();
      t.after(() => f.close());
      if (name === "foreign key action")
        await f.pool.query(
          "ALTER TABLE source_binding_identity DROP FOREIGN KEY source_binding_identity_fk",
        );
      await f.pool.query(sql);
      await assert.rejects(migrateBindingIdentities(f.pool), reason);
    },
  );
}

test("missing binding identity fails closed without runtime backfill", integration, async (t) => {
  const f = await mutationFixture();
  t.after(() => f.close());
  await f.pool.execute("DELETE FROM source_binding_identity WHERE workspaceId=? AND sourceId=?", [
    f.binding.workspaceId,
    f.binding.sourceId,
  ]);
  assert.equal(
    await f.sources.boundSource(f.binding.ownerId, f.binding.workspaceId, f.binding.sourceId),
    null,
  );
  await assert.rejects(f.store.savePreview(f.binding, f.preview()), /NOT_FOUND/);
  await assert.rejects(
    f.sources.withBoundIdentity(
      f.binding.ownerId,
      f.binding.workspaceId,
      f.binding.sourceId,
      async () => assert.fail("no authority"),
    ),
    /NOT_FOUND/,
  );
  const [rows] = await f.pool.query<RowDataPacket[]>("SELECT * FROM source_binding_identity");
  assert.equal(rows.length, 0);
  const unversionedReads = new DataSourceStore(f.pool);
  assert.equal((await unversionedReads.list(f.binding.ownerId)).sources.length, 1);
});

test(
  "Connector reassignment creates a different binding identity and cannot confirm the prior Connector preview",
  integration,
  async (t) => {
    const f = await mutationFixture();
    t.after(() => f.close());
    const preview = f.preview();
    await f.store.savePreview(f.binding, preview);
    await f.sources.unbind(f.binding.ownerId, f.binding.workspaceId, f.binding.sourceId);
    await f.sources.reassign(f.binding.ownerId, f.binding.sourceId, randomUUID());
    await f.sources.bind(f.binding.ownerId, f.binding.workspaceId, f.binding.sourceId);
    const binding = await current(f);
    assert.notEqual(binding.connectorId, f.binding.connectorId);
    assert.notEqual(binding.bindingGeneration, f.binding.bindingGeneration);
    await assert.rejects(
      f.store.confirm(binding, f.sessionId, {
        confirmationId: randomUUID(),
        previewId: preview.previewId,
        commitment: preview.commitment,
        revision: 1,
      }),
      /DENIED/,
    );
  },
);

test(
  "rebind during Connector preview is rejected before persistence; stale origin is rejected before transport",
  integration,
  async (t) => {
    const f = await mutationFixture();
    t.after(() => f.close());
    const coordinator = new ScopeCoordinator(f.sources, {
      withActiveOwner: async (_o, _c, work) => work(),
    });
    let calls = 0;
    let rebound = false;
    const service = new MutationService(
      f.store,
      { authenticate: async () => undefined, withScope: coordinator.withScope.bind(coordinator) },
      {
        capability: async () => ({ available: true, code: "available" }),
        preview: async () => {
          calls++;
          if (!rebound) {
            await rebindInOtherProcess(f);
            rebound = true;
          }
          return {
            metadata: f.preview({ operation: "delete" }),
            presentation: [{ before: { id: { kind: "integer", value: "1" } }, after: null }],
          };
        },
        execute: async () => assert.fail("no execution"),
        status: async () => ({ state: "registered", code: null }),
        cancel: async () => {},
      },
      { sign: async () => "unused" },
      { enabled: true, executionEnabled: false },
    );
    const plan = {
      operation: "delete",
      table: "customers",
      where: [{ column: "id", operator: "eq", value: { kind: "integer", value: "1" } }],
    };
    const origin = {
      connectorId: f.binding.connectorId,
      bindingGeneration: String(f.binding.bindingGeneration),
    };
    await assert.rejects(service.preview(f.binding, plan, origin), /DENIED/);
    assert.equal(calls, 1);
    await assert.rejects(service.preview(f.binding, plan, origin), /DENIED/);
    assert.equal(calls, 1);
    const [rows] = await f.pool.query<RowDataPacket[]>("SELECT * FROM mutation_preview");
    assert.equal(rows.length, 0);
    const binding = await current(f);
    await service.preview(binding, plan, {
      connectorId: binding.connectorId,
      bindingGeneration: String(binding.bindingGeneration),
    });
    assert.equal(calls, 2);
  },
);
