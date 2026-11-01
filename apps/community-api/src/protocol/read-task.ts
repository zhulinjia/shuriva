import { createHash } from "node:crypto";

/** Payload is sensitive in-memory data; never write it to logs or durable storage. */
export type ReadTask = {
  id: string;
  connectorId: string;
  actorId: string;
  workspaceId: string;
  sourceId: string;
  operation: "read_query" | "model_schema" | "model_authorize";
  payload: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  protocol: 1;
  signature: string;
};

export function readTaskFields(task: ReadTask): string[] {
  return [
    "connector-read-v1",
    task.operation === "read_query"
      ? "read-query"
      : task.operation === "model_schema"
        ? "model-schema"
        : "model-authorize",
    task.id,
    task.connectorId,
    task.actorId,
    task.workspaceId,
    task.sourceId,
    createHash("sha256").update(task.payload).digest("hex"),
    String(task.issuedAt),
    String(task.expiresAt),
    task.nonce,
    "1",
  ];
}

export type ReadCancel = {
  taskId: string;
  connectorId: string;
  actorId: string;
  workspaceId: string;
  sourceId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
};

export function readCancelFields(cancel: ReadCancel): string[] {
  return [
    "connector-read-v1",
    "cancel-read",
    cancel.taskId,
    cancel.connectorId,
    cancel.actorId,
    cancel.workspaceId,
    cancel.sourceId,
    String(cancel.issuedAt),
    String(cancel.expiresAt),
    cancel.nonce,
    "1",
  ];
}

export type ReadResult = {
  taskId: string;
  connectorId: string;
  actorId: string;
  workspaceId: string;
  sourceId: string;
  taskNonce: string;
  outcome: "ok" | "failed";
  payload: string;
  timestamp: number;
  nonce: string;
  signature: string;
};

export const readResultBodyFields = [
  "taskId",
  "connectorId",
  "actorId",
  "workspaceId",
  "sourceId",
  "taskNonce",
  "outcome",
  "payload",
  "timestamp",
  "nonce",
  "signature",
] as const;

export function readResultFields(result: ReadResult): string[] {
  return [
    "connector-read-v1",
    "read-result",
    result.taskId,
    result.connectorId,
    result.actorId,
    result.workspaceId,
    result.sourceId,
    result.taskNonce,
    result.outcome,
    createHash("sha256").update(result.payload).digest("hex"),
    String(result.timestamp),
    result.nonce,
    "1",
  ];
}
