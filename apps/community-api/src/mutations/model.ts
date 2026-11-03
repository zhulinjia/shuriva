import { z } from "zod";

export const mutationId = z.string().uuid();
export const mutationBoot = z.string().regex(/^[0-9a-f]{64}$/);
export const mutationCommitment = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine(
    (value) =>
      Buffer.from(value, "base64url").length === 32 &&
      Buffer.from(value, "base64url").toString("base64url") === value,
  );
const identifier = z
  .string()
  .min(1)
  .max(64)
  .refine((value) =>
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    }),
  );
export const mutationValueSchema = z.strictObject({
  kind: z.enum(["null", "string", "integer", "decimal", "boolean", "binary", "date", "datetime"]),
  value: z
    .string()
    .max(32768)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 32768),
});
const assignment = z.strictObject({ column: identifier, value: mutationValueSchema });
const predicate = z
  .strictObject({
    column: identifier,
    operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "is_null", "not_null"]),
    value: mutationValueSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (
      (item.operator === "is_null" || item.operator === "not_null") !==
      (item.value === undefined)
    )
      ctx.addIssue({ code: "custom", message: "predicate value mismatch" });
  });
const assignments = z
  .array(assignment)
  .min(1)
  .max(256)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.column)).size !== items.length)
      ctx.addIssue({ code: "custom", message: "duplicate column" });
  });
export const mutationPlanSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("insert"),
    table: identifier,
    rows: z.array(assignments).min(1).max(100),
  }),
  z.strictObject({
    operation: z.literal("update"),
    table: identifier,
    changes: assignments,
    where: z.array(predicate).min(1).max(32),
  }),
  z.strictObject({
    operation: z.literal("delete"),
    table: identifier,
    where: z.array(predicate).min(1).max(32),
  }),
]);
export type MutationPlan = z.infer<typeof mutationPlanSchema>;
export type MutationScope = { ownerId: string; workspaceId: string; sourceId: string };
export type MutationIdentity = { ownerId: string; sessionId: string };
export type MutationBinding = MutationScope & {
  connectorId: string;
  bindingGeneration?: string | null;
};

export const mutationStates = [
  "registered",
  "running",
  "commit_intent",
  "committed",
  "rolled_back",
  "rejected",
  "outcome_unknown",
] as const;
export type MutationState = (typeof mutationStates)[number];
export const terminalMutationStates: ReadonlySet<MutationState> = new Set([
  "committed",
  "rolled_back",
  "rejected",
]);
export const mutationErrorCodes = [
  "INVALID",
  "NOT_FOUND",
  "CONFLICT",
  "EXPIRED",
  "UNAVAILABLE",
  "FROZEN",
  "DENIED",
  "CAPACITY",
  "STALE_BOOT",
] as const;
export type MutationErrorCode = (typeof mutationErrorCodes)[number];
export class MutationError extends Error {
  constructor(readonly code: MutationErrorCode) {
    super(code);
  }
}

export const previewMetadataSchema = z.strictObject({
  previewId: mutationId,
  commitment: mutationCommitment,
  revision: z.number().int().min(1).max(4294967295),
  apiBoot: mutationBoot,
  connectorBoot: mutationBoot,
  targetIdentity: z.string().min(1).max(256),
  targetEpoch: mutationBoot,
  policyGeneration: z.string().min(1).max(128),
  installationGeneration: z.string().min(1).max(128),
  operation: z.enum(["insert", "update", "delete"]),
  table: identifier,
  rowCount: z.number().int().min(1).max(100),
  expiresAt: z.string().datetime(),
});
export type PreviewMetadata = z.infer<typeof previewMetadataSchema>;
export const confirmationSchema = z.strictObject({
  confirmationId: mutationId,
  previewId: mutationId,
  commitment: mutationCommitment,
  revision: z.number().int().min(1).max(4294967295),
});
export type ConfirmationInput = z.infer<typeof confirmationSchema>;
export type MutationExecution = PreviewMetadata &
  MutationBinding & {
    executionId: string;
    confirmationId: string;
    sessionId: string;
    state: MutationState;
    cancelRequested: boolean;
    permitIssued: boolean;
    createdAt: string;
    updatedAt: string;
    code: string | null;
    reconciliationExpiresAt: string | null;
    affectedRows: number | null;
  };
export type PublicMutationExecution = Omit<MutationExecution, "sessionId">;
export function publicExecution(value: MutationExecution): PublicMutationExecution {
  const { sessionId: _privateSession, ...record } = value;
  return record;
}
export const executionBindingSchema = z.strictObject({
  ownerId: mutationId,
  workspaceId: mutationId,
  sourceId: mutationId,
  connectorId: mutationId,
  executionId: mutationId,
  commitment: mutationCommitment,
  previewId: mutationId,
  revision: z.number().int().min(1).max(4294967295),
  apiBoot: mutationBoot,
  connectorBoot: mutationBoot,
  targetEpoch: mutationBoot,
  targetIdentity: z.string().min(1).max(256),
  policyGeneration: z.string().min(1).max(128),
  installationGeneration: z.string().min(1).max(128),
});
export const permitRequestSchema = executionBindingSchema.extend({ challenge: mutationCommitment });
export type MutationExecutionBinding = z.infer<typeof executionBindingSchema>;
export type MutationPermitRequest = z.infer<typeof permitRequestSchema>;
export type MutationPermit = MutationPermitRequest & {
  permitId: string;
  budgetMillis: 3000;
  signature: string;
};
export const mutationReceiptSchema = z.strictObject({
  executionId: mutationId,
  commitment: mutationCommitment,
  targetIdentity: z.string().min(1).max(256),
  targetEpoch: mutationBoot,
  scope: z.strictObject({
    ownerId: mutationId,
    workspaceId: mutationId,
    sourceId: mutationId,
    connectorId: mutationId,
  }),
  rowCount: z.number().int().min(1).max(100),
});
export type MutationReceiptSummary = z.infer<typeof mutationReceiptSchema>;
