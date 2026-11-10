import type { Storage } from "../storage.js"
import type { SchemaRead } from "../../src/shared/datasource-metadata.js"
import type { CompiledQuery, Datasource, QueryRow } from "./contracts.js"
import { describeMysql, executeMysql } from "./mysql.js"
import { describePostgres, executePostgres } from "./postgresql.js"
import { describeSqlite, executeSqlite } from "./sqlite.js"

export function describeSource(source: Datasource, storage: Storage, detailed = true): Promise<SchemaRead> {
    switch (source.engine) {
        case "sqlite":
            return describeSqlite(source.config.path, storage, detailed)
        case "postgresql":
            return describePostgres(source, detailed)
        case "mysql":
            return describeMysql(source, detailed)
    }
}

export function executeSource(source: Datasource, query: CompiledQuery, storage: Storage): Promise<QueryRow[]> {
    switch (source.engine) {
        case "sqlite":
            return executeSqlite(source.config.path, query, storage)
        case "postgresql":
            return executePostgres(source, query)
        case "mysql":
            return executeMysql(source, query)
    }
}
