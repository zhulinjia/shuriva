import { z } from "zod";
import { mcpOAuthScopes } from "./oauth-config.js";
export const mcpTools = [
  "workspaces_list",
  "datasources_list",
  "schema_get",
  "query_prepare",
  "change_propose",
  "operation_status",
  "operation_cancel",
] as const;
export type McpTool = (typeof mcpTools)[number];
export type McpAudit = (
  owner: string,
  id: string,
  tool?: {
    name: McpTool;
    phase: "requested" | "disclosure_authorized";
    grantId: string;
    clientId: string;
    invocationId?: string;
  },
) => Promise<void>;

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const requestIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const delegatedTablesSchema = z
  .array(z.tuple([identifier, z.array(identifier).min(1).max(256)]))
  .min(1)
  .max(256)
  .superRefine((tables, ctx) => {
    if (
      new Set(tables.map(([name]) => name)).size !== tables.length ||
      tables.some(([, columns]) => new Set(columns).size !== columns.length) ||
      Buffer.byteLength(JSON.stringify(tables)) > 24576
    )
      ctx.addIssue({ code: "custom", message: "INVALID_DELEGATION" });
  });
export const grantInput = z.strictObject({
  clientId: z.string().min(1).max(255),
  workspaceId: z.string().uuid(),
  sourceId: z.string().uuid(),
  tables: delegatedTablesSchema,
  scopes: z.array(z.enum(mcpOAuthScopes)).min(1).max(5),
  durationMinutes: z.number().int().min(5).max(480),
});
export type GrantInput = z.infer<typeof grantInput>;
export interface GrantView {
  id: string;
  ownerId: string;
  clientId: string;
  approvalSessionId: string;
  workspaceId: string;
  sourceId: string;
  connectorId: string;
  bindingGeneration: string | null;
  tables: z.infer<typeof delegatedTablesSchema>;
  scopes: string[];
  generation: number;
  expiresAt: number;
  revoked: boolean;
}
export const clientInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  redirectUri: z.string().min(1).max(512),
  mode: z.enum(["http", "local_domain"]),
});
export const queryInput = z
  .strictObject({
    requestId: requestIdSchema,
    workspaceId: z.string().uuid(),
    sourceId: z.string().uuid(),
    sql: z.string().min(1).max(16384),
    parameters: z
      .array(
        z.strictObject({
          kind: z.enum(["string", "integer", "decimal", "boolean", "null"]),
          value: z.string().max(4096),
        }),
      )
      .max(64),
    maxRows: z.number().int().min(1).max(1000),
    schemaVersion: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 24576)
      ctx.addIssue({ code: "custom", message: "MCP_PLAN_TOO_LARGE" });
  });
export type QueryInput = z.infer<typeof queryInput>;
export type InvocationState =
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "outcome_unknown";
export class McpError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function safeCallback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.href === raw &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
