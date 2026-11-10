import { AI_PROVIDER_PRESETS, initialAiModels } from "@/shared/ai-settings"
import type { AiConnectionResult, AiModel, AiProvider, AiProviderSettingsInput, PublicAiProviderSettings } from "@/shared/ai-settings"

export type AiModelDraft = AiModel & { rowKey: string }
export type AiModelTestResult = AiConnectionResult & { source: "row" | "default" }
export type AiProviderDraft = { baseUrl: string; apiKey: string; models: AiModelDraft[]; defaultModel: string }

export function initialProviderDraft(provider: AiProvider, saved: PublicAiProviderSettings): AiProviderDraft {
    const models = saved.configured ? saved.models : initialAiModels(provider)
    return {
        baseUrl: saved.configured ? saved.baseUrl : AI_PROVIDER_PRESETS[provider].baseUrl,
        apiKey: "",
        defaultModel: saved.configured ? saved.defaultModel : AI_PROVIDER_PRESETS[provider].defaultModel,
        models: (models.length ? models : [{ id: "", label: "", enabled: true }]).map((model, index) => ({
            ...model,
            rowKey: `initial-${index}`,
        })),
    }
}

export function providerDraftInput(provider: AiProvider, draft: AiProviderDraft): AiProviderSettingsInput {
    return {
        provider,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
        defaultModel: draft.defaultModel,
        models: draft.models.map(({ id, label, enabled }) => ({ id, label, enabled })),
    }
}

export function changeModel(draft: AiProviderDraft, rowKey: string, patch: Partial<AiModel>): AiProviderDraft {
    const previous = draft.models.find((model) => model.rowKey === rowKey)
    if (!previous) return draft
    const models = draft.models.map((model) => (model.rowKey === rowKey ? { ...model, ...patch } : model))
    let defaultModel = draft.defaultModel
    if (previous.id === defaultModel) {
        defaultModel = patch.id ?? defaultModel
        if (patch.enabled === false) defaultModel = models.find((model) => model.enabled)?.id ?? defaultModel
    }
    return { ...draft, models, defaultModel }
}
