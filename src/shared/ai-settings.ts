import { z } from "zod"

export const aiProviderSchema = z.enum(["deepseek", "openai", "anthropic", "custom"])
export type AiProvider = z.infer<typeof aiProviderSchema>

// Model examples verified against the providers' official documentation on 2026-11-10.
// They remain editable because model availability depends on the account and service.
export const AI_PROVIDER_PRESETS = {
    deepseek: {
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-flash",
        models: ["deepseek-flash"],
        protocol: "OpenAI Chat Completions",
    },
    openai: {
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        models: ["gpt-5.4-mini", "gpt-5.4"],
        protocol: "OpenAI Chat Completions",
    },
    anthropic: {
        label: "Claude",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-5-5",
        models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
        protocol: "Anthropic Messages",
    },
    custom: {
        label: "自定义（OpenAI 兼容）",
        baseUrl: "",
        defaultModel: "",
        models: [],
        protocol: "OpenAI Chat Completions",
    },
} as const satisfies Record<
    AiProvider,
    { label: string; baseUrl: string; defaultModel: string; models: readonly string[]; protocol: string }
>

function isSupportedServiceUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !value.includes("?") && !value.includes("#")
    } catch {
        return false
    }
}

export const aiSettingsInputSchema = z
    .object({
        provider: aiProviderSchema.default("custom"),
        baseUrl: z
            .string()
            .trim()
            .min(1, "请填写服务地址。")
            .max(2048, "服务地址过长。")
            .refine(isSupportedServiceUrl, "请填写 HTTP 或 HTTPS 服务地址，且不要包含账号、查询参数或片段。")
            .transform((value) => new URL(value).href.replace(/\/+$/, "")),
        model: z.string().trim().min(1, "请填写模型名称。").max(255, "模型名称最多 255 个字符。"),
        apiKey: z.string().trim().min(1, "请填写 API 密钥。").max(4096, "API 密钥过长。").optional(),
    })
    .strict()

export type AiSettingsInput = z.infer<typeof aiSettingsInputSchema>
export type PublicAiSettings = { configured: false } | { configured: true; provider: AiProvider; baseUrl: string; model: string }

export const aiModelSchema = z
    .object({
        id: z.string().trim().min(1, "请填写 API 模型 ID。").max(255, "模型 ID 最多 255 个字符。"),
        label: z.string().trim().min(1, "请填写模型显示名称。").max(80, "显示名称最多 80 个字符。"),
        enabled: z.boolean(),
    })
    .strict()
export type AiModel = z.infer<typeof aiModelSchema>

export const aiProviderSettingsInputSchema = aiSettingsInputSchema
    .omit({ model: true })
    .extend({
        models: z.array(aiModelSchema).min(1, "请至少添加一个模型。").max(50, "每家提供商最多配置 50 个模型。"),
        defaultModel: aiModelSchema.shape.id,
    })
    .superRefine((input, context) => {
        const seen = new Set<string>()
        input.models.forEach((model, index) => {
            if (seen.has(model.id))
                context.addIssue({ code: "custom", path: ["models", index, "id"], message: "同一家提供商不能配置重复的模型 ID。" })
            seen.add(model.id)
        })
        if (!input.models.some((model) => model.id === input.defaultModel && model.enabled)) {
            context.addIssue({ code: "custom", path: ["defaultModel"], message: "请启用至少一个模型，并将已启用的模型设为默认。" })
        }
    })
export type AiProviderSettingsInput = z.infer<typeof aiProviderSettingsInputSchema>

export const aiModelSelectionSchema = z.object({ provider: aiProviderSchema, modelId: aiModelSchema.shape.id }).strict()
export type AiModelSelection = z.infer<typeof aiModelSelectionSchema>
export type PublicAiProviderSettings =
    | { provider: AiProvider; configured: false }
    | { provider: AiProvider; configured: true; baseUrl: string; model: string; models: AiModel[]; defaultModel: string }
export type AiProvidersState = { activeProvider: AiProvider | null; providers: PublicAiProviderSettings[] }
export type AiConnectionResult = { ok: true; provider: AiProvider; model: string; elapsedMs: number }

const MODEL_LABELS: Record<string, string> = {
    "deepseek-flash": "DeepSeek Flash",
    "gpt-5.4-mini": "GPT-5.4 mini",
    "gpt-5.4": "GPT-5.4",
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
    "claude-haiku-5-5": "Claude Haiku 5.5",
    "claude-opus-5-5": "Claude Opus 5.5",
}

/** Legacy configurations retain their selected model; additional presets start disabled. */
export function initialAiModels(provider: AiProvider, savedModel?: string): AiModel[] {
    const ids: string[] = [...AI_PROVIDER_PRESETS[provider].models]
    if (savedModel && !ids.includes(savedModel)) ids.push(savedModel)
    return ids.map((id) => ({
        id,
        label: Object.hasOwn(MODEL_LABELS, id) ? MODEL_LABELS[id]! : id,
        enabled: savedModel === undefined || id === savedModel,
    }))
}
