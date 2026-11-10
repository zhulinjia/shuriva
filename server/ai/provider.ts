import { createAnthropic } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, Output } from "ai"
import { z } from "zod"
import type { AiConnectionResult } from "../../src/shared/ai-settings.js"
import { workspaceDocumentSchema } from "../../src/shared/workspace-schema.js"
import type { AiConfig } from "./contracts.js"
import { aiFailure, classifyAiFailure } from "./failure.js"
import { CONNECTION_TEST_SYSTEM_PROMPT, WORKSPACE_SYSTEM_PROMPT } from "./prompt.js"

const MAX_RESPONSE_BYTES = 2_000_000
const REQUEST_TIMEOUT_MS = 45_000
const CONNECTION_TEST_TIMEOUT_MS = 15_000
const connectionReplySchema = z.object({ ok: z.literal(true) }).strict()

function createLanguageModel(config: AiConfig) {
    const settings = { baseURL: config.baseUrl.replace(/\/+$/, ""), apiKey: config.apiKey, fetch: boundedFetch }
    switch (config.provider) {
        case "deepseek":
            return createDeepSeek(settings).chat(config.model)
        case "openai":
            return createOpenAI(settings).chat(config.model)
        case "anthropic":
            return createAnthropic(settings).chat(config.model)
        case "custom":
            return createOpenAICompatible({ ...settings, name: "shuriva" }).chatModel(config.model)
    }
}

/** Both AI operations share response limits and never follow redirects with a credential. */
async function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw aiFailure("ai_endpoint_redirect")
    }
    const reader = response.body?.getReader()
    if (!reader) return response

    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > MAX_RESPONSE_BYTES) {
                await reader.cancel()
                throw aiFailure("ai_response_too_large")
            }
            chunks.push(chunk.value)
        }
    } finally {
        reader.releaseLock()
    }

    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    return new Response(Buffer.concat(chunks).toString("utf8"), {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

async function requestJson(
    config: AiConfig,
    options: {
        system: string
        prompt: string
        schema: z.ZodType
        timeoutMs: number
        maxOutputTokens?: number
        signal?: AbortSignal
    },
): Promise<unknown> {
    const deadline = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    try {
        const result = await generateText({
            model: createLanguageModel(config),
            system: options.system,
            prompt: options.prompt,
            output: config.provider === "anthropic" ? Output.object({ schema: options.schema }) : Output.json(),
            ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
            maxRetries: 0,
            abortSignal: signal,
        })
        return result.output
    } catch (error) {
        throw classifyAiFailure(error, signal)
    }
}

export function requestWorkspace(config: AiConfig, context: unknown): Promise<unknown> {
    return requestJson(config, {
        system: WORKSPACE_SYSTEM_PROMPT,
        prompt: JSON.stringify(context),
        schema: workspaceDocumentSchema,
        timeoutMs: REQUEST_TIMEOUT_MS,
    })
}

/** A cancellation signal can shorten the test, but cannot extend its service deadline. */
export async function testAiConnection(config: AiConfig, signal?: AbortSignal): Promise<AiConnectionResult> {
    const started = performance.now()
    const output = await requestJson(config, {
        system: CONNECTION_TEST_SYSTEM_PROMPT,
        prompt: JSON.stringify({ purpose: "connection_test" }),
        schema: connectionReplySchema,
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
        maxOutputTokens: config.provider === "custom" ? 256 : 2_048,
        signal,
    })
    if (!connectionReplySchema.safeParse(output).success) throw aiFailure("ai_invalid_response")
    return { ok: true, provider: config.provider, model: config.model, elapsedMs: Math.round(performance.now() - started) }
}
