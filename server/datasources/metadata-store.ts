import type { Storage } from "../storage.js"
import { ServiceError } from "../errors.js"
import { datasourcePreferencesSchema, emptyDatasourcePreferences } from "../../src/shared/datasource-metadata.js"
import type { DatasourcePreferences, DatasourceTable } from "../../src/shared/datasource-metadata.js"

export function readDatasourcePreferences(storage: Storage, datasourceId: string): DatasourcePreferences {
    const row = storage.db
        .prepare("SELECT revision, encrypted_payload FROM datasource_metadata WHERE datasource_id = ?")
        .get(datasourceId) as { revision: number; encrypted_payload: string } | undefined
    if (!row) return emptyDatasourcePreferences()
    const payload = storage.open(row.encrypted_payload)
    return datasourcePreferencesSchema.parse({ ...(payload as object), revision: row.revision })
}

function validRelation(relation: DatasourcePreferences["relations"][number], tables: readonly DatasourceTable[]): boolean {
    const from = tables.find((table) => table.name === relation.fromTable)
    const to = tables.find((table) => table.name === relation.toTable)
    return Boolean(
        from &&
        to &&
        relation.mappings.every(
            (mapping) =>
                from.columns.some((column) => column.name === mapping.from) && to.columns.some((column) => column.name === mapping.to),
        ),
    )
}

export function saveDatasourcePreferences(
    storage: Storage,
    datasourceId: string,
    input: DatasourcePreferences,
    tables: readonly DatasourceTable[],
): DatasourcePreferences {
    return storage.db
        .transaction(() => {
            const exists = storage.db.prepare("SELECT 1 FROM datasources WHERE id = ?").get(datasourceId)
            if (!exists) throw new ServiceError("not_found", "数据源不存在。")
            const previous = readDatasourcePreferences(storage, datasourceId)
            if (input.revision !== previous.revision) throw new ServiceError("conflict", "数据源说明已在其他页面更新，请重新读取后再保存。")
            const previousRelations = new Map(previous.relations.map((relation) => [relation.id, relation]))
            for (const relation of input.relations) {
                const unchanged = JSON.stringify(previousRelations.get(relation.id)) === JSON.stringify(relation)
                if (!unchanged && !validRelation(relation, tables))
                    throw new ServiceError("invalid_input", "关联的表或字段不存在，请刷新结构后重新选择。")
            }
            const next = datasourcePreferencesSchema.parse({ ...input, revision: previous.revision + 1 })
            const { revision, ...payload } = next
            storage.db
                .prepare(
                    `INSERT INTO datasource_metadata(datasource_id, revision, encrypted_payload, updated_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(datasource_id) DO UPDATE SET revision = excluded.revision,
            encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`,
                )
                .run(datasourceId, revision, storage.seal(payload), new Date().toISOString())
            return next
        })
        .immediate()
}

export function relationExists(relation: DatasourcePreferences["relations"][number], tables: readonly DatasourceTable[]): boolean {
    return validRelation(relation, tables)
}
