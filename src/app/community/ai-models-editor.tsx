import { useId } from "react"
import { Check, Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { AiModel } from "@/shared/ai-settings"
import type { AiModelDraft, AiModelTestResult } from "./ai-provider-draft"
import { AiTestFeedback } from "./ai-test-feedback"

type Props = {
    models: AiModelDraft[]
    defaultModel: string
    errors: Record<string, string>
    pending: boolean
    testingModel?: string
    activeTestModel?: string
    testedModels: Record<string, AiModelTestResult>
    testFailure?: { model: string; message: string }
    onChange: (rowKey: string, patch: Partial<AiModel>) => void
    onAdd: () => void
    onRemove: (rowKey: string) => void
    onDefault: (rowKey: string) => void
    onTest: (modelId: string) => void
}

export function AiModelsEditor(props: Props) {
    const id = useId()
    return (
        <section
            data-model-list
            tabIndex={-1}
            aria-labelledby={`${id}-title`}
            className="min-w-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`${id}-title`} className="text-sm font-medium">
                    模型列表
                </h3>
                <Button type="button" size="sm" variant="outline" disabled={props.pending} onClick={props.onAdd}>
                    <Plus aria-hidden="true" />
                    添加模型
                </Button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
                默认模型须启用。测试只验证当前模型，配置保存后才会出现在工作台的模型选择中。
            </p>
            <FieldError className="mt-2">{props.errors.models ?? props.errors.defaultModel}</FieldError>
            {!props.models.length && (
                <p className="py-5 text-sm text-muted-foreground">还没有模型，点击「添加模型」填写名称和 API 模型 ID。</p>
            )}
            <div className="mt-1 divide-y">
                {props.models.map((model, index) => (
                    <ModelRow key={model.rowKey} {...props} model={model} index={index} />
                ))}
            </div>
        </section>
    )
}

function ModelRow({ model, index, ...props }: Props & { model: AiModelDraft; index: number }) {
    const id = useId()
    const label = model.label || model.id || `模型 ${index + 1}`
    const modelId = model.id.trim()
    const isDefault = model.id === props.defaultModel && model.enabled
    const testing = props.pending && props.testingModel === modelId
    const tested = Object.hasOwn(props.testedModels, modelId) ? props.testedModels[modelId] : undefined
    const rowResult = tested?.source === "row" ? tested : undefined
    const error = props.testFailure?.model === modelId ? props.testFailure.message : undefined
    return (
        <div role="group" aria-label={`模型 ${label}`} className="grid min-w-0 gap-3 py-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <Field data-invalid={Boolean(props.errors[`models.${index}.label`])}>
                    <FieldLabel htmlFor={`${id}-label`} className="text-xs">
                        显示名称
                    </FieldLabel>
                    <Input
                        id={`${id}-label`}
                        name={`models.${index}.label`}
                        value={model.label}
                        placeholder="例如：业务分析模型"
                        disabled={props.pending}
                        onChange={(event) => props.onChange(model.rowKey, { label: event.target.value })}
                        aria-invalid={Boolean(props.errors[`models.${index}.label`])}
                        aria-describedby={props.errors[`models.${index}.label`] ? `${id}-label-error` : undefined}
                    />
                    <FieldError id={`${id}-label-error`}>{props.errors[`models.${index}.label`]}</FieldError>
                </Field>
                <Field data-invalid={Boolean(props.errors[`models.${index}.id`])}>
                    <FieldLabel htmlFor={`${id}-api-id`} className="text-xs">
                        API 模型 ID
                    </FieldLabel>
                    <Input
                        id={`${id}-api-id`}
                        name={`models.${index}.id`}
                        value={model.id}
                        placeholder="服务商提供的实际模型 ID"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={props.pending}
                        onChange={(event) => props.onChange(model.rowKey, { id: event.target.value })}
                        aria-invalid={Boolean(props.errors[`models.${index}.id`])}
                        aria-describedby={props.errors[`models.${index}.id`] ? `${id}-id-error` : undefined}
                    />
                    <FieldError id={`${id}-id-error`}>{props.errors[`models.${index}.id`]}</FieldError>
                </Field>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex items-center gap-2 text-xs">
                    <Switch
                        size="sm"
                        checked={model.enabled}
                        disabled={props.pending}
                        aria-label={`启用 ${label}`}
                        onCheckedChange={(enabled) => props.onChange(model.rowKey, { enabled })}
                    />
                    启用
                </label>
                {isDefault ? (
                    <span className="rounded bg-muted px-2 py-1 text-xs">默认模型</span>
                ) : (
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={props.pending}
                        aria-label={`将 ${label} 设为默认`}
                        onClick={() => props.onDefault(model.rowKey)}
                    >
                        设为默认
                    </Button>
                )}
                <div className="ml-auto flex items-center gap-2">
                    <Button
                        id={`${id}-test-button`}
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={props.pending}
                        aria-label={`${tested || error ? "重新测试模型" : "测试模型"} ${modelId || label}`}
                        aria-describedby={testing || rowResult || error ? `${id}-test-feedback` : undefined}
                        className={
                            tested
                                ? "border-success-border bg-success-soft text-success hover:bg-success-soft hover:text-success"
                                : undefined
                        }
                        onClick={() => props.onTest(model.id)}
                    >
                        {testing && <Loader2 className="animate-spin" aria-hidden="true" />}
                        {!testing && tested && <Check aria-hidden="true" />}
                        {testing ? "测试中…" : tested || error ? "重新测试" : "测试"}
                    </Button>
                    <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={props.pending}
                        aria-label={`移除模型 ${label}`}
                        onClick={() => props.onRemove(model.rowKey)}
                    >
                        <Trash2 aria-hidden="true" />
                    </Button>
                </div>
            </div>
            {(testing || rowResult || error) && (
                <div className="ml-auto w-full sm:max-w-xs">
                    <AiTestFeedback
                        id={`${id}-test-feedback`}
                        anchorId={props.activeTestModel === modelId ? `${id}-test-button` : undefined}
                        pending={testing}
                        result={rowResult}
                        error={error}
                    />
                </div>
            )}
        </div>
    )
}
