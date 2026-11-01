import type { ConnectorRegistry } from "./registry.js";
export { ConnectorError } from "./errors.js";
export type { SchemaResult, SchemaTask } from "./schema-protocol.js";
export type { AuthenticateOwner } from "./routes.js";
export { decodeMutationPayload, mutationPayload } from "./mutation-protocol.js";
export type { MutationMessage, MutationOperation } from "./mutation-protocol.js";

/** Small operation-specific boundaries; identity and its single lock remain owned by the Connector. */
export type ConnectorAuthorization = Pick<ConnectorRegistry, "isActiveOwner" | "withActiveOwner">;
export type ScanConnector = Pick<
  ConnectorRegistry,
  "issueSchemaTask" | "verifySchemaResult" | "schemaResultAcknowledgement"
>;
export type QueryConnector = Pick<
  ConnectorRegistry,
  | "withActiveOwner"
  | "issueReadCancel"
  | "issueReadTask"
  | "preflightReadResult"
  | "verifyReadResult"
  | "readResultAcknowledgement"
>;
export type MutationConnector = Pick<
  ConnectorRegistry,
  "signMutationMessage" | "authenticateMutationMessage" | "assertCurrentMutationMessage"
>;
