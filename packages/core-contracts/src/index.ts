import { z } from "zod";

export const coreContractVersion = "0.1.8" as const;
export * from "./model-schema.js";
export * from "./query-plan.js";
export * from "./read-payload.js";

/** Transport contracts carry no permission. Each host verifies identity and local policy. */
export interface SignedMessage {
  connectorId: string;
  agentVersion: string;
  protocol: number;
  timestamp: number;
  nonce: string;
  signature: string;
}

/** Sensitive payloads remain in bounded transient memory, never ordinary logs or audit. */
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

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const actor = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
function base64url(bytes: number) {
  return z
    .string()
    .max(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      try {
        const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
        return (
          decoded.length === bytes &&
          btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") === value
        );
      } catch {
        return false;
      }
    }, "Invalid canonical base64url");
}
const nonce = base64url(32);
const signature = base64url(64);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = { connectorId: uuid, actorId: actor, workspaceId: uuid, sourceId: uuid };
// Size limits here are transport ceilings; SQL and result policies can impose smaller limits.
const payload = z
  .string()
  .max(1398102)
  .refine(
    (value) => new TextEncoder().encode(value).length <= 1398102,
    "Connector payload exceeds contract limit",
  );
export const readTaskSchema = z
  .strictObject({
    ...scope,
    id: uuid,
    operation: z.enum(["read_query", "model_schema", "model_authorize"]),
    payload: z
      .string()
      .min(1)
      .max(32768)
      .regex(/^[A-Za-z0-9_-]+$/),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce,
    protocol: z.literal(1),
    signature,
  })
  .refine(
    (task) =>
      task.expiresAt > task.issuedAt &&
      task.expiresAt - task.issuedAt <= (task.operation === "model_authorize" ? 30 : 60),
    "Invalid task lifetime",
  );
export const readCancelSchema = z
  .strictObject({
    ...scope,
    taskId: uuid,
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce,
    signature,
  })
  .refine(
    (task) => task.expiresAt > task.issuedAt && task.expiresAt - task.issuedAt <= 60,
    "Invalid cancellation lifetime",
  );
export const readResultSchema = z.strictObject({
  ...scope,
  taskId: uuid,
  taskNonce: nonce,
  outcome: z.enum(["ok", "failed"]),
  payload,
  timestamp,
  nonce,
  signature,
});
export const schemaTaskSchema = z
  .strictObject({
    ...scope,
    id: uuid,
    operation: z.literal("schema_scan"),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce,
    protocol: z.literal(2),
    signature,
  })
  .refine((task) => task.expiresAt - task.issuedAt === 60, "Invalid task lifetime");
export const schemaResultSchema = z.strictObject({
  connectorId: uuid,
  agentVersion: z.string().min(1).max(64),
  protocol: z.literal(2),
  timestamp,
  nonce,
  signature,
  taskId: uuid,
  workspaceId: uuid,
  sourceId: uuid,
  outcome: z.enum(["ok", "failed"]),
  payload,
});

/** Heartbeat carries the actual task object directly, not ConnectorCommand's host-side wrapper. */
export const cancelReadWireTaskSchema = z
  .strictObject({
    ...scope,
    id: uuid,
    operation: z.literal("cancel_read"),
    protocol: z.literal(1),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce,
    signature,
  })
  .refine((task) => task.expiresAt > task.issuedAt && task.expiresAt - task.issuedAt <= 60);
export const diagnosticTaskSchema = z
  .strictObject({
    id: uuid,
    connectorId: uuid,
    actorId: actor,
    operation: z.literal("diagnostic"),
    protocol: z.literal(1),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce,
    signature,
  })
  .refine((task) => task.expiresAt > task.issuedAt && task.expiresAt - task.issuedAt <= 60);
export const connectorHeartbeatReplySchema = z.strictObject({
  ok: z.literal(true),
  protocol: z.literal(1),
  signature,
  task: z
    .union([readTaskSchema, cancelReadWireTaskSchema, schemaTaskSchema, diagnosticTaskSchema])
    .nullable(),
});
export type ConnectorHeartbeatReply = z.infer<typeof connectorHeartbeatReplySchema>;
export type CancelReadWireTask = z.infer<typeof cancelReadWireTaskSchema>;
export function cancelReadWireTask(input: ReadCancel): CancelReadWireTask {
  const { taskId, ...rest } = input;
  return cancelReadWireTaskSchema.parse({
    ...rest,
    id: taskId,
    operation: "cancel_read",
    protocol: 1,
  });
}

export interface PairInput {
  pairingId: string;
  proof: string;
  connectorId: string;
  name: string;
  publicKey: string;
  agentVersion: string;
  protocol: number;
  signature: string;
}
export type HeartbeatInput = SignedMessage;
export interface RotateInput extends SignedMessage {
  newPublicKey: string;
}
export type PairingOffer = {
  pairingId: string;
  secret: string;
  platformPublicKey: string;
  expiresAt: number;
};
export type IdentityAcknowledgement = { ok: true; protocol: 1 | 2; signature: string };
const agentVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._+-]+$/);
export const pairInputSchema = z.strictObject({
  pairingId: uuid,
  proof: nonce,
  connectorId: uuid,
  name: z
    .string()
    .min(1)
    .max(120)
    .refine((value) =>
      Array.from(value).every((c) => (c.codePointAt(0) ?? 0) >= 32 && c.codePointAt(0) !== 127),
    ),
  publicKey: nonce,
  agentVersion,
  protocol: z.literal(2),
  signature,
});
export const heartbeatInputSchema = z.strictObject({
  connectorId: uuid,
  agentVersion,
  protocol: z.number().int().min(1).max(255),
  timestamp,
  nonce,
  signature,
});
export const rotateInputSchema = heartbeatInputSchema.extend({ newPublicKey: nonce });
export const pairingOfferSchema = z.strictObject({
  pairingId: uuid,
  secret: nonce,
  platformPublicKey: nonce,
  expiresAt: timestamp,
});
export const identityAcknowledgementSchema = z.strictObject({
  ok: z.literal(true),
  protocol: z.union([z.literal(1), z.literal(2)]),
  signature,
});

export function canonicalPairFields(input: PairInput): string[] {
  return [
    "connector-v2",
    "pair",
    input.pairingId,
    input.proof,
    input.connectorId,
    input.name,
    input.publicKey,
    input.agentVersion,
    "2",
  ];
}
export function canonicalPairProofFields(input: PairInput): string[] {
  return [
    "connector-v2",
    "pair-proof",
    input.pairingId,
    input.connectorId,
    input.name,
    input.publicKey,
    input.agentVersion,
    "2",
  ];
}
export function canonicalIdentityFields(
  operation: "heartbeat" | "rotate" | "probe",
  input: SignedMessage | RotateInput,
): string[] {
  if (operation === "rotate" && !("newPublicKey" in input)) throw new Error("Rotation key missing");
  return [
    "connector-v1",
    operation,
    input.connectorId,
    ...(operation === "rotate" && "newPublicKey" in input ? [input.newPublicKey] : []),
    input.agentVersion,
    String(input.protocol),
    String(input.timestamp),
    input.nonce,
  ];
}
export function canonicalPairAcknowledgement(input: PairInput): string[] {
  return [
    "connector-v2",
    "pair-ack",
    input.pairingId,
    input.connectorId,
    input.publicKey,
    input.proof,
    "2",
  ];
}
export function canonicalIdentityAcknowledgement(
  operation: "heartbeat" | "rotate" | "probe",
  input: SignedMessage | RotateInput,
): string[] {
  if (operation === "rotate" && !("newPublicKey" in input)) throw new Error("Rotation key missing");
  return [
    "connector-v1",
    `${operation}-ack`,
    input.connectorId,
    ...(operation === "rotate" && "newPublicKey" in input ? [input.newPublicKey] : []),
    input.nonce,
    "1",
  ];
}

export type ConnectorCommand =
  | { kind: "read"; task: ReadTask }
  | { kind: "cancel_read"; task: ReadCancel }
  | { kind: "schema_scan"; task: SchemaTask };

/** Dispatch is an owned transport handoff, not proof of external execution. */
export interface ConnectorTaskPort {
  dispatch(command: ConnectorCommand, signal: AbortSignal): Promise<void>;
}

export const signedMessageBodyFields = [
  "connectorId",
  "agentVersion",
  "nonce",
  "signature",
  "protocol",
  "timestamp",
] as const;
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
export function canonicalReadResultAcknowledgement(input: ReadResult): string[] {
  return [
    "connector-read-v1",
    "read-result-ack",
    input.connectorId,
    input.taskId,
    input.nonce,
    "1",
  ];
}
export const schemaResultBodyFields = [
  ...signedMessageBodyFields,
  "taskId",
  "workspaceId",
  "sourceId",
  "outcome",
  "payload",
] as const;

/** The runtime supplies SHA-256; the public contract owns byte ordering without a Node dependency. */
export function canonicalReadTaskFields(
  task: ReadTask,
  sha256: (payload: string) => string,
): string[] {
  const operations = {
    read_query: "read-query",
    model_schema: "model-schema",
    model_authorize: "model-authorize",
  } as const;
  return [
    "connector-read-v1",
    operations[task.operation],
    task.id,
    task.connectorId,
    task.actorId,
    task.workspaceId,
    task.sourceId,
    sha256(task.payload),
    String(task.issuedAt),
    String(task.expiresAt),
    task.nonce,
    "1",
  ];
}
export function canonicalReadCancelFields(task: ReadCancel): string[] {
  return [
    "connector-read-v1",
    "cancel-read",
    task.taskId,
    task.connectorId,
    task.actorId,
    task.workspaceId,
    task.sourceId,
    String(task.issuedAt),
    String(task.expiresAt),
    task.nonce,
    "1",
  ];
}
export function canonicalReadResultFields(
  task: ReadResult,
  sha256: (payload: string) => string,
): string[] {
  return [
    "connector-read-v1",
    "read-result",
    task.taskId,
    task.connectorId,
    task.actorId,
    task.workspaceId,
    task.sourceId,
    task.taskNonce,
    task.outcome,
    sha256(task.payload),
    String(task.timestamp),
    task.nonce,
    "1",
  ];
}
export function canonicalSchemaTaskFields(
  task: Omit<SchemaTask, "signature" | "operation" | "protocol">,
): string[] {
  return [
    "connector-v2",
    "schema-scan",
    task.id,
    task.connectorId,
    task.actorId,
    task.workspaceId,
    task.sourceId,
    String(task.issuedAt),
    String(task.expiresAt),
    task.nonce,
    "2",
  ];
}
export function canonicalSchemaResultFields(
  task: SchemaResult,
  sha256: (payload: string) => string,
): string[] {
  return [
    "connector-v2",
    "scan-result",
    task.connectorId,
    task.taskId,
    task.workspaceId,
    task.sourceId,
    task.outcome,
    sha256(task.payload),
    task.agentVersion,
    "2",
    String(task.timestamp),
    task.nonce,
  ];
}
