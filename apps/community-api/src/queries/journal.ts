export type QueryScope = {
  ownerId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
};
export type ExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "outcome_unknown";
export type ExecutionCode =
  | "denied"
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "error"
  | "outcome_unknown"
  | "schema_changed";
export type ExecutionSummary = {
  rowCount?: number;
  truncated?: boolean;
  reason?: "rows" | "bytes" | "cell";
  code?: ExecutionCode;
  durationMs?: number;
};
/** Safe metadata port; SQL, parameters and result cells are never journaled. */
export interface QueryJournal {
  begin(
    scope: QueryScope,
    id: string,
    instanceId: string,
  ): Promise<{ created: boolean; state: string }>;
  update(
    scope: QueryScope,
    id: string,
    state: ExecutionState,
    summary: ExecutionSummary,
  ): Promise<void>;
}
