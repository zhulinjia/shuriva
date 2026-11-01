import {
  ConnectorError,
  type ScanConnector,
  type SchemaResult,
  type SchemaTask,
} from "../connectors/public.js";
import { decodeSnapshot } from "./snapshot.js";
import { DataSourceError, type DataSourceStore } from "./store.js";

export interface ScanHooks {
  next(connectorId: string): Promise<SchemaTask | null>;
  result(input: SchemaResult): Promise<string>;
}

export function scanHooks(store: DataSourceStore, registry: ScanConnector): ScanHooks {
  return {
    async next(connectorId) {
      return registry.issueSchemaTask(connectorId, async () => {
        const scan = await store.nextScan(connectorId);
        if (!scan) return null;
        return {
          id: scan.id,
          connectorId: scan.connectorId,
          actorId: scan.ownerId,
          workspaceId: scan.workspaceId,
          sourceId: scan.sourceId,
          issuedAt: Number(scan.issuedAt),
          expiresAt: Number(scan.expiresUnix),
          nonce: scan.nonce,
        };
      });
    },
    async result(input) {
      await registry.verifySchemaResult(input, async () => {
        const scan = await store.authorizedScan(input.taskId, input.connectorId);
        if (!scan || scan.workspaceId !== input.workspaceId || scan.sourceId !== input.sourceId)
          throw new ConnectorError("TASK_GONE");
        try {
          if (input.outcome === "ok")
            await store.completeScan(
              input.taskId,
              input.connectorId,
              decodeSnapshot(input.payload),
            );
          else await store.failScan(input.taskId, input.connectorId, input.payload);
        } catch (error) {
          if (error instanceof DataSourceError && error.code === "NOT_FOUND")
            throw new ConnectorError("TASK_GONE");
          throw error;
        }
      });
      return registry.schemaResultAcknowledgement(input);
    },
  };
}
