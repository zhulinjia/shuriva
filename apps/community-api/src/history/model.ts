import { z } from "zod";
import { validId } from "../datasources/public.js";

export const historyKinds = ["conversation", "artifact", "execution", "audit"] as const;
export type HistoryKind = (typeof historyKinds)[number];
export type HistoryScope = { ownerId: string; workspaceId: string; sourceId: string };
const id = z.string().uuid();
const text = z.string().trim().min(1).max(120);
const parameterKind = z.enum(["string", "integer", "decimal", "boolean", "null"]);
export const conversationSchema = z
  .strictObject({
    title: text,
    messages: z
      .array(
        z.strictObject({
          id,
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1).max(16384),
        }),
      )
      .max(200),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.messages.map((message) => message.id)).size !== value.messages.length)
      ctx.addIssue({ code: "custom", message: "duplicate message" });
  });
export const artifactSchema = z
  .strictObject({
    name: text,
    kind: z.enum(["query", "analysis", "chart"]),
    sql: z.string().trim().min(1).max(16384),
    parameterKinds: z.array(parameterKind).max(64),
    maxRows: z.number().int().min(1).max(1000),
    schemaVersion: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    notes: z.string().max(4000),
    chart: z
      .strictObject({
        type: z.enum(["bar", "line"]),
        x: z.string().min(1).max(64),
        y: z.string().min(1).max(64),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.kind === "chart") !== (value.chart !== null))
      ctx.addIssue({ code: "custom", message: "chart definition mismatch" });
  });
export const executionStates = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "outcome_unknown",
] as const;
export type ExecutionState = (typeof executionStates)[number];
export const executionSchema = z
  .strictObject({
    taskId: id,
    connectorId: id,
    instanceId: id,
    state: z.enum(executionStates),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    rowCount: z.number().int().min(0).max(1000).nullable(),
    truncated: z.boolean(),
    reason: z.enum(["rows", "bytes", "cell"]).nullable(),
    code: z
      .enum([
        "denied",
        "unavailable",
        "cancelled",
        "timeout",
        "error",
        "outcome_unknown",
        "schema_changed",
      ])
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.truncated !== (value.reason !== null))
      ctx.addIssue({ code: "custom", message: "invalid truncation summary" });
    if (value.state !== "completed" && (value.rowCount !== null || value.truncated))
      ctx.addIssue({ code: "custom", message: "incomplete execution cannot contain results" });
  });
export const auditEvents = [
  "mcp.external.connection_save_requested",
  "mcp.external.connection_disable_requested",
  "mcp.external.credential_change_requested",
  "mcp.external.discovery_requested",
  "mcp.external.tool_approval_requested",
  "mcp.external.tool_approval_revocation_requested",
  "mcp.external.authorization_requested",
  "mcp.external.authorization_finished",
  "mcp.external.call_prepare_requested",
  "mcp.external.call_approval_requested",
  "mcp.external.call_dispatch_requested",
  "mcp.external.call_finished",
  "mcp.external.call_cancel_requested",
  "mcp.external.unknown_acknowledgment_requested",
  "mcp.invocation_registered",
  "mcp.client_registered",
  "mcp.client_disabled",
  "mcp.tool_requested",
  "mcp.tool_disclosure_authorized",
  "mcp.grant_created",
  "mcp.grant_revoked",
  "mcp.consent_decided",
  "mcp.query_decided",
  "mcp.change_claim_requested",
  "mcp.change_receipt_requested",
  "mcp.change_preview_origin_verified",
  "connection.pairing_created",
  "connection.check_requested",
  "connection.paired",
  "connection.revoked",
  "connection.rotated",
  "connection.checked",
  "source.created",
  "source.bound",
  "source.unbound",
  "source.scanned",
  "source.changed",
  "workspace.archived",
  "workspace.restored",
  "model.changed",
  "model.checked",
  "model.requested",
  "model.completed",
  "model.failed",
  "query.submitted",
  "query.completed",
  "query.failed",
  "query.cancelled",
  "query.expired",
  "query.unknown",
  "security.denied",
  "conversation.saved",
  "conversation.deleted",
  "conversation.restored",
  "artifact.saved",
  "artifact.deleted",
  "artifact.restored",
  "result.exported",
  "mutation.confirmed",
  "mutation.cancelled",
  "mutation.state_changed",
  "mutation.target_frozen",
] as const;
export const auditSchema = z.strictObject({
  event: z.enum(auditEvents),
  outcome: z.enum(["success", "failure", "denied", "unknown"]),
  mcpTool: z
    .enum([
      "workspaces_list",
      "datasources_list",
      "schema_get",
      "query_prepare",
      "change_propose",
      "operation_status",
      "operation_cancel",
    ])
    .optional(),
  mcpGrantId: id.optional(),
  mcpInvocationId: id.optional(),
  mcpPlanChanged: z.boolean().optional(),
  mcpClientId: z.string().min(1).max(255).optional(),
  externalConnectionId: id.optional(),
  externalCallId: id.optional(),
  externalCallState: z
    .enum([
      "pending_approval",
      "running",
      "succeeded",
      "failed",
      "cancel_requested",
      "outcome_unknown",
      "expired",
      "cancelled",
    ])
    .optional(),
  connectorId: id.optional(),
  executionId: id.optional(),
  targetId: id.optional(),
  attemptedWorkspaceId: z.string().refine(validId).optional(),
  attemptedSourceId: z.string().refine(validId).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type AuditEntry = z.infer<typeof auditSchema>;
export const historySchemas = {
  conversation: conversationSchema,
  artifact: artifactSchema,
  execution: executionSchema,
  audit: auditSchema,
};

/** Content is not an execution grant. Stored definitions must be re-authorized. */
export function parseHistoryContent(
  kind: HistoryKind,
  input: unknown,
): Conversation | Artifact | Execution | AuditEntry {
  const parsed = historySchemas[kind].parse(input);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 256 * 1024) throw new Error("INVALID");
  return parsed;
}
