import type { ReadService } from "./service.js";

/** Public operations consumed by the existing HTTP adapters and model planner. */
type Jobs = ReadService["jobs"];
type ModelJobs = Pick<
  Jobs,
  "modelSchema" | "createModelAuthorization" | "modelAuthorization" | "status" | "cancel"
>;
export type ConnectorRead = Pick<ReadService, "next" | "result" | "invalidateConnector"> & {
  jobs: Pick<Jobs, "revokeConnector" | "busy">;
};
export type HistoryRead = Pick<ReadService, "withCurrentReadScope" | "flushHistory">;
export type SemanticRead = Pick<ReadService, "inWorkspace" | "invalidateModelContext">;
export type ModelRead = Pick<
  ReadService,
  "validScope" | "watchBinding" | "assertSession" | "watchSession"
> & { jobs: ModelJobs };
export type WorkspaceRead = Pick<
  ReadService,
  | "issueScope"
  | "validScope"
  | "trackExecution"
  | "invalidateBinding"
  | "watchBinding"
  | "assertSession"
  | "watchSession"
  | "authenticate"
> & { jobs: ModelJobs & Pick<Jobs, "create" | "createModelSchema" | "cancelMatching"> };
