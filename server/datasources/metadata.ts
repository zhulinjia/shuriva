import type { DatasourceRelation, DatasourceTable, MetadataWarning, SchemaRead } from "../../src/shared/datasource-metadata.js"

export const MAX_TABLES = 500
export const MAX_COLUMNS = 10_000
export const MAX_KEYS = 10_000
const MAX_COMMENT_LENGTH = 1500

export type ColumnRow = {
    table_name: string
    column_name: string
    data_type: string
    is_nullable?: string | null
    table_type?: string | null
    table_comment?: string | null
    column_comment?: string | null
}
export type KeyRow = {
    table_name: string
    column_name: string | null
    constraint_name: string
    constraint_type: "PRIMARY KEY" | "FOREIGN KEY"
    ordinal_position: number | string
    referenced_table_schema: string | null
    referenced_table_name: string | null
    referenced_column_name: string | null
}

export function addWarning(warnings: MetadataWarning[], code: string, message: string): void {
    if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message })
}

export function groupColumns(rows: readonly ColumnRow[]): SchemaRead {
    const warnings: MetadataWarning[] = []
    if (rows.length > MAX_COLUMNS) addWarning(warnings, "columns_truncated", `字段超过 ${MAX_COLUMNS} 个，只显示部分结构。`)
    const tables = new Map<string, DatasourceTable>()
    const safeComment = (value: string | null | undefined) => {
        if (!value) return null
        if (value.length <= MAX_COMMENT_LENGTH) return value
        addWarning(warnings, "comments_omitted", "部分数据库注释过长，未读取这些注释。")
        return null
    }
    for (const row of rows.slice(0, MAX_COLUMNS)) {
        let table = tables.get(row.table_name)
        if (!table) {
            if (tables.size >= MAX_TABLES) {
                addWarning(warnings, "tables_truncated", `表和视图超过 ${MAX_TABLES} 个，只显示部分结构。`)
                break
            }
            const kind = row.table_type?.toUpperCase().includes("VIEW") ? "view" : row.table_type ? "table" : "unknown"
            table = { name: row.table_name, kind, comment: safeComment(row.table_comment), columns: [], relations: [] }
            tables.set(row.table_name, table)
        }
        table.columns.push({
            name: row.column_name,
            type: row.data_type,
            ...(row.is_nullable == null ? {} : { nullable: row.is_nullable === "YES" }),
            comment: safeComment(row.column_comment),
        })
    }
    return { tables: [...tables.values()], warnings }
}

/** Keep composite keys together; never report a partially truncated key as complete. */
export function applyKeys(schema: SchemaRead, rows: readonly KeyRow[], currentSchema: string): void {
    if (schema.warnings.some((warning) => warning.code === "tables_truncated" || warning.code === "columns_truncated")) {
        addWarning(schema.warnings, "keys_unavailable", "结构不完整，未展示主键及关系。")
        return
    }
    if (rows.length > MAX_KEYS) {
        addWarning(schema.warnings, "keys_truncated", `主键和关联信息超过 ${MAX_KEYS} 项，未展示键及关系。`)
        return
    }
    const tables = new Map(schema.tables.map((table) => [table.name, table]))
    const groups = new Map<string, KeyRow[]>()
    for (const row of rows) {
        const key = JSON.stringify([row.table_name, row.constraint_name, row.constraint_type])
        const group = groups.get(key) ?? []
        group.push(row)
        groups.set(key, group)
    }
    for (const group of groups.values()) {
        const first = group[0]!
        const table = tables.get(first.table_name)
        const positions = group.map((row) => Number(row.ordinal_position))
        if (first.constraint_type === "PRIMARY KEY") {
            if (!table || group.some((row) => !table.columns.some((column) => column.name === row.column_name))) {
                addWarning(schema.warnings, "keys_incomplete", "部分主键字段不可见，未展示这些主键。")
                continue
            }
            for (const row of group) {
                const column = table.columns.find((item) => item.name === row.column_name)!
                column.primaryKeyPosition = Number(row.ordinal_position)
            }
            continue
        }
        if (first.referenced_table_schema && first.referenced_table_schema !== currentSchema) {
            addWarning(schema.warnings, "relations_outside_scope", "部分数据库关系的目标不在当前数据源范围内，未展示这些关系。")
            continue
        }
        const target = tables.get(first.referenced_table_name ?? "")
        if (
            !table ||
            !target ||
            !first.referenced_table_name ||
            new Set(positions).size !== positions.length ||
            group.some(
                (row) =>
                    !row.referenced_table_name ||
                    !row.referenced_column_name ||
                    row.referenced_table_name !== first.referenced_table_name ||
                    row.referenced_table_schema !== first.referenced_table_schema ||
                    !table.columns.some((column) => column.name === row.column_name) ||
                    !target.columns.some((column) => column.name === row.referenced_column_name),
            )
        ) {
            addWarning(schema.warnings, "relations_incomplete", "部分数据库关系无法完整读取，未展示这些关系。")
            continue
        }
        const relation: DatasourceRelation = {
            name: first.constraint_name,
            fromTable: first.table_name,
            toSchema: first.referenced_table_schema,
            toTable: first.referenced_table_name,
            sameDatasource: first.referenced_table_schema === currentSchema,
            mappings: group
                .sort((a, b) => Number(a.ordinal_position) - Number(b.ordinal_position))
                .map((row) => ({ from: row.column_name!, to: row.referenced_column_name })),
            source: "database",
        }
        table.relations?.push(relation)
    }
}
