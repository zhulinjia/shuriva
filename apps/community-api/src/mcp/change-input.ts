import { z } from "zod";
import { mutationPlanSchema } from "../mutations/public.js";
import { type GrantView, McpError, requestIdSchema } from "./model.js";

// Reserve space for the JSON-RPC envelope and metadata within the common
// transport limits. The same bound applies before any grant-backed staging.
export const changeDraftLimits = { bytes: 24576, nodes: 1800 } as const;
function nodeCount(value: unknown) {
  const stack = [value];
  let count = 0;
  while (stack.length) {
    const next = stack.pop();
    count++;
    if (count > changeDraftLimits.nodes) return count;
    if (next && typeof next === "object") stack.push(...Object.values(next));
  }
  return count;
}
/** This validates an already-authorized grant's contents; it never authenticates a caller. */
export const changeInput = z
  .strictObject({
    requestId: requestIdSchema,
    workspaceId: z.string().uuid(),
    sourceId: z.string().uuid(),
    plan: mutationPlanSchema,
  })
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > changeDraftLimits.bytes)
      context.addIssue({ code: "custom", message: "MCP_PLAN_TOO_LARGE" });
    if (nodeCount(value) > changeDraftLimits.nodes)
      context.addIssue({ code: "custom", message: "MCP_PLAN_TOO_COMPLEX" });
  })
  .describe(
    "The entire arguments object is limited to 24576 UTF-8 bytes and 1800 JSON value nodes; transport envelope and metadata have separate limits.",
  );

export function validateChangeInput(
  input: unknown,
  grant: Pick<GrantView, "workspaceId" | "sourceId" | "tables">,
) {
  const parsed = changeInput.safeParse(input);
  if (!parsed.success) throw new McpError("MCP_PLAN_INVALID");
  const value = parsed.data;
  if (value.workspaceId !== grant.workspaceId || value.sourceId !== grant.sourceId)
    throw new McpError("MCP_SCOPE_REJECTED", 403);
  const columns = grant.tables.find(([name]) => name === value.plan.table)?.[1];
  if (!columns) throw new McpError("MCP_SCOPE_REJECTED", 403);
  const permitted = new Set(columns);
  const plan = value.plan;
  const references =
    plan.operation === "insert"
      ? plan.rows.flatMap((row) => row.map((field) => field.column))
      : [
          ...plan.where.map((field) => field.column),
          ...(plan.operation === "update" ? plan.changes.map((field) => field.column) : []),
        ];
  if (references.some((column) => !permitted.has(column)))
    throw new McpError("MCP_SCOPE_REJECTED", 403);
  return value;
}
