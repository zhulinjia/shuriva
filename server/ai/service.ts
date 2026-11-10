import { randomUUID } from "node:crypto"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import type { WorkspaceDocument } from "../../src/shared/workspace-schema.js"
import { validateQueryIdentifiers } from "../datasources/query.js"
import { buildAiMetadata } from "../datasources/ai-metadata.js"
import type { DatasourceService } from "../datasources/service.js"
import { ServiceError } from "../errors.js"
import type { Storage } from "../storage.js"
import { selectAiConfig } from "./config-store.js"
import type { GenerationInput } from "./contracts.js"
import { requestWorkspace } from "./provider.js"
import { aiFailure } from "./failure.js"

type FilterValue = WorkspaceDocument["queries"][number]["filters"][number]["value"]
type RedactedFilter = {
    value: FilterValue
    queryId: string
    datasourceId: string
    table: string
    field: string
}
const FILTER_TOKEN_PREFIX = "__SHURIVA_FILTER_"

function redactFilters(document: WorkspaceDocument | undefined) {
    const prefix = `${FILTER_TOKEN_PREFIX}${randomUUID()}_`
    const values = new Map<string, RedactedFilter>()
    if (!document) return { current: null, values, prefix }

    const current: WorkspaceDocument = {
        ...document,
        queries: document.queries.map((query) => ({
            ...query,
            filters: query.filters.map((filter) => {
                const token = `${prefix}${values.size}__`
                values.set(token, {
                    value: filter.value,
                    queryId: query.id,
                    datasourceId: query.datasourceId,
                    table: query.table,
                    field: filter.field,
                })
                return { ...filter, value: token }
            }),
        })),
    }
    return { current, values, prefix }
}

function restoreFilters(document: WorkspaceDocument, values: Map<string, RedactedFilter>, prefix: string): WorkspaceDocument {
    const used = new Set<string>()
    return {
        ...document,
        queries: document.queries.map((query) => ({
            ...query,
            filters: query.filters.map((filter) => {
                if (typeof filter.value !== "string" || !filter.value.startsWith(FILTER_TOKEN_PREFIX)) return filter
                if (!filter.value.startsWith(prefix)) throw new Error("Invalid redacted value")
                const original = values.get(filter.value)
                // A model must not carry a hidden value to a different query, source,
                // table or field by moving its placeholder in the returned document.
                if (
                    !original ||
                    original.queryId !== query.id ||
                    original.datasourceId !== query.datasourceId ||
                    original.table !== query.table ||
                    original.field !== filter.field ||
                    used.has(filter.value)
                ) {
                    throw new Error("Invalid redacted value")
                }
                used.add(filter.value)
                return { ...filter, value: original.value }
            }),
        })),
    }
}

export async function generateWorkspace(storage: Storage, sources: DatasourceService, input: GenerationInput): Promise<WorkspaceDocument> {
    const config = selectAiConfig(storage, input.aiModel)

    const selectedIds = new Set(input.datasourceIds)
    if (input.current?.queries.some((query) => !selectedIds.has(query.datasourceId))) {
        throw new ServiceError("invalid_input", "请选择当前工作台使用的全部数据源后重试。")
    }

    const metadata = []
    for (const id of selectedIds) {
        const source = sources.getPublic(id)
        if (!source) throw new ServiceError("invalid_input", "所选数据源不存在，请重新选择。")
        let schema
        try {
            schema = await sources.describe(id)
        } catch {
            throw new ServiceError("unavailable", "无法读取所选数据源的结构，请检查连接后重试。")
        }
        if (schema.warnings.some((warning) => warning.code === "tables_truncated" || warning.code === "columns_truncated")) {
            throw new ServiceError("invalid_input", "数据源结构过多，读取不完整，暂时无法安全生成工作台。")
        }
        const context = buildAiMetadata(schema, schema.preferences)
        if (!context.tables.length) throw new ServiceError("invalid_input", "数据源没有可供 AI 使用的表和字段，请在数据源结构中调整范围。")
        metadata.push({ id, name: source.name, ...context })
    }
    for (const query of input.current?.queries ?? []) {
        const source = metadata.find((item) => item.id === query.datasourceId)
        try {
            if (!source) throw new Error("Unknown datasource")
            validateQueryIdentifiers(query, source.tables)
        } catch {
            throw new ServiceError("invalid_input", "当前工作台使用了未提供给 AI 的表或字段，请在数据源结构中调整范围后重试。")
        }
    }

    const redacted = redactFilters(input.current)
    try {
        const response = await requestWorkspace(config, {
            instruction: input.instruction,
            sources: metadata,
            current: redacted.current,
        })
        const document = restoreFilters(workspaceDocumentSchema.parse(response), redacted.values, redacted.prefix)
        for (const query of document.queries) {
            const source = metadata.find((item) => item.id === query.datasourceId)
            if (!source) throw new Error("Unknown datasource")
            validateQueryIdentifiers(query, source.tables)
        }
        return document
    } catch (error) {
        if (error instanceof ServiceError) throw error
        throw aiFailure("ai_invalid_workspace")
    }
}
