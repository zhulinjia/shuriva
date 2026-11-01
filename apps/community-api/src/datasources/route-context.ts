import type { ConnectorAuthorization } from "../connectors/public.js";
import type { WorkspaceRead } from "../queries/public.js";
import { DataSourceError, type DataSourceStore, validId } from "./store.js";
import type { ScopeCoordinator } from "./scope-coordinator.js";

/** Shared lock-aware authorization primitives for HTTP adapters. */
export function createDataSourceRouteContext(
  store: DataSourceStore,
  registry: ConnectorAuthorization,
  scope: Pick<ScopeCoordinator, "inWorkspace">,
  read?: WorkspaceRead,
) {
  async function inWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    if (!validId(workspaceId)) throw new DataSourceError("INVALID");
    return scope.inWorkspace(workspaceId, operation);
  }
  async function withReadScope<T>(
    ownerId: string,
    workspaceId: string,
    sourceId: string,
    action: (scope: {
      ownerId: string;
      workspaceId: string;
      sourceId: string;
      connectorId: string;
    }) => T | Promise<T>,
  ): Promise<T> {
    const source = await store.boundSource(ownerId, workspaceId, sourceId);
    if (!source) throw new DataSourceError("NOT_FOUND");
    const result = await registry.withActiveOwner(ownerId, source.connectorId, () =>
      action({ ownerId, workspaceId, sourceId, connectorId: source.connectorId }),
    );
    if (result === undefined) throw new DataSourceError("NOT_FOUND");
    return result;
  }
  return { store, registry, read, inWorkspace, withReadScope };
}
export type DataSourceRouteContext = ReturnType<typeof createDataSourceRouteContext>;
