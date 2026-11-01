import type { ModelSchema } from "../ai/public.js";
import type { SemanticDocument } from "./model.js";

/** Intersect business metadata with Connector authorization; sensitive entries never leave. */
export function semanticDisclosure(schema: ModelSchema, document: SemanticDocument) {
  const sensitiveTables = new Set(
    document.entities.filter((item) => item.sensitivity === "sensitive").map((item) => item.table),
  );
  const sensitiveFields = new Set(
    document.fields
      .filter((item) => item.sensitivity === "sensitive")
      .map((item) => JSON.stringify([item.table, item.column])),
  );
  const filtered: ModelSchema = {
    database: schema.database,
    tables: schema.tables
      .filter((table) => !sensitiveTables.has(table.name))
      .map((table) => ({
        name: table.name,
        columns: table.columns.filter(
          (column) => !sensitiveFields.has(JSON.stringify([table.name, column.name])),
        ),
      }))
      .filter((table) => table.columns.length > 0),
  };
  const allowed = new Map(
    filtered.tables.map((table) => [
      table.name,
      new Map(table.columns.map((column) => [column.name, column.type])),
    ]),
  );
  const has = (table: string, column: string, type: string) => {
    const baseType = type.toLowerCase().match(/^[a-z]+/)?.[0];
    return baseType !== undefined && allowed.get(table)?.get(column) === baseType;
  };
  const simple = (item: { name: string; description: string; aliases: string[] }) => ({
    name: item.name,
    description: item.description,
    aliases: item.aliases,
  });
  const semantics = {
    entities: document.entities
      .filter((item) => item.sensitivity === "normal" && allowed.has(item.table))
      .map((item) => ({ ...simple(item), table: item.table })),
    fields: document.fields
      .filter((item) => item.sensitivity === "normal" && has(item.table, item.column, item.type))
      .map((item) => ({ ...simple(item), table: item.table, column: item.column })),
    relationships: document.relationships
      .filter(
        (item) =>
          item.sensitivity === "normal" &&
          has(item.from.table, item.from.column, item.from.type) &&
          has(item.to.table, item.to.column, item.to.type),
      )
      .map((item) => ({
        ...simple(item),
        from: { table: item.from.table, column: item.from.column },
        to: { table: item.to.table, column: item.to.column },
      })),
    metrics: document.metrics
      .filter(
        (item) =>
          item.sensitivity === "normal" &&
          has(item.field.table, item.field.column, item.field.type),
      )
      .map((item) => ({
        ...simple(item),
        field: { table: item.field.table, column: item.field.column },
        aggregation: item.aggregation,
      })),
  };
  if (!filtered.tables.length) throw new Error("NO_MODEL_FIELDS");
  if (Buffer.byteLength(JSON.stringify(semantics)) > 32 * 1024)
    throw new Error("SEMANTICS_TOO_LARGE");
  return { schema: filtered, semantics };
}
