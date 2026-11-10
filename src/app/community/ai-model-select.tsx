import { useId } from "react"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { AiModelSelection } from "@/shared/ai-settings"
import { AI_PROVIDER_PRESETS } from "@/shared/ai-settings"
import type { useAiModelSelection } from "./use-ai-model-selection"

type Props = ReturnType<typeof useAiModelSelection> & { disabled?: boolean; onOpenSettings: () => void }

export function AiModelSelect({ providers, selection, setSelection, disabled = false, onOpenSettings }: Props) {
    const id = useId()
    const profiles = providers.data?.providers.filter((profile) => profile.configured) ?? []
    const active = profiles.find((profile) => profile.provider === providers.data?.activeProvider)
    const defaultLabel = active?.models.find((model) => model.id === active.defaultModel)?.label
    const selectedExists =
        !selection ||
        profiles.some(
            (profile) =>
                profile.provider === selection.provider && profile.models.some((model) => model.id === selection.modelId && model.enabled),
        )
    const encode = (value: AiModelSelection) => JSON.stringify(value)
    const options = profiles.flatMap((profile) =>
        profile.models
            .filter((model) => model.enabled)
            .map((model) => ({
                value: { provider: profile.provider, modelId: model.id },
                label: `${AI_PROVIDER_PRESETS[profile.provider].label} · ${model.label}${model.label === model.id ? "" : ` (${model.id})`}`,
            })),
    )
    return (
        <div className="grid min-w-0 gap-1.5">
            <label htmlFor={id} className="text-xs font-medium">
                生成模型
            </label>
            <NativeSelect
                id={id}
                className="w-full min-w-0"
                value={selection ? encode(selection) : ""}
                disabled={disabled || providers.isPending}
                aria-invalid={providers.data && !selectedExists}
                aria-describedby={`${id}-help`}
                onChange={(event) => setSelection(options.find((item) => encode(item.value) === event.target.value)?.value)}
            >
                <NativeSelectOption value="">
                    {providers.isPending
                        ? "正在读取模型…"
                        : active
                          ? `默认：${AI_PROVIDER_PRESETS[active.provider].label} · ${defaultLabel ?? active.defaultModel}`
                          : "使用默认模型"}
                </NativeSelectOption>
                {selection && !selectedExists && (
                    <NativeSelectOption value={encode(selection)} disabled>
                        所选模型已停用或移除
                    </NativeSelectOption>
                )}
                {options.map((option) => (
                    <NativeSelectOption key={encode(option.value)} value={encode(option.value)}>
                        {option.label}
                    </NativeSelectOption>
                ))}
            </NativeSelect>
            <div id={`${id}-help`} className="text-xs leading-5 text-muted-foreground">
                {providers.isError ? (
                    <span role="alert">
                        模型列表读取失败。
                        <Button
                            type="button"
                            size="xs"
                            variant="link"
                            disabled={providers.isFetching}
                            onClick={() => void providers.refetch()}
                        >
                            重试
                        </Button>
                    </span>
                ) : providers.data && !options.length ? (
                    <>
                        暂无可用模型。
                        <Button type="button" size="xs" variant="link" onClick={onOpenSettings}>
                            配置模型
                        </Button>
                    </>
                ) : !selectedExists && providers.data ? (
                    <span role="alert" className="text-destructive">
                        请重新选择已启用的模型。
                    </span>
                ) : (
                    "仅用于本次生成，不更改默认模型。"
                )}
            </div>
        </div>
    )
}
