import type { PoolConnection } from "mysql2/promise";
import type { DataSourceSnapshot } from "./snapshot.js";

export { DataSourceError } from "./errors.js";
export { ScopeCoordinator, type ScopeSourceLookup } from "./scope-coordinator.js";
export { validId } from "./store.js";
export { bindingIdentitiesAvailable } from "./binding-migration.js";

export type BoundSnapshot = { id: string; content: DataSourceSnapshot };
export type SourceBindingIdentity = { connectorId: string; bindingGeneration: string | null };

/** Infrastructure unit of work: scope locks and snapshot stay valid until action commits. */
export interface BoundSourceAccess {
  withBoundSnapshot<T>(
    owner: string,
    workspace: string,
    source: string,
    action: (
      connection: PoolConnection,
      snapshot: BoundSnapshot | null,
      binding: SourceBindingIdentity,
    ) => Promise<T>,
  ): Promise<T>;
}
