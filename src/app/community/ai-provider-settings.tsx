import { useId } from "react"
import { Check, ChevronRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { AI_PROVIDER_PRESETS } from "@/shared/ai-settings"
import type { AiProvidersState } from "@/shared/ai-settings"
import { useAiProviderSettings } from "./use-ai-provider-settings"
import { AiModelsEditor } from "./ai-models-editor"
import { AiTestFeedback } from "./ai-test-feedback"

export function AiProviderSettings({ state }: { state: AiProvidersState }) {
    const id = useId()
    const {
        provider,
        saved,
        draft,
        errors,
        operation,
        formRef,
        canReuseKey,
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
    } = useAiProviderSettings(state)
    const preset = AI_PROVIDER_PRESETS[provider]
    const active = state.activeProvider === provider
    const testing = operation.isPending && operation.variables.kind === "test"
    const saving = operation.isPending && operation.variables.kind === "save"
    const activating = operation.isPending && operation.variables.kind === "activate"
    const testingDefault = testing && operation.variables.kind === "test" && operation.variables.source === "default"
    const currentTest = !operation.isIdle && operation.variables?.kind === "test" ? operation.variables : undefined
    const defaultModelId = draft.defaultModel.trim()
    const defaultTestResult = Object.hasOwn(testedModels, defaultModelId) ? testedModels[defaultModelId] : undefined
    const footerResult = defaultTestResult?.source === "default" ? defaultTestResult : undefined
    const replacingKey = Boolean(draft.apiKey.trim())
    const keySaved = saved.configured && canReuseKey && !replacingKey
    const keyStatus = replacingKey ? "新密钥待保存" : keySaved ? "密钥已保存" : saved.configured ? "新地址需要密钥" : "尚未保存密钥"
    return (
        <div className="mt-7 overflow-hidden rounded-lg border bg-card lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
            <nav aria-label="AI 提供商" className="border-b bg-muted/20 p-3 lg:border-r lg:border-b-0">
                <p className="px-3 pt-2 pb-3 text-xs font-medium text-muted-foreground">提供商</p>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
                    {state.providers.map((profile) => (
                        <button
                            key={profile.provider}
                            type="button"
                            aria-label={`编辑 ${AI_PROVIDER_PRESETS[profile.provider].label} 配置`}
                            aria-current={provider === profile.provider ? "true" : undefined}
                            disabled={operation.isPending}
                            onClick={() => selectProvider(profile.provider)}
                            className={cn(
                                "flex min-w-0 items-center gap-2 rounded-md px-3 py-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50",
                                provider === profile.provider && "bg-muted",
                            )}
                        >
                            <span className="min-w-0 flex-1">
                                <span className="block font-medium">{AI_PROVIDER_PRESETS[profile.provider].label}</span>
                                <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                    {state.activeProvider === profile.provider ? (
                                        <>
                                            <Check className="size-3" aria-hidden="true" />
                                            当前使用
                                        </>
                                    ) : profile.configured ? (
                                        "已配置"
                                    ) : (
                                        "未配置"
                                    )}
                                </span>
                            </span>
                            {provider === profile.provider && (
                                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            )}
                        </button>
                    ))}
                </div>
                <p className="px-3 pt-5 pb-2 text-xs leading-5 text-muted-foreground">各家配置独立保存，选择左侧项目只切换编辑内容。</p>
            </nav>
            <form
                ref={formRef}
                noValidate
                aria-label={`${preset.label} 配置`}
                aria-busy={operation.isPending}
                className="grid min-w-0 gap-5 p-5 sm:p-6"
                onSubmit={(event) => {
                    event.preventDefault()
                    run("save")
                }}
            >
                <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
                    <div>
                        <h2 className="text-lg font-semibold">{preset.label}</h2>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {active
                                ? "当前用于创建和修改工作台"
                                : saved.configured
                                  ? "已配置，可设为当前使用"
                                  : "填写并保存后可设为当前使用"}
                        </p>
                    </div>
                    {active ? (
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs">
                            <Check className="size-3.5" aria-hidden="true" />
                            当前使用
                        </span>
                    ) : (
                        <Button type="button" size="sm" variant="outline" disabled={operation.isPending} onClick={() => run("activate")}>
                            {activating && <Loader2 className="animate-spin" aria-hidden="true" />}
                            {activating ? "正在切换…" : "设为当前使用"}
                        </Button>
                    )}
                </div>
                <Field data-invalid={Boolean(errors.baseUrl)}>
                    <FieldLabel htmlFor={`${id}-base-url`}>服务地址</FieldLabel>
                    <Input
                        id={`${id}-base-url`}
                        name="baseUrl"
                        type="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://example.com/v1"
                        value={draft.baseUrl}
                        onChange={(event) => updateField("baseUrl", event.target.value)}
                        disabled={operation.isPending}
                        aria-invalid={Boolean(errors.baseUrl)}
                        aria-describedby={`${id}-url-help${errors.baseUrl ? ` ${id}-url-error` : ""}`}
                    />
                    <FieldDescription id={`${id}-url-help`} className="text-xs leading-5">
                        {preset.protocol} 协议，可填写兼容代理地址。
                    </FieldDescription>
                    <FieldError id={`${id}-url-error`}>{errors.baseUrl}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errors.apiKey)}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldLabel htmlFor={`${id}-key`}>API 密钥</FieldLabel>
                        <span
                            role="status"
                            className={cn(
                                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                                keySaved
                                    ? "bg-success-soft text-success"
                                    : replacingKey || saved.configured
                                      ? "bg-warning-soft text-warning"
                                      : "bg-muted text-muted-foreground",
                            )}
                        >
                            {keySaved && <Check className="size-3.5" aria-hidden="true" />}
                            {keyStatus}
                        </span>
                    </div>
                    <Input
                        id={`${id}-key`}
                        name="apiKey"
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={canReuseKey ? "••••••••（已保存，留空保留）" : "输入 API 密钥"}
                        value={draft.apiKey}
                        onChange={(event) => updateField("apiKey", event.target.value)}
                        disabled={operation.isPending}
                        aria-invalid={Boolean(errors.apiKey)}
                        aria-describedby={`${id}-key-help${errors.apiKey ? ` ${id}-key-error` : ""}`}
                    />
                    <FieldDescription id={`${id}-key-help`} className="text-xs leading-5">
                        {replacingKey
                            ? "新密钥尚未保存，点击「保存配置」后生效；测试连接不会保存密钥。"
                            : keySaved
                              ? "密钥已加密保存在服务端，刷新不会丢失。留空保留，输入新密钥可替换。"
                              : saved.configured
                                ? "原地址的密钥仍保留；当前服务地址需要重新填写密钥。"
                                : "密钥加密保存在服务端，保存后不会返回原文。切换提供商会清空未保存的密钥。"}
                    </FieldDescription>
                    <FieldError id={`${id}-key-error`}>{errors.apiKey}</FieldError>
                </Field>
                <AiModelsEditor
                    models={draft.models}
                    defaultModel={draft.defaultModel}
                    errors={errors}
                    pending={operation.isPending}
                    testingModel={testing && currentTest?.source === "row" ? currentTest.input.model : undefined}
                    activeTestModel={currentTest?.source === "row" ? currentTest.input.model : undefined}
                    testedModels={testedModels}
                    testFailure={testFailure?.source === "row" ? testFailure : undefined}
                    onChange={updateModel}
                    onAdd={addModel}
                    onRemove={removeModel}
                    onDefault={setDefaultModel}
                    onTest={(modelId) => run("test", modelId, "row")}
                />
                <div role="group" aria-label="配置操作" className="grid gap-3 border-t pt-5">
                    <p className="text-xs leading-5 text-muted-foreground">
                        测试只发送简短 JSON 请求，不发送业务数据，也不保存配置。
                        {state.activeProvider ? "保存配置不会切换当前使用的提供商。" : "首次保存后会自动设为当前使用。"}
                    </p>
                    <div className="flex flex-wrap gap-3">
                        <Button
                            id={`${id}-default-test-button`}
                            type="button"
                            variant="outline"
                            disabled={operation.isPending}
                            onClick={() => run("test")}
                            aria-describedby={
                                testingDefault || footerResult || testFailure?.source === "default"
                                    ? `${id}-default-test-feedback`
                                    : undefined
                            }
                            className={
                                defaultTestResult
                                    ? "border-success-border bg-success-soft text-success hover:bg-success-soft hover:text-success"
                                    : undefined
                            }
                        >
                            {testingDefault ? (
                                <Loader2 className="animate-spin" aria-hidden="true" />
                            ) : (
                                defaultTestResult && <Check aria-hidden="true" />
                            )}
                            {testingDefault ? "正在测试…" : defaultTestResult ? "重新测试连接" : "测试连接"}
                        </Button>
                        <Button type="submit" disabled={operation.isPending}>
                            {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
                            {saving ? "正在保存…" : "保存配置"}
                        </Button>
                    </div>
                    <AiTestFeedback
                        id={`${id}-default-test-feedback`}
                        anchorId={currentTest?.source === "default" ? `${id}-default-test-button` : undefined}
                        pending={testingDefault}
                        result={footerResult}
                        error={testFailure?.source === "default" ? testFailure.message : undefined}
                    />
                    {operation.isPending && !testing && (
                        <p role="status" className="text-sm text-muted-foreground">
                            {activating ? "正在切换提供商…" : "正在保存配置…"}
                        </p>
                    )}
                    {failure && (
                        <p role="alert" className="text-sm leading-relaxed text-destructive">
                            {failure}
                        </p>
                    )}
                    {success && (
                        <p role="status" className="text-sm leading-relaxed">
                            {success}
                        </p>
                    )}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                    生成工作台时会发送需求、所选数据源结构和当前工作台配置；已有筛选值会先遮蔽，目前不发送数据样本。
                </p>
            </form>
        </div>
    )
}
