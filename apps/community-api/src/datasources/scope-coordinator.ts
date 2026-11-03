import { DataSourceError } from "./errors.js";

type Scope = { ownerId: string; workspaceId: string; sourceId: string };
type Binding = Scope & { connectorId: string; bindingGeneration?: string | null };
export type ScopeSourceLookup = {
  boundSource(
    owner: string,
    workspace: string,
    source: string,
  ): Promise<{ connectorId: string; bindingGeneration?: string | null } | null>;
  withBoundIdentity?<T>(
    owner: string,
    workspace: string,
    source: string,
    action: (binding: { connectorId: string; bindingGeneration: string }) => Promise<T>,
  ): Promise<T>;
};
type ConnectorAuthorization = {
  withActiveOwner<T>(owner: string, connectorId: string, action: () => T): Promise<T | undefined>;
};

/** One owner for lock ordering: workspace first, then active Connector identity. */
export class ScopeCoordinator {
  private readonly workspaceTails = new Map<string, Promise<void>>();
  constructor(
    private readonly sources: ScopeSourceLookup,
    private readonly connectors: ConnectorAuthorization,
  ) {}

  async inWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.workspaceTails.set(workspaceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceTails.get(workspaceId) === tail) this.workspaceTails.delete(workspaceId);
    }
  }

  async withScope<T>(scope: Scope, operation: (binding: Binding) => Promise<T>): Promise<T> {
    return this.inWorkspace(scope.workspaceId, async () => {
      const source = await this.sources.boundSource(
        scope.ownerId,
        scope.workspaceId,
        scope.sourceId,
      );
      if (!source) throw new DataSourceError("NOT_FOUND");
      const authorized = await this.connectors.withActiveOwner(
        scope.ownerId,
        source.connectorId,
        async () => ({
          value: await operation({
            ...scope,
            connectorId: source.connectorId,
            bindingGeneration: source.bindingGeneration ?? null,
          }),
        }),
      );
      if (!authorized) throw new DataSourceError("NOT_FOUND");
      return authorized.value;
    });
  }

  /** Short sensitive handoffs also retain the database binding locks. Ordinary
   * Connector requests use withScope and never hold these locks over their I/O. */
  async withBoundIdentity<T>(
    scope: Scope,
    operation: (binding: Binding & { bindingGeneration: string }) => Promise<T>,
  ): Promise<T> {
    return this.withScope(scope, async (observed) => {
      if (!this.sources.withBoundIdentity) throw new DataSourceError("NOT_FOUND");
      return this.sources.withBoundIdentity(
        scope.ownerId,
        scope.workspaceId,
        scope.sourceId,
        async (current) => {
          if (
            observed.connectorId !== current.connectorId ||
            observed.bindingGeneration !== current.bindingGeneration
          )
            throw new DataSourceError("NOT_FOUND");
          return operation({ ...scope, ...current });
        },
      );
    });
  }
}
