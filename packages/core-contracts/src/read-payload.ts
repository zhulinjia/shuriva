import { z } from "zod";

const bytes = (value: string) => new TextEncoder().encode(value).length;
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/** These are wire representations, not permission to run SQL or access the named objects. */
export const readParameterSchema = z.strictObject({
  kind: z.enum(["string", "integer", "decimal", "boolean", "null"]),
  value: z
    .string()
    .max(4096)
    .refine((value) => bytes(value) <= 4096),
});
export type ReadParameter = z.infer<typeof readParameterSchema>;
const delegatedEntries = z
  .array(
    z.tuple([
      identifier,
      z
        .array(identifier)
        .min(1)
        .max(256)
        .refine((columns) => new Set(columns).size === columns.length),
    ]),
  )
  .min(1)
  .max(256);
export const delegatedReadScopeSchema = z.unknown().transform((input, context) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    context.addIssue({ code: "custom", message: "Invalid delegated scope" });
    return z.NEVER;
  }
  const keys = Object.keys(input);
  if (keys.length < 1 || keys.length > 256) {
    context.addIssue({ code: "custom", message: "Invalid delegated scope size" });
    return z.NEVER;
  }
  const parsed = delegatedEntries.safeParse(keys.map((key) => [key, Reflect.get(input, key)]));
  if (!parsed.success) {
    context.addIssue({ code: "custom", message: "Invalid delegated table or columns" });
    return z.NEVER;
  }
  // MySQL permits __proto__. Preserve it as an own key without a prototype
  // setter or inherited table properties; Zod's record parser discards this key.
  const scope: Record<string, string[]> = Object.create(null);
  for (const [table, columns] of parsed.data) scope[table] = columns;
  if (bytes(JSON.stringify(scope)) > 24576) {
    context.addIssue({ code: "custom", message: "Delegated scope exceeds wire limit" });
    return z.NEVER;
  }
  return scope;
});
export const readQueryPayloadSchema = z
  .strictObject({
    sql: z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => bytes(value) <= 16384),
    parameters: z.array(readParameterSchema).max(64),
    maxRows: z.number().int().min(1).max(1000),
    schemaVersion: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    delegatedScope: delegatedReadScopeSchema.nullable(),
  })
  .refine(
    (payload) => Math.ceil((bytes(JSON.stringify(payload)) * 4) / 3) <= 32768,
    "Encoded read request exceeds wire limit",
  );
export type ReadQueryPayload = z.infer<typeof readQueryPayloadSchema>;

export const readFailureCodeSchema = z.enum([
  "denied",
  "unavailable",
  "cancelled",
  "timeout",
  "error",
  "outcome_unknown",
  "schema_changed",
]);
export type ReadFailureCode = z.infer<typeof readFailureCodeSchema>;

function binaryCell(value: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length <= 32768 && btoa(decoded) === value;
  } catch {
    return false;
  }
}
const cellSchema = z.union([
  z.strictObject({ null: z.literal(true) }),
  z.strictObject({
    null: z.literal(false),
    encoding: z.literal("text"),
    value: z
      .string()
      .max(32768)
      .refine((value) => bytes(value) <= 32768)
      .optional(),
  }),
  z.strictObject({
    null: z.literal(false),
    encoding: z.literal("base64"),
    value: z.string().max(43692).refine(binaryCell).optional(),
  }),
]);
export const readQueryResultSchema = z
  .strictObject({
    columns: z
      .array(z.strictObject({ name: identifier, type: z.string().min(1).max(64) }))
      .min(1)
      .max(256),
    rows: z.array(z.array(cellSchema).max(256)).max(1000),
    timezone: z.literal("UTC"),
    truncated: z.boolean(),
    reason: z.enum(["rows", "bytes", "cell"]).optional(),
  })
  .refine(
    (result) =>
      result.rows.every((row) => row.length === result.columns.length) &&
      (result.truncated ? result.reason !== undefined : result.reason === undefined),
  );
export type ReadQueryResult = z.infer<typeof readQueryResultSchema>;
export function validReadQueryResult(value: unknown, maxRows: number): value is ReadQueryResult {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000) return false;
  const result = readQueryResultSchema.safeParse(value);
  return result.success && result.data.rows.length <= maxRows;
}
