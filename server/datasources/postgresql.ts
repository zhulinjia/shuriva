import { Client } from "pg"
import type { SchemaRead } from "../../src/shared/datasource-metadata.js"
import type { CompiledQuery, Datasource, QueryRow } from "./contracts.js"
import { addWarning, applyKeys, groupColumns } from "./metadata.js"
import type { ColumnRow, KeyRow } from "./metadata.js"

type PostgresDatasource = Extract<Datasource, { engine: "postgresql" }>

async function withReadOnlyConnection<T>(source: PostgresDatasource, operation: (client: Client) => Promise<T>): Promise<T> {
    const { host, port, database, user, password, ssl } = source.config
    const client = new Client({
        host,
        port,
        database,
        user,
        password,
        ssl: ssl ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 7000,
    })
    await client.connect()
    try {
        await client.query("BEGIN READ ONLY")
        try {
            return await operation(client)
        } finally {
            await client.query("ROLLBACK")
        }
    } finally {
        await client.end()
    }
}

export function describePostgres(source: PostgresDatasource, detailed = true): Promise<SchemaRead> {
    return withReadOnlyConnection(source, async (client) => {
        const basic = async () =>
            groupColumns(
                (
                    await client.query<ColumnRow>(
                        `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 ORDER BY table_name, ordinal_position LIMIT 10001`,
                        [source.config.schema],
                    )
                ).rows,
            )
        if (!detailed) return basic()
        await client.query("SAVEPOINT metadata_details")
        try {
            const columns = await client.query<ColumnRow>(
                `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, t.table_type,
          LEFT(pg_catalog.obj_description(pc.oid, 'pg_class'), 1501) AS table_comment,
          LEFT(pg_catalog.col_description(pc.oid, pa.attnum), 1501) AS column_comment
         FROM information_schema.columns c
         LEFT JOIN information_schema.tables t ON t.table_catalog = c.table_catalog AND t.table_schema = c.table_schema AND t.table_name = c.table_name
         LEFT JOIN pg_catalog.pg_namespace pn ON pn.nspname = c.table_schema
         LEFT JOIN pg_catalog.pg_class pc ON pc.relnamespace = pn.oid AND pc.relname = c.table_name
         LEFT JOIN pg_catalog.pg_attribute pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name AND pa.attnum > 0
         WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position LIMIT 10001`,
                [source.config.schema],
            )
            const keys = await client.query<KeyRow>(
                `WITH visible AS (
          SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema = $1
         )
         SELECT source.relname AS table_name, source_visible.column_name AS column_name, con.conname AS constraint_name,
          CASE WHEN con.contype = 'p' THEN 'PRIMARY KEY' ELSE 'FOREIGN KEY' END AS constraint_type,
          key_part.ordinality AS ordinal_position,
          CASE WHEN target_visible.column_name IS NOT NULL THEN target_ns.nspname END AS referenced_table_schema,
          CASE WHEN target_visible.column_name IS NOT NULL THEN target.relname END AS referenced_table_name,
          target_visible.column_name AS referenced_column_name
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class source ON source.oid = con.conrelid
         JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
         JOIN (SELECT DISTINCT table_schema, table_name FROM visible) visible_table
           ON visible_table.table_schema = source_ns.nspname AND visible_table.table_name = source.relname
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_part(attnum, ordinality) ON true
         JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid = source.oid AND source_column.attnum = key_part.attnum
         LEFT JOIN visible source_visible ON source_visible.table_schema = source_ns.nspname
           AND source_visible.table_name = source.relname AND source_visible.column_name = source_column.attname
         LEFT JOIN pg_catalog.pg_class target ON target.oid = con.confrelid
         LEFT JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
         LEFT JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid = target.oid
           AND target_column.attnum = con.confkey[key_part.ordinality::integer]
         LEFT JOIN visible target_visible ON target_visible.table_schema = target_ns.nspname
           AND target_visible.table_name = target.relname AND target_visible.column_name = target_column.attname
         WHERE source_ns.nspname = $1 AND con.contype IN ('p', 'f')
         ORDER BY source.relname, con.conname, key_part.ordinality LIMIT 10001`,
                [source.config.schema],
            )
            const schema = groupColumns(columns.rows)
            applyKeys(schema, keys.rows, source.config.schema)
            return schema
        } catch {
            await client.query("ROLLBACK TO SAVEPOINT metadata_details")
            const schema = await basic()
            addWarning(schema.warnings, "details_unavailable", "无法读取完整的主键、关系或数据库注释，仅显示基础字段。")
            return schema
        }
    })
}

export function executePostgres(source: PostgresDatasource, query: CompiledQuery): Promise<QueryRow[]> {
    return withReadOnlyConnection(source, async (client) => {
        const result = await client.query<QueryRow>(query.sql, query.parameters)
        return result.rows
    })
}
