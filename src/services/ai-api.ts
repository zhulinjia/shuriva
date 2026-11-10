import type {
    AiConnectionResult,
    AiProvider,
    AiProvidersState,
    AiProviderSettingsInput,
    AiSettingsInput,
    PublicAiSettings,
} from "@/shared/ai-settings"
import { api } from "./community-api"

export const getAiSettings = () => api<PublicAiSettings>("/settings/ai")
export const getAiProviders = () => api<AiProvidersState>("/settings/ai/providers")
export const activateAiProvider = (provider: AiProvider) =>
    api<AiProvidersState>("/settings/ai/active", { method: "POST", body: { provider } })
export const saveAiSettings = (body: AiSettingsInput) => api<PublicAiSettings>("/settings/ai", { method: "PUT", body })
export const saveAiProviderSettings = (body: AiProviderSettingsInput) =>
    api<AiProvidersState>("/settings/ai/providers", { method: "PUT", body })
export const testAiSettings = (body: AiSettingsInput) => api<AiConnectionResult>("/settings/ai/test", { method: "POST", body })
