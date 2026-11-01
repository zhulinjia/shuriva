import { createHash } from "node:crypto";
import { z } from "zod";

const uuid = z.string().uuid();
const encoded32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const mutationPayloadMax = 1_048_576 + 65_536;
export const mutationOperations = [
  "capability",
  "preview",
  "execute",
  "status",
  "cancel",
  "recover",
] as const;
export type MutationOperation = (typeof mutationOperations)[number];
export const mutationMessageSchema = z.strictObject({
  id: uuid,
  connectorId: uuid,
  ownerId: z.string().regex(/^[A-Za-z0-9._:-]{0,128}$/),
  workspaceId: z.union([uuid, z.literal("")]),
  sourceId: z.union([uuid, z.literal("")]),
  kind: z.enum([
    "poll",
    "poll_reply",
    "task",
    "result",
    "result_reply",
    "claim",
    "claim_reply",
    "permit",
    "permit_reply",
  ]),
  operation: z.union([z.enum(mutationOperations), z.literal("")]),
  payload: z
    .string()
    .min(1)
    .max(2_097_152)
    .regex(/^[A-Za-z0-9_-]+$/),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  nonce: encoded32,
  replyTo: z.union([encoded32, z.literal("")]),
  protocol: z.literal(1),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type MutationMessage = z.infer<typeof mutationMessageSchema>;
export type UnsignedMutationMessage = Omit<MutationMessage, "signature">;

export function mutationMessageFields(message: UnsignedMutationMessage): string[] {
  return [
    "connector-mutation-v1",
    message.kind,
    message.operation,
    message.id,
    message.connectorId,
    message.ownerId,
    message.workspaceId,
    message.sourceId,
    createHash("sha256").update(message.payload).digest("hex"),
    String(message.issuedAt),
    String(message.expiresAt),
    message.nonce,
    message.replyTo,
    "1",
  ];
}

export function validateMutationMessage(
  input: unknown,
  now = Math.floor(Date.now() / 1000),
): MutationMessage {
  const message = mutationMessageSchema.parse(input);
  if (
    message.expiresAt <= now ||
    message.expiresAt <= message.issuedAt ||
    message.expiresAt - message.issuedAt > 30 ||
    message.issuedAt > now + 2 ||
    Buffer.from(message.payload, "base64url").toString("base64url") !== message.payload
  )
    throw new Error("invalid mutation envelope");
  const poll = message.kind === "poll" || message.kind === "poll_reply";
  if (
    poll
      ? message.ownerId !== "" ||
        message.workspaceId !== "" ||
        message.sourceId !== "" ||
        message.operation !== ""
      : message.ownerId === "" ||
        message.workspaceId === "" ||
        message.sourceId === "" ||
        message.operation === ""
  )
    throw new Error("invalid mutation routing");
  if (
    ["poll", "task", "claim", "permit"].includes(message.kind)
      ? message.replyTo !== ""
      : message.replyTo === ""
  )
    throw new Error("invalid mutation reply binding");
  if (Buffer.from(message.payload, "base64url").length > mutationPayloadMax)
    throw new Error("mutation payload too large");
  decodeMutationPayload(message);
  return message;
}

export function mutationPayload(data: unknown): string {
  const raw = JSON.stringify(data);
  if (raw === undefined || Buffer.byteLength(raw) > mutationPayloadMax)
    throw new Error("mutation payload too large");
  return Buffer.from(raw).toString("base64url");
}
export function decodeMutationPayload(message: MutationMessage): unknown {
  const bytes = Buffer.from(message.payload, "base64url");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
