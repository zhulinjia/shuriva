import { DataSourceError } from "./errors.js";

export type DataSourceSnapshot = {
  database: string;
  serverVersion: string;
  tables: Array<{ name: string; kind: "BASE TABLE" | "VIEW" }>;
  columns: Array<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    position: number;
  }>;
  relations: Array<{
    table: string;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    constraint: string;
    position: number;
  }>;
  externalRelationsOmitted: number;
};

type ObjectValue = Record<string, unknown>;
function record(value: unknown, fields: string[]): value is ObjectValue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= limit &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
  );
}
function boundedArray(value: unknown, limit: number): value is unknown[] {
  return Array.isArray(value) && value.length <= limit;
}

/** Strictly limits a connector result before it enters the platform database. */
export function decodeSnapshot(payload: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || payload.length > 1_398_102)
    throw new DataSourceError("INVALID");
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.length > 1_048_576 || bytes.toString("base64url") !== payload)
    throw new DataSourceError("INVALID");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DataSourceError("INVALID");
  }
  validateSnapshot(value);
  return value;
}

/** Enforce the same constraints for every snapshot persistence caller. */
export function validateSnapshot(value: unknown): asserts value is DataSourceSnapshot {
  if (
    !record(value, [
      "database",
      "serverVersion",
      "tables",
      "columns",
      "relations",
      "externalRelationsOmitted",
    ]) ||
    !text(value.database, 256) ||
    !text(value.serverVersion, 128) ||
    !boundedArray(value.tables, 256) ||
    !boundedArray(value.columns, 4096) ||
    !boundedArray(value.relations, 2048) ||
    !Number.isSafeInteger(value.externalRelationsOmitted) ||
    Number(value.externalRelationsOmitted) < 0 ||
    Number(value.externalRelationsOmitted) > 2048
  )
    throw new DataSourceError("INVALID");
  const tables = new Set<string>();
  for (const table of value.tables) {
    if (
      !record(table, ["name", "kind"]) ||
      !text(table.name, 256) ||
      (table.kind !== "BASE TABLE" && table.kind !== "VIEW") ||
      tables.has(table.name)
    )
      throw new DataSourceError("INVALID");
    tables.add(table.name);
  }
  const columns = new Set<string>();
  for (const column of value.columns) {
    if (
      !record(column, ["table", "name", "type", "nullable", "position"]) ||
      !text(column.table, 256) ||
      !tables.has(column.table) ||
      !text(column.name, 256) ||
      !text(column.type, 2048) ||
      typeof column.nullable !== "boolean" ||
      !Number.isSafeInteger(column.position) ||
      Number(column.position) < 1 ||
      Number(column.position) > 4096
    )
      throw new DataSourceError("INVALID");
    const key = JSON.stringify([column.table, column.name]);
    if (columns.has(key)) throw new DataSourceError("INVALID");
    columns.add(key);
  }
  for (const relation of value.relations) {
    if (
      !record(relation, [
        "table",
        "column",
        "referencedTable",
        "referencedColumn",
        "constraint",
        "position",
      ]) ||
      !text(relation.table, 256) ||
      !text(relation.column, 256) ||
      !text(relation.referencedTable, 256) ||
      !text(relation.referencedColumn, 256) ||
      !text(relation.constraint, 256) ||
      !Number.isSafeInteger(relation.position) ||
      Number(relation.position) < 1 ||
      Number(relation.position) > 2048 ||
      !columns.has(JSON.stringify([relation.table, relation.column])) ||
      !columns.has(JSON.stringify([relation.referencedTable, relation.referencedColumn]))
    )
      throw new DataSourceError("INVALID");
  }
}
