import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ScopeCoordinator } from "../src/datasources/public.js";
import { createDataSourceRouteContext } from "../src/datasources/route-context.js";
import type { DataSourceStore } from "../src/datasources/store.js";
import type { ConnectorRegistry } from "../src/connectors/registry.js";

test("binding operations use the shared workspace lock when read service is disabled", async () => {
  const store = {} as DataSourceStore;
  const registry = {} as ConnectorRegistry;
  const coordinator = new ScopeCoordinator(store, registry);
  const context = createDataSourceRouteContext(store, registry, coordinator);
  const workspaceId = randomUUID();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = coordinator.inWorkspace(workspaceId, async () => {
    entered();
    await held;
  });
  await started;
  let called = false;
  const second = context.inWorkspace(workspaceId, async () => {
    called = true;
  });
  await coordinator.inWorkspace(randomUUID(), async () => {});
  assert.equal(called, false);
  release();
  await Promise.all([first, second]);
  assert.equal(called, true);
});

test("scope work shares workspace ordering and observes the current binding after a concurrent change", async () => {
  let connectorId = "old";
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = new ScopeCoordinator(
    {
      async boundSource() {
        return { connectorId };
      },
    },
    {
      async withActiveOwner(_owner, _id, action) {
        return action();
      },
    },
  );
  const changing = coordinator.inWorkspace("workspace", async () => {
    enter();
    await hold;
    connectorId = "current";
  });
  await entered;
  let called = false;
  const scope = coordinator.withScope(
    { ownerId: "owner", workspaceId: "workspace", sourceId: "source" },
    async (binding) => {
      called = true;
      return binding.connectorId;
    },
  );
  assert.equal(await coordinator.inWorkspace("another", async () => "ready"), "ready");
  assert.equal(called, false);
  release();
  await changing;
  assert.equal(await scope, "current");
});

test("failed work does not poison the lock; a revoked identity cannot authorize a later scope", async () => {
  const coordinator = new ScopeCoordinator(
    {
      async boundSource() {
        return { connectorId: "connector" };
      },
    },
    {
      async withActiveOwner() {
        return undefined;
      },
    },
  );
  await assert.rejects(() =>
    coordinator.inWorkspace("workspace", async () => {
      throw Error("failed");
    }),
  );
  assert.equal(await coordinator.inWorkspace("workspace", async () => "released"), "released");
  let called = false;
  await assert.rejects(
    () =>
      coordinator.withScope(
        { ownerId: "owner", workspaceId: "workspace", sourceId: "source" },
        async () => {
          called = true;
        },
      ),
    /NOT_FOUND/,
  );
  assert.equal(called, false);
});
