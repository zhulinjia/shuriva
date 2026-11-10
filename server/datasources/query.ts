import { querySchema } from "../../src/shared/workspace-schema.js"
import type { WorkspaceQuery } from "../../src/shared/workspace-schema.js"
import type { CompiledQuery, Datasource, DatasourceEngine, QueryParameter, TableInfo } from "./contracts.js"

function quoteIdentifier(value: string, engine: DatasourceEngine): string {
  const delimiter = engine === "mysql" ? "`" : '"'
  return delimiter + value.replaceAll(delimiter, delimiter + delimiter) + delimiter
}

/**
 * Only schema-derived identifiers and the supported query grammar reach SQL.
 * Values use driver parameters; numeric limits are revalidated here so this
 * boundary remains safe when called outside an HTTP route.
 */
export function compileQuery(
  source: Datasource,
  input: WorkspaceQuery,
  tables: readonly TableInfo[],
): CompiledQuery {
  const query = querySchema.parse(input)
  if (query.datasourceId !== source.id) throw new Error("Datasource mismatch")
  const table = validateQueryIdentifiers(query, tables)

  const parameters: QueryParameter[] = []
  const addParameter = (value: QueryParameter): string => {
    parameters.push(value)
    return source.engine === "postgresql" ? `$${parameters.length}` : "?"
  }
  const where = query.filters.map((filter) => {
    const field = quoteIdentifier(filter.field, source.engine)
    if (filter.value === null) {
      if (filter.operator === "eq") return `${field} IS NULL`
      if (filter.operator === "ne") return `${field} IS NOT NULL`
      throw new Error("Invalid null comparison")
    }
    if (filter.operator === "contains") {
      if (typeof filter.value !== "string") throw new Error("Contains requires text")
      const value = filter.value.replace(/[!%_]/g, "!$&")
      const textField = source.engine === "mysql" ? `CAST(${field} AS CHAR)` : `CAST(${field} AS TEXT)`
      return `${textField} LIKE ${addParameter(`%${value}%`)} ESCAPE '!'`
    }
    const operators = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }
    return `${field} ${operators[filter.operator]} ${addParameter(filter.value)}`
  })

  const selected = query.fields.map((field) => quoteIdentifier(field, source.engine)).join(", ")
  const tableName = source.engine === "postgresql"
    ? `${quoteIdentifier(source.config.schema, source.engine)}.${quoteIdentifier(table.name, source.engine)}`
    : quoteIdentifier(table.name, source.engine)
  const order = query.orderBy
    ? ` ORDER BY ${quoteIdentifier(query.orderBy.field, source.engine)} ${query.orderBy.direction.toUpperCase()}`
    : ""
  const hint = source.engine === "mysql" ? " /*+ MAX_EXECUTION_TIME(5000) */" : ""
  const conditions = where.length ? ` WHERE ${where.join(" AND ")}` : ""
  const sql = `SELECT${hint} ${selected} FROM ${tableName}${conditions}${order} LIMIT ${query.limit} OFFSET ${query.offset}`
  return { sql, parameters }
}

export function validateQueryIdentifiers(query: WorkspaceQuery, tables: readonly TableInfo[]): TableInfo {
  const table = tables.find((item) => item.name === query.table)
  if (!table) throw new Error("Unknown table")
  const columns = new Set(table.columns.map((column) => column.name))
  const referencedFields = [
    ...query.fields,
    ...query.filters.map((filter) => filter.field),
    ...(query.orderBy ? [query.orderBy.field] : []),
  ]
  if (referencedFields.some((field) => !columns.has(field))) throw new Error("Unknown field")
  if (new Set(query.fields).size !== query.fields.length) throw new Error("Duplicate fields")
  return table
}
