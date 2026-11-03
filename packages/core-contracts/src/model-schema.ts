export type AuthorizedSchema = ReadonlyMap<string, ReadonlySet<string>>;

export type ModelSchema = {
  database: string;
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
};

const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const allowedTypes = new Set([
  "bigint",
  "binary",
  "bit",
  "blob",
  "boolean",
  "char",
  "date",
  "datetime",
  "decimal",
  "double",
  "enum",
  "float",
  "geometry",
  "geometrycollection",
  "int",
  "integer",
  "json",
  "linestring",
  "longblob",
  "longtext",
  "mediumblob",
  "mediumint",
  "mediumtext",
  "multilinestring",
  "multipoint",
  "multipolygon",
  "numeric",
  "point",
  "polygon",
  "set",
  "smallint",
  "text",
  "time",
  "timestamp",
  "tinyblob",
  "tinyint",
  "tinytext",
  "varbinary",
  "varchar",
  "year",
]);

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** A schema is accepted only after authenticating the originating Connector and task. */
export function decodeModelSchema(value: unknown): {
  schema: ModelSchema;
  scope: AuthorizedSchema;
  versions: ReadonlyMap<string, string>;
  structures: ReadonlyMap<string, string>;
} {
  return decode(value, true);
}

/** Validate the stripped model-facing schema without accepting Connector metadata. */
export function decodeModelDisclosure(value: unknown): {
  schema: ModelSchema;
  scope: AuthorizedSchema;
} {
  const { schema, scope } = decode(value, false);
  return { schema, scope };
}

function decode(
  value: unknown,
  attested: boolean,
): {
  schema: ModelSchema;
  scope: AuthorizedSchema;
  versions: ReadonlyMap<string, string>;
  structures: ReadonlyMap<string, string>;
} {
  if (
    !exact(value, ["database", "tables"]) ||
    typeof value.database !== "string" ||
    !identifier.test(value.database) ||
    !Array.isArray(value.tables) ||
    value.tables.length < 1 ||
    value.tables.length > 256
  )
    throw new Error("INVALID_SCHEMA");
  const schema: ModelSchema = { database: value.database, tables: [] };
  const scope = new Map<string, Set<string>>();
  const versions = new Map<string, string>();
  const structures = new Map<string, string>();
  let count = 0;
  for (const table of value.tables as unknown[]) {
    if (
      !exact(
        table,
        attested ? ["name", "columns", "version", "structureHash"] : ["name", "columns"],
      ) ||
      typeof table.name !== "string" ||
      !identifier.test(table.name) ||
      scope.has(table.name) ||
      (attested && (typeof table.version !== "string" || !/^[0-9a-f]{64}$/.test(table.version))) ||
      (attested &&
        (typeof table.structureHash !== "string" || !/^[0-9a-f]{64}$/.test(table.structureHash))) ||
      !Array.isArray(table.columns) ||
      table.columns.length < 1 ||
      table.columns.length > 256
    )
      throw new Error("INVALID_SCHEMA");
    const columns: ModelSchema["tables"][number]["columns"] = [];
    const names = new Set<string>();
    for (const col of table.columns as unknown[]) {
      if (
        !exact(col, ["name", "type"]) ||
        typeof col.name !== "string" ||
        !identifier.test(col.name) ||
        names.has(col.name) ||
        typeof col.type !== "string" ||
        !allowedTypes.has(col.type) ||
        ++count > 4096
      )
        throw new Error("INVALID_SCHEMA");
      names.add(col.name);
      columns.push({ name: col.name, type: col.type });
    }
    scope.set(table.name, names);
    if (attested && typeof table.version === "string") versions.set(table.name, table.version);
    if (attested && typeof table.structureHash === "string")
      structures.set(table.name, table.structureHash);
    schema.tables.push({ name: table.name, columns });
  }
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 96 * 1024)
    throw new Error("INVALID_SCHEMA");
  return { schema, scope, versions, structures };
}
