import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2"
import type { SchemaRead } from "../../src/shared/datasource-metadata.js"
import type { CompiledQuery, Datasource, QueryRow } from "./contracts.js"
import { addWarning, applyKeys, groupColumns } from "./metadata.js"
import type { ColumnRow, KeyRow } from "./metadata.js"

type MysqlDatasource = Extract<Datasource, { engine: "mysql" }>

async function withReadOnlyConnection<T>(source: MysqlDatasource, operation: (connection: mysql.Connection) => Promise<T>): Promise<T> {
    const { host, port, database, user, password, ssl } = source.config
    const connection = await mysql.createConnection({
        host,
        port,
        database,
        user,
        password,
        ssl: ssl ? { rejectUnauthorized: true } : undefined,
        connectTimeout: 5000,
        multipleStatements: false,
    })
    try {
        await connection.query("START TRANSACTION READ ONLY")
        try {
            return await operation(connection)
        } finally {
            await connection.rollback()
        }
    } finally {
        await connection.end()
    }
}

export function describeMysql(source: MysqlDatasource, detailed = true): Promise<SchemaRead> {
    return withReadOnlyConnection(source, async (connection) => {
        const basic = async () => {
            const [rows] = await connection.execute<(ColumnRow & RowDataPacket)[]>(
                {
                    sql: `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type FROM information_schema.columns
          WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 10001`,
                    timeout: 7000,
                },
                [source.config.database],
            )
            return groupColumns(rows)
        }
        if (!detailed) return basic()
        await connection.query("SAVEPOINT metadata_details")
        try {
            const [columns] = await connection.execute<(ColumnRow & RowDataPacket)[]>(
                {
                    sql: `SELECT c.table_name AS table_name, c.column_name AS column_name, c.data_type AS data_type,
          c.is_nullable AS is_nullable, t.table_type AS table_type,
          CASE WHEN t.table_type = 'VIEW' THEN NULL ELSE LEFT(t.table_comment, 1501) END AS table_comment,
          LEFT(c.column_comment, 1501) AS column_comment
          FROM information_schema.columns c
          LEFT JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = ? ORDER BY c.table_name, c.ordinal_position LIMIT 10001`,
                    timeout: 7000,
                },
                [source.config.database],
            )
            const [keys] = await connection.execute<(KeyRow & RowDataPacket)[]>(
                {
                    sql: `SELECT table_name AS table_name, column_name AS column_name, constraint_name AS constraint_name,
          CASE WHEN constraint_name = 'PRIMARY' THEN 'PRIMARY KEY' ELSE 'FOREIGN KEY' END AS constraint_type,
          ordinal_position AS ordinal_position, referenced_table_schema AS referenced_table_schema,
          referenced_table_name AS referenced_table_name, referenced_column_name AS referenced_column_name
          FROM information_schema.key_column_usage
          WHERE table_schema = ? AND (constraint_name = 'PRIMARY' OR referenced_table_name IS NOT NULL)
          ORDER BY table_name, constraint_name, ordinal_position LIMIT 10001`,
                    timeout: 7000,
                },
                [source.config.database],
            )
            const schema = groupColumns(columns)
            applyKeys(schema, keys, source.config.database)
            return schema
        } catch {
            await connection.query("ROLLBACK TO SAVEPOINT metadata_details")
            const schema = await basic()
            addWarning(schema.warnings, "details_unavailable", "无法读取完整的主键、关系或数据库注释，仅显示基础字段。")
            return schema
        }
    })
}

export function executeMysql(source: MysqlDatasource, query: CompiledQuery): Promise<QueryRow[]> {
    return withReadOnlyConnection(source, async (connection) => {
        const [rows] = await connection.execute<RowDataPacket[]>({ sql: query.sql, timeout: 7000 }, query.parameters)
        return rows
    })
}
