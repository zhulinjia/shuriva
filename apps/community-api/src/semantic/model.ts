import { z } from "zod";

// Business text is untrusted input. It is never SQL or an authorization rule.
const identifier = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 256 &&
      Array.from(value).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    "Invalid database identifier",
  );
const label = z.string().trim().min(1).max(120);
const description = z.string().trim().max(1000);
const aliases = z.array(label).max(20);
const sensitivity = z.enum(["normal", "sensitive"]);
const named = { name: label, description, aliases, sensitivity };
const fieldRef = z.strictObject({
  table: identifier,
  column: identifier,
  type: z.string().min(1).max(2048),
});

export const semanticDocumentSchema = z
  .strictObject({
    entities: z.array(z.strictObject({ ...named, table: identifier })).max(256),
    fields: z.array(z.strictObject({ ...named, ...fieldRef.shape })).max(4096),
    relationships: z
      .array(
        z.strictObject({
          ...named,
          from: fieldRef,
          to: fieldRef,
        }),
      )
      .max(256),
    metrics: z
      .array(
        z.strictObject({
          ...named,
          field: fieldRef,
          aggregation: z.enum(["count", "sum", "avg", "min", "max"]),
        }),
      )
      .max(256),
  })
  .superRefine((document, context) => {
    const identities = {
      entities: document.entities.map((item) => item.table),
      fields: document.fields.map((item) => JSON.stringify([item.table, item.column])),
      relationships: document.relationships.map((item) => item.name),
      metrics: document.metrics.map((item) => item.name),
    };
    for (const [key, values] of Object.entries(identities)) {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value))
          context.addIssue({ code: "custom", path: [key], message: "duplicate" });
        seen.add(value);
      }
    }
    for (const [index, metric] of document.metrics.entries()) {
      if (
        ["sum", "avg"].includes(metric.aggregation) &&
        !/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i.test(
          metric.field.type,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["metrics", index, "field"],
          message: "numeric field required",
        });
    }
  });

export type SemanticDocument = z.infer<typeof semanticDocumentSchema>;
export type SemanticSnapshot = {
  database: string;
  tables: Array<{ name: string; kind: string }>;
  columns: Array<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    position: number;
  }>;
};

export const emptySemanticDocument = (): SemanticDocument => ({
  entities: [],
  fields: [],
  relationships: [],
  metrics: [],
});

/** Return individual entries whose physical references no longer match the latest scan. */
export function staleSemanticEntries(
  document: SemanticDocument,
  snapshot: SemanticSnapshot,
): string[] {
  const tables = new Set(
    snapshot.tables.filter((table) => table.kind === "BASE TABLE").map((table) => table.name),
  );
  const columns = new Map(
    snapshot.columns.map((column) => [JSON.stringify([column.table, column.name]), column.type]),
  );
  const valid = (field: z.infer<typeof fieldRef>) =>
    tables.has(field.table) &&
    columns.get(JSON.stringify([field.table, field.column])) === field.type;
  return [
    ...document.entities
      .filter((item) => !tables.has(item.table))
      .map((item) => `实体：${item.name}`),
    ...document.fields.filter((item) => !valid(item)).map((item) => `字段：${item.name}`),
    ...document.relationships
      .filter((item) => !valid(item.from) || !valid(item.to))
      .map((item) => `关系：${item.name}`),
    ...document.metrics.filter((item) => !valid(item.field)).map((item) => `指标：${item.name}`),
  ];
}
