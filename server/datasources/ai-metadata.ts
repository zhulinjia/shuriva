import type { DatasourcePreferences, DatasourceTable, SchemaRead } from "../../src/shared/datasource-metadata.js"
import { relationExists } from "./metadata-store.js"

/** Limit the model context on the server, including relation endpoints and their fields. */
export function buildAiMetadata(schema: SchemaRead, preferences: DatasourcePreferences) {
    const selection = new Map(preferences.aiScope.tables.map((table) => [table.name, new Set(table.columns)]))
    const notes = new Map(preferences.tables.map((table) => [table.name, table]))
    const tables = schema.tables.flatMap((table) => {
        const allowed = preferences.aiScope.mode === "all" ? null : selection.get(table.name)
        if (allowed === undefined) return []
        const note = notes.get(table.name)
        const columnNotes = new Map(note?.columns.map((column) => [column.name, column.description]) ?? [])
        const columns = table.columns
            .filter((column) => allowed === null || allowed.has(column.name))
            .map((column) => {
                const description = columnNotes.get(column.name) || column.comment || undefined
                return {
                    name: column.name,
                    type: column.type,
                    ...(column.nullable === undefined ? {} : { nullable: column.nullable }),
                    ...(column.primaryKeyPosition ? { primaryKeyPosition: column.primaryKeyPosition } : {}),
                    ...(description ? { description } : {}),
                }
            })
        if (!columns.length) return []
        const description = note?.description || table.comment || undefined
        return [{ name: table.name, kind: table.kind, ...(description ? { description } : {}), columns }]
    })
    const allowedTables = new Map(tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]))
    const accessible = (fromTable: string, toTable: string, mappings: { from: string; to: string | null }[]) => {
        const from = allowedTables.get(fromTable)
        const to = allowedTables.get(toTable)
        return Boolean(from && to && mappings.every((mapping) => mapping.to !== null && from.has(mapping.from) && to.has(mapping.to)))
    }
    const relations: {
        fromTable: string
        toTable: string
        mappings: { from: string; to: string | null }[]
        source: "database" | "user"
        description?: string
    }[] = schema.tables.flatMap((table) =>
        (table.relations ?? [])
            .filter((relation) => relation.sameDatasource && accessible(relation.fromTable, relation.toTable, relation.mappings))
            .map((relation) => ({
                fromTable: relation.fromTable,
                toTable: relation.toTable,
                mappings: relation.mappings,
                source: "database" as const,
            })),
    )
    for (const relation of preferences.relations) {
        if (relationExists(relation, schema.tables) && accessible(relation.fromTable, relation.toTable, relation.mappings)) {
            relations.push({
                fromTable: relation.fromTable,
                toTable: relation.toTable,
                mappings: relation.mappings,
                source: "user",
                ...(relation.description ? { description: relation.description } : {}),
            })
        }
    }
    return { tables: tables satisfies DatasourceTable[], relations }
}
