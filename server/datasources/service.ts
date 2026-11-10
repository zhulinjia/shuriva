import { randomUUID } from "node:crypto"
import type { DatasourcePreferences, DatasourceSchema } from "../../src/shared/datasource-metadata.js"
import type { WorkspaceQuery } from "../../src/shared/workspace-schema.js"
import { ServiceError } from "../errors.js"
import type { Storage } from "../storage.js"
import { workspaceUsesDatasource } from "../workspaces/store.js"
import { describeSource, executeSource } from "./adapter.js"
import { datasourceInputSchema } from "./contracts.js"
import type { Datasource, DatasourceInput, QueryRow } from "./contracts.js"
import { readDatasourcePreferences, saveDatasourcePreferences } from "./metadata-store.js"
import { compileQuery } from "./query.js"

type DatasourceRow = {
    id: string
    name: string
    engine: string
    encrypted_config: string
}

export type PublicDatasource = {
    id: string
    name: string
    engine: Datasource["engine"]
}

export function createDatasourceService(storage: Storage) {
    const load = (id: string): Datasource | null => {
        const row = storage.db.prepare("SELECT id, name, engine, encrypted_config FROM datasources WHERE id = ?").get(id) as
            | DatasourceRow
            | undefined
        if (!row) return null

        const input = datasourceInputSchema.parse({
            name: row.name,
            engine: row.engine,
            config: storage.open(row.encrypted_config),
        })
        return { ...input, id: row.id }
    }

    const requireSource = (id: string): Datasource => {
        const source = load(id)
        if (!source) throw new ServiceError("not_found", "Datasource not found")
        return source
    }

    const list = () =>
        storage.db
            .prepare("SELECT id, name, engine, created_at AS createdAt FROM datasources ORDER BY created_at DESC")
            .all() as (PublicDatasource & { createdAt: string })[]

    const getPublic = (id: string): PublicDatasource | null => {
        const source = load(id)
        return source ? { id: source.id, name: source.name, engine: source.engine } : null
    }

    const create = async (input: DatasourceInput): Promise<PublicDatasource> => {
        const source = { ...input, id: randomUUID() }
        try {
            await describeSource(source, storage, false)
        } catch {
            throw new ServiceError("invalid_input", "Could not read datasource schema. Verify its connection and read permissions.")
        }
        storage.db
            .prepare("INSERT INTO datasources(id, name, engine, encrypted_config, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(source.id, source.name, source.engine, storage.seal(source.config), new Date().toISOString())
        return { id: source.id, name: source.name, engine: source.engine }
    }

    const describe = async (id: string): Promise<DatasourceSchema> => {
        const source = requireSource(id)
        try {
            const schema = await describeSource(source, storage)
            return { ...schema, preferences: readDatasourcePreferences(storage, id) }
        } catch {
            throw new ServiceError("unavailable", "Datasource unavailable")
        }
    }

    const updateMetadata = async (id: string, preferences: DatasourcePreferences): Promise<DatasourcePreferences> => {
        const source = requireSource(id)
        let schema
        try {
            schema = await describeSource(source, storage)
        } catch {
            throw new ServiceError("unavailable", "无法读取数据源结构，请检查连接后重试。")
        }
        return saveDatasourcePreferences(storage, id, preferences, schema.tables)
    }

    const execute = async (query: WorkspaceQuery): Promise<QueryRow[]> => {
        const source = requireSource(query.datasourceId)
        try {
            const schema = await describeSource(source, storage, false)
            const compiled = compileQuery(source, query, schema.tables)
            return await executeSource(source, compiled, storage)
        } catch {
            throw new ServiceError("unavailable", "Query failed. Check datasource access and workspace configuration.")
        }
    }

    const remove = (id: string): void => {
        storage.db
            .transaction(() => {
                if (workspaceUsesDatasource(storage, id)) {
                    throw new ServiceError("conflict", "Datasource is used by a workspace")
                }
                const result = storage.db.prepare("DELETE FROM datasources WHERE id = ?").run(id)
                if (!result.changes) throw new ServiceError("not_found", "Datasource not found")
            })
            .immediate()
    }

    return { list, getPublic, create, describe, updateMetadata, execute, remove }
}

export type DatasourceService = ReturnType<typeof createDatasourceService>
