import type { SignedMessage } from "./identity-protocol.js";
import { signedMessageBodyFields } from "./identity-protocol.js";
import { createHash } from "node:crypto";

export interface SchemaTask {
  id: string;
  connectorId: string;
  actorId: string;
  workspaceId: string;
  sourceId: string;
  operation: "schema_scan";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  protocol: 2;
  signature: string;
}
export interface SchemaResult extends SignedMessage {
  taskId: string;
  workspaceId: string;
  sourceId: string;
  outcome: "ok" | "failed";
  payload: string;
}

export const schemaResultBodyFields = [
  ...signedMessageBodyFields,
  "taskId",
  "workspaceId",
  "sourceId",
  "outcome",
  "payload",
] as const;

export function schemaTaskFields(
  input: Omit<SchemaTask, "signature" | "operation" | "protocol">,
): string[] {
  return [
    "connector-v2",
    "schema-scan",
    input.id,
    input.connectorId,
    input.actorId,
    input.workspaceId,
    input.sourceId,
    String(input.issuedAt),
    String(input.expiresAt),
    input.nonce,
    "2",
  ];
}

export function schemaResultFields(input: SchemaResult): string[] {
  return [
    "connector-v2",
    "scan-result",
    input.connectorId,
    input.taskId,
    input.workspaceId,
    input.sourceId,
    input.outcome,
    createHash("sha256").update(input.payload).digest("hex"),
    input.agentVersion,
    "2",
    String(input.timestamp),
    input.nonce,
  ];
}
