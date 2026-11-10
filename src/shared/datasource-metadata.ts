import { z } from "zod"

const identifier = z.string().min(1).max(255)
const description = z.string().trim().max(1500)
const columnNoteSchema = z.object({ name: identifier, description }).strict()
const tableNoteSchema = z.object({ name: identifier, description, columns: z.array(columnNoteSchema).max(2000) }).strict()
const relationSchema = z
    .object({
        id: z.uuid(),
        fromTable: identifier,
        toTable: identifier,
        mappings: z
            .array(z.object({ from: identifier, to: identifier }).strict())
            .min(1)
            .max(20),
        description,
    })
    .strict()
const scopeTableSchema = z.object({ name: identifier, columns: z.array(identifier).max(2000) }).strict()

export const datasourcePreferencesSchema = z
    .object({
        revision: z.number().int().min(0),
        tables: z.array(tableNoteSchema).max(500),
        relations: z.array(relationSchema).max(500),
        aiScope: z.object({ mode: z.enum(["all", "selected"]), tables: z.array(scopeTableSchema).max(500) }).strict(),
    })
    .strict()
    .superRefine((value, context) => {
        const checkUnique = (items: string[], path: (string | number)[]) => {
            if (new Set(items).size !== items.length) context.addIssue({ code: "custom", path, message: "存在重复项目。" })
        }
        checkUnique(
            value.tables.map((table) => table.name),
            ["tables"],
        )
        checkUnique(
            value.relations.map((relation) => relation.id),
            ["relations"],
        )
        checkUnique(
            value.aiScope.tables.map((table) => table.name),
            ["aiScope", "tables"],
        )
        value.tables.forEach((table, index) =>
            checkUnique(
                table.columns.map((column) => column.name),
                ["tables", index, "columns"],
            ),
        )
        value.aiScope.tables.forEach((table, index) => checkUnique(table.columns, ["aiScope", "tables", index, "columns"]))
        value.relations.forEach((relation, index) => {
            checkUnique(
                relation.mappings.map((mapping) => mapping.from),
                ["relations", index, "mappings"],
            )
            checkUnique(
                relation.mappings.map((mapping) => mapping.to),
                ["relations", index, "mappings"],
            )
        })
    })

export type DatasourcePreferences = z.infer<typeof datasourcePreferencesSchema>
export type DatasourceRelation = {
    name: string | null
    fromTable: string
    toSchema: string | null
    toTable: string
    sameDatasource: boolean
    mappings: { from: string; to: string | null }[]
    source: "database"
}
export type DatasourceColumn = {
    name: string
    type: string
    nullable?: boolean | null
    primaryKeyPosition?: number | null
    comment?: string | null
    description?: string
}
export type DatasourceTable = {
    name: string
    kind?: "table" | "view" | "unknown"
    comment?: string | null
    description?: string
    columns: DatasourceColumn[]
    relations?: DatasourceRelation[]
}
export type MetadataWarning = { code: string; message: string }
export type DatasourceSchema = { tables: DatasourceTable[]; warnings: MetadataWarning[]; preferences: DatasourcePreferences }
export type SchemaRead = { tables: DatasourceTable[]; warnings: MetadataWarning[] }

export function emptyDatasourcePreferences(): DatasourcePreferences {
    return { revision: 0, tables: [], relations: [], aiScope: { mode: "all", tables: [] } }
}
