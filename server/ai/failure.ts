import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from "ai"
import { ServiceError } from "../errors.js"
import type { ServiceErrorCode } from "../errors.js"

const FAILURES = {
    ai_not_configured: ["invalid_input", "请先在「AI 设置」中配置模型服务。"],
    ai_key_required: ["invalid_input", "请填写 API 密钥。"],
    ai_key_provider_changed: ["invalid_input", "AI 提供商已变更，请重新输入该提供商的 API 密钥。"],
    ai_provider_not_configured: ["invalid_input", "请先保存该提供商的配置，再设为当前使用。"],
    ai_model_not_enabled: ["invalid_input", "所选模型未配置或已停用，请重新选择已启用的模型。"],
    ai_key_endpoint_changed: ["invalid_input", "服务地址已变更，请重新输入该服务的 API 密钥。"],
    ai_authentication_failed: ["upstream_failure", "模型服务拒绝了 API 密钥，请检查密钥是否正确或已过期。"],
    ai_access_denied: ["upstream_failure", "模型服务拒绝访问，请检查密钥权限、模型授权或服务访问限制。"],
    ai_model_unavailable: ["upstream_failure", "找不到模型或接口，请检查服务地址和模型名称。"],
    ai_rate_limited: ["upstream_failure", "模型服务限制了请求，请检查调用额度或稍后重试。"],
    ai_timeout: ["upstream_failure", "模型服务响应超时，请稍后重试或检查服务地址。"],
    ai_cancelled: ["upstream_failure", "模型请求已取消，可以重新发起。"],
    ai_request_rejected: ["upstream_failure", "模型服务不接受当前请求，请确认模型支持兼容的对话接口和 JSON 输出。"],
    ai_provider_unavailable: ["upstream_failure", "模型服务暂时不可用，请稍后重试。"],
    ai_connection_failed: ["upstream_failure", "无法连接模型服务，请检查服务地址和服务器网络后重试。"],
    ai_endpoint_redirect: ["upstream_failure", "模型服务地址发生重定向，请填写最终接口地址后重试。"],
    ai_response_too_large: ["upstream_failure", "模型返回的内容过大，请缩小需求后重试。"],
    ai_invalid_response: ["upstream_failure", "模型返回的内容不符合预期的 JSON 格式，请确认模型支持 JSON 输出后重试。"],
    ai_invalid_workspace: ["upstream_failure", "模型返回的工作台不符合组件或数据源规则，请调整需求后重试。"],
} as const satisfies Record<string, readonly [ServiceErrorCode, string]>

export function aiFailure(reason: keyof typeof FAILURES): ServiceError {
    const [category, message] = FAILURES[reason]
    return new ServiceError(category, message, reason)
}

/** Inspect only error types and status codes; provider messages can contain secrets. */
export function classifyAiFailure(error: unknown, signal: AbortSignal): ServiceError {
    const chain: unknown[] = []
    for (let current = error; current && chain.length < 8 && !chain.includes(current); ) {
        chain.push(current)
        current = typeof current === "object" && "cause" in current ? current.cause : undefined
    }
    const known = chain.find((item): item is ServiceError => item instanceof ServiceError)
    if (known) return known
    if (signal.aborted) {
        const reason: unknown = signal.reason
        const cancelled = reason instanceof Error && reason.name === "AbortError"
        return aiFailure(cancelled ? "ai_cancelled" : "ai_timeout")
    }
    const apiError = chain.find(APICallError.isInstance)
    if (apiError) {
        const status = apiError.statusCode
        if (status === 401) return aiFailure("ai_authentication_failed")
        if (status === 403) return aiFailure("ai_access_denied")
        if (status === 404) return aiFailure("ai_model_unavailable")
        if (status === 429) return aiFailure("ai_rate_limited")
        if (status === 408 || status === 504) return aiFailure("ai_timeout")
        if (status !== undefined && status >= 500) return aiFailure("ai_provider_unavailable")
        if (status !== undefined && status >= 400) return aiFailure("ai_request_rejected")
        if (status !== undefined && status >= 200 && status < 300) return aiFailure("ai_invalid_response")
    }
    if (chain.some((item) => NoObjectGeneratedError.isInstance(item) || NoOutputGeneratedError.isInstance(item))) {
        return aiFailure("ai_invalid_response")
    }
    return aiFailure("ai_connection_failed")
}
