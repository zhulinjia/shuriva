import Database from "better-sqlite3"
import { parentPort, workerData } from "node:worker_threads"
import type { DatasourceRelation, SchemaRead } from "../src/shared/datasource-metadata.js"
import { addWarning, MAX_COLUMNS, MAX_KEYS, MAX_TABLES } from "./datasources/metadata.js"
import type { SqliteJob } from "./datasources/sqlite.js"

const job = workerData as SqliteJob
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
type SqliteTable = { name: string; type: "table" | "view" }
type SqliteColumn = { name: string; type: string; hidden: number; notnull: number; pk: number }
type SqliteForeignKey = { id: number; seq: number; table: string; from: string; to: string | null }

function readSchema(db: Database.Database, detailed: boolean): SchemaRead {
    const entries = db
        .prepare(
            "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 501",
        )
        .all() as SqliteTable[]
    const schema: SchemaRead = { tables: [], warnings: [] }
    if (entries.length > MAX_TABLES) addWarning(schema.warnings, "tables_truncated", `表和视图超过 ${MAX_TABLES} 个，只显示部分结构。`)
    let columnCount = 0
    for (const entry of entries.slice(0, MAX_TABLES)) {
        const columns = (db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(entry.name)})`).all() as SqliteColumn[]).filter(
            (column) => column.hidden !== 1,
        )
        const remaining = Math.max(0, MAX_COLUMNS - columnCount)
        if (columns.length > remaining) addWarning(schema.warnings, "columns_truncated", `字段超过 ${MAX_COLUMNS} 个，只显示部分结构。`)
        columnCount += columns.length
        schema.tables.push({
            name: entry.name,
            kind: entry.type,
            columns: columns.slice(0, remaining).map((column) => ({
                name: column.name,
                type: column.type,
                ...(detailed ? { nullable: column.notnull ? false : column.pk ? null : true, primaryKeyPosition: column.pk || null } : {}),
            })),
            relations: [],
        })
        if (columnCount > MAX_COLUMNS) break
    }
    if (!detailed) return schema
    if (schema.warnings.some((warning) => warning.code.endsWith("_truncated"))) {
        addWarning(schema.warnings, "keys_unavailable", "结构不完整，未展示数据库关系。")
        return schema
    }
    let keyCount = 0
    for (const table of schema.tables) {
        const rows = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`).all() as SqliteForeignKey[]
        keyCount += rows.length
        if (keyCount > MAX_KEYS) {
            schema.tables.forEach((item) => {
                item.relations = []
            })
            addWarning(schema.warnings, "keys_truncated", `关系字段超过 ${MAX_KEYS} 项，未展示数据库关系。`)
            break
        }
        const groups = new Map<number, SqliteForeignKey[]>()
        for (const row of rows) {
            const group = groups.get(row.id) ?? []
            group.push(row)
            groups.set(row.id, group)
        }
        for (const group of groups.values()) {
            group.sort((a, b) => a.seq - b.seq)
            const target = schema.tables.find((item) => item.name === group[0]!.table)
            const primaryKey = target?.columns
                .filter((column) => column.primaryKeyPosition)
                .sort((a, b) => a.primaryKeyPosition! - b.primaryKeyPosition!)
            const relation: DatasourceRelation = {
                name: null,
                fromTable: table.name,
                toSchema: null,
                toTable: group[0]!.table,
                sameDatasource: true,
                mappings: group.map((row) => ({
                    from: row.from,
                    to: row.to ?? (primaryKey?.length === group.length ? primaryKey[row.seq]?.name : null) ?? null,
                })),
                source: "database",
            }
            if (relation.mappings.some((mapping) => mapping.to === null)) {
                addWarning(schema.warnings, "relations_incomplete", "部分数据库关系的目标字段无法读取，这些关系不会提供给 AI。")
            }
            table.relations?.push(relation)
        }
    }
    return schema
}

try {
    const db = new Database(job.path, { readonly: true, fileMustExist: true, timeout: 5000 })
    try {
        if (job.operation === "schema") parentPort?.postMessage({ result: readSchema(db, job.detailed) })
        else parentPort?.postMessage({ result: db.prepare(job.sql).all(...job.parameters) })
    } finally {
        db.close()
    }
} catch {
    parentPort?.postMessage({ error: true })
}
