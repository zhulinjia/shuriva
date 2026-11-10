import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { activateAiProvider, saveAiProviderSettings, testAiSettings } from "@/services/ai-api"
import { ApiError, apiErrorMessage } from "@/services/community-api"
import { aiProviderSettingsInputSchema, aiSettingsInputSchema } from "@/shared/ai-settings"
import type {
    AiConnectionResult,
    AiModel,
    AiProvider,
    AiProvidersState,
    AiProviderSettingsInput,
    AiSettingsInput,
} from "@/shared/ai-settings"
import { changeModel, initialProviderDraft, providerDraftInput } from "./ai-provider-draft"
import type { AiModelTestResult, AiProviderDraft } from "./ai-provider-draft"

type Operation =
    | { kind: "test"; input: AiSettingsInput; source: "row" | "default" }
    | { kind: "save"; input: AiProviderSettingsInput }
    | { kind: "activate"; provider: AiProvider }
type Result =
    | { kind: "test"; result: AiConnectionResult; source: "row" | "default" }
    | { kind: "save" | "activate"; state: AiProvidersState; provider: AiProvider }

export function useAiProviderSettings(state: AiProvidersState) {
    const client = useQueryClient()
    const formRef = useRef<HTMLFormElement>(null)
    const [provider, setProvider] = useState<AiProvider>(state.activeProvider ?? "deepseek")
    const [drafts, setDrafts] = useState<Partial<Record<AiProvider, AiProviderDraft>>>({})
    const [errors, setErrors] = useState<Record<string, string>>({})
    const [notice, setNotice] = useState<string | null>(null)
    const [testedModels, setTestedModels] = useState<Record<string, AiModelTestResult>>({})
    const saved = state.providers.find((profile) => profile.provider === provider) ?? { provider, configured: false as const }
    const draft = drafts[provider] ?? initialProviderDraft(provider, saved)
    const normalizedUrl = aiSettingsInputSchema.shape.baseUrl.safeParse(draft.baseUrl)
    const canReuseKey = saved.configured && normalizedUrl.success && normalizedUrl.data === saved.baseUrl
    const dirty =
        !saved.configured ||
        !canReuseKey ||
        Boolean(draft.apiKey.trim()) ||
        draft.defaultModel !== saved.defaultModel ||
        JSON.stringify(providerDraftInput(provider, draft).models) !== JSON.stringify(saved.models)
    const focusField = (name: string) => {
        const element = formRef.current?.elements.namedItem(name)
        if (element instanceof HTMLElement) element.focus()
        else formRef.current?.querySelector<HTMLElement>("[data-model-list]")?.focus()
    }
    const operation = useMutation({
        mutationFn: async (action: Operation): Promise<Result> => {
            if (action.kind === "test") return { kind: "test", result: await testAiSettings(action.input), source: action.source }
            if (action.kind === "activate")
                return { kind: "activate", state: await activateAiProvider(action.provider), provider: action.provider }
            return { kind: "save", state: await saveAiProviderSettings(action.input), provider: action.input.provider }
        },
        retry: false,
        onSuccess: async (result) => {
            if (result.kind === "test") {
                setTestedModels((current) => ({ ...current, [result.result.model]: { ...result.result, source: result.source } }))
                return
            }
            client.setQueryData(["live-ai-providers"], result.state)
            if (result.kind === "save")
                setDrafts((current) => {
                    const next = { ...current }
                    delete next[result.provider]
                    return next
                })
            await Promise.all([
                client.invalidateQueries({ queryKey: ["live-ai-providers"] }),
                client.invalidateQueries({ queryKey: ["live-ai-settings"] }),
            ])
        },
        onError: (error) => {
            if (
                error instanceof ApiError &&
                ["ai_key_required", "ai_key_endpoint_changed", "ai_key_provider_changed"].includes(error.code ?? "")
            ) {
                setErrors({ apiKey: error.message })
                requestAnimationFrame(() => focusField("apiKey"))
            }
        },
    })
    const resetFeedback = () => {
        setErrors({})
        setNotice(null)
        operation.reset()
    }
    const setDraft = (next: AiProviderDraft, clearTests = false) => {
        if (operation.isPending) return
        setDrafts((current) => ({ ...current, [provider]: next }))
        if (clearTests) setTestedModels({})
        resetFeedback()
    }
    const selectProvider = (next: AiProvider) => {
        if (operation.isPending || next === provider) return
        setDrafts((current) => ({ ...current, [provider]: { ...draft, apiKey: "" } }))
        setProvider(next)
        setTestedModels({})
        resetFeedback()
    }
    const updateField = (field: "baseUrl" | "apiKey", value: string) => setDraft({ ...draft, [field]: value }, true)
    const updateModel = (rowKey: string, patch: Partial<AiModel>) => setDraft(changeModel(draft, rowKey, patch), patch.id !== undefined)
    const addModel = () =>
        setDraft({ ...draft, models: [...draft.models, { id: "", label: "", enabled: true, rowKey: crypto.randomUUID() }] })
    const removeModel = (rowKey: string) => {
        const removed = draft.models.find((model) => model.rowKey === rowKey)
        const models = draft.models.filter((model) => model.rowKey !== rowKey)
        setDraft(
            {
                ...draft,
                models,
                defaultModel: removed?.id === draft.defaultModel ? (models.find((model) => model.enabled)?.id ?? "") : draft.defaultModel,
            },
            true,
        )
    }
    const setDefaultModel = (rowKey: string) => {
        const model = draft.models.find((item) => item.rowKey === rowKey)
        if (model) setDraft({ ...changeModel(draft, rowKey, { enabled: true }), defaultModel: model.id })
    }
    const run = (kind: Operation["kind"], modelId = draft.defaultModel, source: "row" | "default" = "default") => {
        if (operation.isPending) return
        resetFeedback()
        if (kind === "activate") {
            if (!saved.configured) setNotice("请先保存该提供商的配置，再设为当前使用。")
            else if (dirty) setNotice("有未保存的修改，请先保存后再设为当前使用。")
            else operation.mutate({ kind, provider })
            return
        }
        const input =
            kind === "save"
                ? aiProviderSettingsInputSchema.safeParse(providerDraftInput(provider, draft))
                : aiSettingsInputSchema.safeParse({
                      provider,
                      baseUrl: draft.baseUrl,
                      apiKey: draft.apiKey.trim() || undefined,
                      model: modelId,
                  })
        const nextErrors: Record<string, string> = {}
        if (!input.success)
            for (const issue of input.error.issues) {
                const path =
                    issue.path[0] === "model"
                        ? `models.${Math.max(
                              0,
                              draft.models.findIndex((item) => item.id === modelId),
                          )}.id`
                        : issue.path.join(".")
                nextErrors[path] ??= issue.message
            }
        if (!saved.configured && !draft.apiKey.trim()) nextErrors.apiKey = "请填写 API 密钥。"
        setErrors(nextErrors)
        const first = Object.keys(nextErrors)[0]
        if (first) {
            focusField(first)
            return
        }
        if (kind === "test") {
            setTestedModels((current) => {
                const next = { ...current }
                delete next[modelId.trim()]
                return next
            })
        }
        if (kind === "save") {
            const validated = aiProviderSettingsInputSchema.parse(providerDraftInput(provider, draft))
            operation.mutate({ kind, input: validated })
        } else
            operation.mutate({
                kind,
                source,
                input: aiSettingsInputSchema.parse({
                    provider,
                    baseUrl: draft.baseUrl,
                    apiKey: draft.apiKey.trim() || undefined,
                    model: modelId,
                }),
            })
    }
    const testFailure =
        operation.isError && operation.variables.kind === "test" && !errors.apiKey
            ? {
                  model: operation.variables.input.model,
                  source: operation.variables.source,
                  message: apiErrorMessage(operation.error, "连接测试失败，请稍后重试。"),
              }
            : undefined
    const failure =
        notice ??
        (operation.isError && operation.variables.kind !== "test" && !errors.apiKey
            ? apiErrorMessage(operation.error, "操作失败，请稍后重试。")
            : null)
    const success =
        operation.isSuccess && operation.data.kind !== "test"
            ? operation.data.kind === "activate"
                ? "已切换当前使用的提供商。"
                : "配置已保存。"
            : null
    return {
        provider,
        saved,
        draft,
        errors,
        formRef,
        canReuseKey,
        operation,
        failure,
        testFailure,
        success,
        testedModels,
        selectProvider,
        updateField,
        updateModel,
        addModel,
        removeModel,
        setDefaultModel,
        run,
    }
}
