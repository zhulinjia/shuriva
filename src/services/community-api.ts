import type { WorkspaceDocument, WorkspaceQuery } from "@/shared/workspace-schema"
import type { DatasourcePreferences, DatasourceSchema } from "@/shared/datasource-metadata"

export type LiveSource = { id: string; name: string; engine: "sqlite" | "postgresql" | "mysql" }
export type LiveWorkspace = { id: string; revision: number; updatedAt: string; document: WorkspaceDocument }
export type LiveRow = Record<string, unknown>

export class ApiError extends Error {
    status: number
    code?: string
    constructor(status: number, message: string, code?: string) {
        super(message)
        this.name = "ApiError"
        this.status = status
        this.code = code
    }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`/api${path}`, {
        method: options.method ?? "GET",
        credentials: "same-origin",
        headers: { "x-shuriva-request": "1", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }).catch(() => {
        throw new ApiError(0, "无法连接 Shuriva 服务，请检查网络后重试。", "network_error")
    })
    const result: unknown = await response.json().catch(() => null)
    if (!response.ok) {
        const message =
            typeof result === "object" && result && "error" in result && typeof result.error === "string" ? result.error : "请求失败"
        const code = typeof result === "object" && result && "code" in result && typeof result.code === "string" ? result.code : undefined
        throw new ApiError(response.status, message, code)
    }
    return result as T
}

export function apiErrorMessage(error: unknown, fallback: string): string {
    return error instanceof ApiError ? error.message : fallback
}

export const getSources = () => api<LiveSource[]>("/datasources")
export const getDatasourceSchema = (id: string) => api<DatasourceSchema>(`/datasources/${encodeURIComponent(id)}/schema`)
export const saveDatasourceMetadata = (id: string, preferences: DatasourcePreferences) =>
    api<DatasourcePreferences>(`/datasources/${encodeURIComponent(id)}/metadata`, { method: "PUT", body: preferences })
export const getWorkspaces = () => api<LiveWorkspace[]>("/workspaces")
export const previewQuery = (query: WorkspaceQuery) => api<{ rows: LiveRow[] }>("/workspaces/preview", { method: "POST", body: query })
