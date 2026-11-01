import { z } from "zod";
import { decodeModelDisclosure, type ModelSchema } from "../../ai/public.js";
import { mutationBoot, type MutationPlan } from "../model.js";
import type { MutationCapability } from "../ports.js";

const columns = z
  .array(z.string().min(1).max(64))
  .max(256)
  .refine((items) => new Set(items).size === items.length);
const writable = z.strictObject({
  insert: columns,
  update: columns,
  filter: columns,
  delete: z.boolean(),
});
const capabilitySchema = z.object({
  available: z.literal(true),
  code: z.string().max(80),
  connectorBoot: mutationBoot,
  targetIdentity: z.string().min(1).max(256),
  targetEpoch: mutationBoot,
  policyGeneration: z.string().min(1).max(128),
  installationGeneration: z.string().min(1).max(128),
  writeColumns: z.record(z.string().min(1).max(64), writable),
});
export type MutationAIWriteScope = z.infer<typeof capabilitySchema>;
const simple = {
  name: z.string().max(160),
  description: z.string().max(8192),
  aliases: z.array(z.string().max(160)).max(100),
};
const field = z.strictObject({ table: z.string().max(64), column: z.string().max(64) });
const semanticsSchema = z.strictObject({
  entities: z.array(z.strictObject({ ...simple, table: z.string().max(64) })).max(256),
  fields: z
    .array(z.strictObject({ ...simple, table: z.string().max(64), column: z.string().max(64) }))
    .max(4096),
  relationships: z.array(z.strictObject({ ...simple, from: field, to: field })).max(4096),
  metrics: z.array(z.strictObject({ ...simple, field, aggregation: z.string().max(80) })).max(4096),
});
export function mutationAIContext(
  raw: ModelSchema,
  capability: MutationCapability,
  disclosedSemantics?: unknown,
) {
  const source = decodeModelDisclosure(raw).schema;
  const attestation = capabilitySchema.parse(capability);
  if (Object.keys(attestation.writeColumns).length > 256) throw Error("NO_MODEL_FIELDS");
  const writes: Record<string, z.infer<typeof writable>> = Object.create(null);
  const schema: ModelSchema = { database: source.database, tables: [] };
  for (const table of source.tables) {
    const allowed = Object.hasOwn(attestation.writeColumns, table.name)
      ? attestation.writeColumns[table.name]
      : undefined;
    if (!allowed) continue;
    const names = new Set([...allowed.insert, ...allowed.update, ...allowed.filter]);
    const available = table.columns.filter((column) => names.has(column.name));
    const visible = new Set(available.map((column) => column.name));
    const scope = {
      insert: allowed.insert.filter((name) => visible.has(name)),
      update: allowed.update.filter((name) => visible.has(name)),
      filter: allowed.filter.filter((name) => visible.has(name)),
      delete: allowed.delete,
    };
    if (!available.length || (!scope.insert.length && !scope.update.length && !scope.delete))
      continue;
    schema.tables.push({ name: table.name, columns: available });
    writes[table.name] = scope;
  }
  if (!schema.tables.length) throw Error("NO_MODEL_FIELDS");
  const decoded = decodeModelDisclosure(schema);
  const has = (item: { table: string; column: string }) =>
    decoded.scope.get(item.table)?.has(item.column) === true;
  let semantics: z.infer<typeof semanticsSchema> | undefined;
  if (disclosedSemantics !== undefined) {
    const input = semanticsSchema.parse(disclosedSemantics);
    semantics = {
      entities: input.entities.filter((item) => decoded.scope.has(item.table)),
      fields: input.fields.filter(has),
      relationships: input.relationships.filter((item) => has(item.from) && has(item.to)),
      metrics: input.metrics.filter((item) => has(item.field)),
    };
  }
  return { schema, semantics, writes, attestation };
}
export type MutationAIContext = ReturnType<typeof mutationAIContext>;
export function assertMutationAIPlan(plan: MutationPlan, context: MutationAIContext): void {
  const allowed = context.writes[plan.table];
  if (!allowed) throw Error("INVALID_PLAN");
  if (plan.operation === "insert") {
    if (
      !allowed.insert.length ||
      plan.rows.some((row) => row.some((item) => !allowed.insert.includes(item.column)))
    )
      throw Error("INVALID_PLAN");
  } else {
    if (plan.where.some((item) => !allowed.filter.includes(item.column)))
      throw Error("INVALID_PLAN");
    if (plan.operation === "delete" && !allowed.delete) throw Error("INVALID_PLAN");
    if (
      plan.operation === "update" &&
      (!allowed.update.length || plan.changes.some((item) => !allowed.update.includes(item.column)))
    )
      throw Error("INVALID_PLAN");
  }
}
