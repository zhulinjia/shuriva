import { z } from "zod"
import type { Storage } from "../storage.js"
import { aiProviderSchema, initialAiModels } from "../../src/shared/ai-settings.js"
import type {
    AiModelSelection,
    AiProvider,
    AiProvidersState,
    AiProviderSettingsInput,
    AiSettingsInput,
    PublicAiSettings,
} from "../../src/shared/ai-settings.js"
import { aiConfigSchema, aiProviderConfigSchema } from "./contracts.js"
import type { AiConfig, AiProviderConfig } from "./contracts.js"
import { aiFailure } from "./failure.js"

const configurationSchema = z
    .object({
        version: z.literal(3),
        activeProvider: aiProviderSchema.nullable(),
        profiles: z.partialRecord(aiProviderSchema, aiProviderConfigSchema),
    })
    .strict()
    .superRefine((state, context) => {
        for (const [provider, config] of Object.entries(state.profiles)) {
            if (config?.provider !== provider) context.addIssue({ code: "custom", message: "Provider configuration mismatch" })
        }
        if (state.activeProvider && !state.profiles[state.activeProvider]) {
            context.addIssue({ code: "custom", message: "Active provider has no configuration" })
        }
    })
type Configuration = z.infer<typeof configurationSchema>
const previousConfigurationSchema = z
    .object({
        version: z.literal(2),
        activeProvider: aiProviderSchema.nullable(),
        profiles: z.partialRecord(aiProviderSchema, aiConfigSchema),
    })
    .strict()

function upgradeProfile(config: AiConfig): AiProviderConfig {
    return {
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        models: initialAiModels(config.provider, config.model),
        defaultModel: config.model,
    }
}

function readConfiguration(storage: Storage): Configuration {
    const row = storage.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined
    if (!row) return { version: 3, activeProvider: null, profiles: {} }
    const value = storage.open(row.value)
    if (typeof value === "object" && value !== null && "version" in value) {
        if (value.version === 3) return configurationSchema.parse(value)
        const previous = previousConfigurationSchema.parse(value)
        return configurationSchema.parse({
            version: 3,
            activeProvider: previous.activeProvider,
            profiles: Object.fromEntries(
                Object.entries(previous.profiles).map(([provider, config]) => [provider, upgradeProfile(config!)]),
            ),
        })
    }
    const legacy = aiConfigSchema.parse(value)
    return { version: 3, activeProvider: legacy.provider, profiles: { [legacy.provider]: upgradeProfile(legacy) } }
}

function writeConfiguration(storage: Storage, state: Configuration): void {
    storage.db
        .prepare("INSERT INTO settings(key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(storage.seal(configurationSchema.parse(state)))
}

export function readAiConfig(storage: Storage, provider?: AiProvider): AiConfig | null {
    const state = readConfiguration(storage)
    const selected = provider ?? state.activeProvider
    const profile = selected ? state.profiles[selected] : null
    return profile ? runtimeConfig(profile, profile.defaultModel) : null
}

function runtimeConfig(profile: AiProviderConfig, model: string): AiConfig {
    return { provider: profile.provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, model }
}

export function selectAiConfig(storage: Storage, selection?: AiModelSelection): AiConfig {
    const state = readConfiguration(storage)
    const provider = selection?.provider ?? state.activeProvider
    const profile = provider ? state.profiles[provider] : null
    if (!profile) throw aiFailure(selection ? "ai_provider_not_configured" : "ai_not_configured")
    const model = selection?.modelId ?? profile.defaultModel
    if (!profile.models.some((item) => item.id === model && item.enabled)) throw aiFailure("ai_model_not_enabled")
    return runtimeConfig(profile, model)
}

export function saveAiConfig(storage: Storage, config: AiConfig): void {
    storage.db
        .transaction(() => {
            const state = readConfiguration(storage)
            const previous = state.profiles[config.provider]
            const models =
                previous?.models.map((model) => (model.id === config.model ? { ...model, enabled: true } : model)) ??
                initialAiModels(config.provider, config.model)
            if (!models.some((model) => model.id === config.model)) models.push({ id: config.model, label: config.model, enabled: true })
            state.profiles[config.provider] = {
                provider: config.provider,
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                models,
                defaultModel: config.model,
            }
            state.activeProvider ??= config.provider
            writeConfiguration(storage, state)
        })
        .immediate()
}

export function saveAiProviderSettings(storage: Storage, input: AiProviderSettingsInput): AiProvidersState {
    return storage.db
        .transaction(() => {
            const state = readConfiguration(storage)
            const apiKey = resolveCredential(state, input)
            state.profiles[input.provider] = aiProviderConfigSchema.parse({ ...input, apiKey })
            state.activeProvider ??= input.provider
            writeConfiguration(storage, state)
            return publicProviders(state)
        })
        .immediate()
}

export function publicAiConfig(config: AiConfig | null): PublicAiSettings {
    if (!config) return { configured: false }
    return { configured: true, provider: config.provider, baseUrl: config.baseUrl, model: config.model }
}

/** A stored credential is never reused at a different service endpoint. */
export function resolveAiConfig(storage: Storage, input: AiSettingsInput): AiConfig {
    return aiConfigSchema.parse({ ...input, apiKey: resolveCredential(readConfiguration(storage), input) })
}

function resolveCredential(state: Configuration, input: { provider: AiProvider; baseUrl: string; apiKey?: string }): string {
    if (input.apiKey) return input.apiKey
    const saved = state.profiles[input.provider]
    if (!saved) throw aiFailure(state.activeProvider ? "ai_key_provider_changed" : "ai_key_required")
    if (saved.baseUrl !== input.baseUrl) throw aiFailure("ai_key_endpoint_changed")
    return saved.apiKey
}

function publicProviders(state: Configuration): AiProvidersState {
    return {
        activeProvider: state.activeProvider,
        providers: aiProviderSchema.options.map((provider) => {
            const profile = state.profiles[provider]
            return profile
                ? {
                      configured: true as const,
                      provider,
                      baseUrl: profile.baseUrl,
                      model: profile.defaultModel,
                      models: profile.models,
                      defaultModel: profile.defaultModel,
                  }
                : { configured: false as const, provider }
        }),
    }
}

export function readAiProviders(storage: Storage): AiProvidersState {
    return publicProviders(readConfiguration(storage))
}

export function activateAiProvider(storage: Storage, provider: AiProvider): AiProvidersState {
    return storage.db
        .transaction(() => {
            const state = readConfiguration(storage)
            if (!state.profiles[provider]) throw aiFailure("ai_provider_not_configured")
            state.activeProvider = provider
            writeConfiguration(storage, state)
            return publicProviders(state)
        })
        .immediate()
}
