import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CreateEntry } from "@/components/create/create-entry"
import type { CreateFeedback } from "@/components/create/create-entry"
import { api, apiErrorMessage, getSources } from "@/services/community-api"
import type { WorkspaceDocument } from "@/shared/workspace-schema"
import type { AiModelSelection } from "@/shared/ai-settings"
import { AiModelSelect } from "./ai-model-select"
import { useAiModelSelection } from "./use-ai-model-selection"
import { engineName } from "./source-display"
import { LiveSourcePicker } from "./source-picker"

export function CreateWorkspace({
    onCreated,
    onAddSource,
    onDirtyChange,
    onAiSettings,
}: {
    onCreated: (document: WorkspaceDocument, datasourceIds: string[], aiModel?: AiModelSelection) => void
    onAddSource: () => void
    onDirtyChange: (dirty: boolean) => void
    onAiSettings: () => void
}) {
    const aiModel = useAiModelSelection()
    const sources = useQuery({ queryKey: ["live-sources"], queryFn: getSources })
    const [prompt, setPrompt] = useState("")
    const [selectedIds, setSelectedIds] = useState<string[]>([])
    const [pickerOpen, setPickerOpen] = useState(false)
    const [feedback, setFeedback] = useState<CreateFeedback | null>(null)
    const promptRef = useRef<HTMLTextAreaElement>(null)
    const entries = (sources.data ?? []).map((source) => ({ id: source.id, engine: engineName[source.engine] }))
    const selected = entries.filter((source) => selectedIds.includes(source.id))
    const dirty = prompt.trim().length > 0

    useEffect(() => {
        onDirtyChange(dirty)
        return () => onDirtyChange(false)
    }, [dirty, onDirtyChange])
    useEffect(() => {
        if (!dirty) return
        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault()
            event.returnValue = ""
        }
        window.addEventListener("beforeunload", warn)
        return () => window.removeEventListener("beforeunload", warn)
    }, [dirty])

    const generate = useMutation({
        mutationFn: () =>
            api<{ document: WorkspaceDocument }>("/ai/generate", {
                method: "POST",
                body: { instruction: prompt.trim(), datasourceIds: selectedIds, aiModel: aiModel.selection },
            }),
        onSuccess: ({ document }) => onCreated(document, selectedIds, aiModel.selection),
        onError: (error) => setFeedback({ action: null, message: `${apiErrorMessage(error, "生成失败，请稍后重试。")} 当前输入已保留。` }),
    })
    const submit = () => {
        if (!prompt.trim()) {
            setFeedback({ action: "prompt", message: "先描述你想完成的业务任务，再开始构建。" })
            promptRef.current?.focus()
            return
        }
        if (sources.isError) {
            setFeedback({ action: null, message: "数据源读取失败，请刷新页面或检查服务连接。" })
            return
        }
        if (!selected.length) {
            setFeedback({
                action: entries.length ? "sources" : "add",
                message: entries.length ? "请选择生成工作台要使用的数据源。" : "请先添加数据源，再开始构建。",
            })
            return
        }
        setFeedback(null)
        generate.mutate()
    }
    return (
        <>
            <CreateEntry
                prompt={prompt}
                onPromptChange={(value) => {
                    setPrompt(value)
                    if (feedback) setFeedback(null)
                }}
                promptRef={promptRef}
                selectedSources={selected}
                allSources={entries}
                feedback={feedback}
                generating={generate.isPending}
                modelControl={<AiModelSelect {...aiModel} disabled={generate.isPending} onOpenSettings={onAiSettings} />}
                onOpenSources={() => {
                    if (!sources.isPending) setPickerOpen(true)
                }}
                onAddSource={onAddSource}
                onSubmit={submit}
                onExample={(value) => {
                    setPrompt(value)
                    setFeedback(null)
                    promptRef.current?.focus()
                }}
                contextNote="生成时会向 AI 服务发送你的需求及所选数据源的表、字段结构；当前不发送记录样本。"
            />
            {pickerOpen && (
                <LiveSourcePicker
                    sources={sources.data ?? []}
                    selectedIds={selectedIds}
                    onClose={() => setPickerOpen(false)}
                    onConfirm={(ids) => {
                        setSelectedIds(ids)
                        setFeedback(null)
                    }}
                    onAdd={onAddSource}
                />
            )}
        </>
    )
}
