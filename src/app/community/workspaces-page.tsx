import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Check, Loader2, RotateCcw } from "lucide-react"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { WorkspaceSplitView } from "@/components/workspace/workspace-split-view"
import { api, apiErrorMessage, getSources } from "@/services/community-api"
import type { LiveWorkspace } from "@/services/community-api"
import type { WorkspaceDocument } from "@/shared/workspace-schema"
import type { AiModelSelection } from "@/shared/ai-settings"
import { AiModelSelect } from "./ai-model-select"
import { useAiModelSelection } from "./use-ai-model-selection"
import { LiveAiSidebar } from "./ai-sidebar"
import type { AiMessage } from "./ai-sidebar"
import { CreateWorkspace } from "./create-workspace"
import { LiveSourcePicker } from "./source-picker"
import { WorkspaceCatalog } from "./workspace-catalog"
import { LiveWorkspaceComponents } from "./workspace-components"

export type LiveWorkspaceSelection = LiveWorkspace | "new" | null

export function LiveWorkspacesPage({
    selected,
    onSelect,
    onAddSource,
    onDirtyChange,
    onAiSettings,
}: {
    selected: LiveWorkspaceSelection
    onSelect: (selection: LiveWorkspaceSelection) => void
    onAddSource: () => void
    onDirtyChange: (dirty: boolean) => void
    onAiSettings: () => void
}) {
    if (selected === "new")
        return (
            <NewWorkspaceFlow
                onBack={() => onSelect(null)}
                onAddSource={onAddSource}
                onDirtyChange={onDirtyChange}
                onAiSettings={onAiSettings}
            />
        )
    if (selected)
        return (
            <WorkspaceEditor
                key={selected.id}
                initial={selected}
                onBack={() => onSelect(null)}
                onAddSource={onAddSource}
                onDirtyChange={onDirtyChange}
                onAiSettings={onAiSettings}
            />
        )
    return <WorkspaceCatalog onCreate={() => onSelect("new")} onOpen={onSelect} />
}

function NewWorkspaceFlow({
    onBack,
    onAddSource,
    onDirtyChange,
    onAiSettings,
}: {
    onBack: () => void
    onAddSource: () => void
    onDirtyChange: (dirty: boolean) => void
    onAiSettings: () => void
}) {
    const [generated, setGenerated] = useState<{ document: WorkspaceDocument; sourceIds: string[]; aiModel?: AiModelSelection } | null>(
        null,
    )
    if (!generated)
        return (
            <CreateWorkspace
                onCreated={(document, sourceIds, aiModel) => setGenerated({ document, sourceIds, aiModel })}
                onAddSource={onAddSource}
                onDirtyChange={onDirtyChange}
                onAiSettings={onAiSettings}
            />
        )
    return (
        <WorkspaceEditor
            initial={null}
            initialDocument={generated.document}
            initialSourceIds={generated.sourceIds}
            initialAiModel={generated.aiModel}
            onBack={onBack}
            onDiscardNew={() => setGenerated(null)}
            onAddSource={onAddSource}
            onDirtyChange={onDirtyChange}
            onAiSettings={onAiSettings}
        />
    )
}

function WorkspaceEditor({
    initial,
    initialDocument,
    initialSourceIds,
    initialAiModel,
    onBack,
    onDiscardNew,
    onAddSource,
    onDirtyChange,
    onAiSettings,
}: {
    initial: LiveWorkspace | null
    initialDocument?: WorkspaceDocument
    initialSourceIds?: string[]
    initialAiModel?: AiModelSelection
    onBack: () => void
    onDiscardNew?: () => void
    onAddSource: () => void
    onDirtyChange: (dirty: boolean) => void
    onAiSettings: () => void
}) {
    const aiModel = useAiModelSelection(initialAiModel)
    const client = useQueryClient()
    const sources = useQuery({ queryKey: ["live-sources"], queryFn: getSources })
    const [saved, setSaved] = useState(initial)
    const [draft, setDraft] = useState<WorkspaceDocument | null>(initial?.document ?? initialDocument ?? null)
    const [selectedSources, setSelectedSources] = useState<string[]>(
        initial ? [...new Set(initial.document.queries.map((query) => query.datasourceId))] : (initialSourceIds ?? []),
    )
    const [instruction, setInstruction] = useState("")
    const [pickerOpen, setPickerOpen] = useState(false)
    const [discardOpen, setDiscardOpen] = useState(false)
    const [messages, setMessages] = useState<AiMessage[]>([
        {
            role: "assistant",
            text: "工作台已生成。告诉我你想调整什么，我会先更新预览；保存后修改才会生效。",
        },
    ])
    const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved?.document ?? null)

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
        mutationFn: (text: string) =>
            api<{ document: WorkspaceDocument }>("/ai/generate", {
                method: "POST",
                body: {
                    instruction: text,
                    datasourceIds: selectedSources,
                    aiModel: aiModel.selection,
                    ...(draft ? { current: draft } : {}),
                },
            }),
        onSuccess: ({ document }) => {
            setDraft(document)
            setInstruction("")
            setMessages((current) => [...current, { role: "assistant", text: "工作台预览已更新，请检查后保存修改。" }])
        },
    })
    const save = useMutation({
        mutationFn: () =>
            saved
                ? api<LiveWorkspace>("/workspaces/" + saved.id, { method: "PUT", body: { revision: saved.revision, document: draft } })
                : api<LiveWorkspace>("/workspaces", { method: "POST", body: draft }),
        onSuccess: (workspace) => {
            setSaved(workspace)
            setDraft(workspace.document)
            void client.invalidateQueries({ queryKey: ["live-workspaces"] })
        },
    })
    const submit = () => {
        const text = instruction.trim()
        if (!text || !selectedSources.length || generate.isPending || save.isPending) return
        setMessages((current) => [...current, { role: "user", text }])
        generate.mutate(text)
    }
    const discard = () => {
        if (saved) setDraft(saved.document)
        else setDiscardOpen(true)
    }
    const sidebar = (
        <LiveAiSidebar
            messages={messages}
            instruction={instruction}
            sourceCount={selectedSources.length}
            pending={generate.isPending}
            disabled={save.isPending}
            modelControl={<AiModelSelect {...aiModel} disabled={generate.isPending || save.isPending} onOpenSettings={onAiSettings} />}
            error={generate.isError ? apiErrorMessage(generate.error, "生成修改失败，请稍后重试。") : null}
            onInstructionChange={(value) => {
                setInstruction(value)
                if (generate.isError) generate.reset()
            }}
            onChooseSources={() => setPickerOpen(true)}
            onSubmit={submit}
        />
    )

    return (
        <>
            <WorkspaceSplitView sidebar={sidebar} footer={null}>
                <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-5 pb-8 max-[700px]:px-4">
                    <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 border-b border-border bg-background px-2 py-3">
                        <Button type="button" variant="ghost" size="icon-sm" aria-label="返回工作台列表" onClick={onBack}>
                            <ArrowLeft aria-hidden="true" />
                        </Button>
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                            <h1 className="truncate text-card-title font-medium">{draft?.title ?? "创建工作台"}</h1>
                            {dirty && (
                                <Badge variant="outline" className="border-warning-border bg-warning-soft font-normal text-warning">
                                    未保存草稿
                                </Badge>
                            )}
                            <span className="text-caption text-muted-foreground">{selectedSources.length} 个数据源</span>
                        </div>
                        {dirty && (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={discard}
                                    disabled={save.isPending || generate.isPending}
                                >
                                    <RotateCcw aria-hidden="true" />
                                    放弃修改
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => save.mutate()}
                                    disabled={save.isPending || generate.isPending}
                                >
                                    {save.isPending ? (
                                        <Loader2 className="animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Check aria-hidden="true" />
                                    )}
                                    {save.isPending ? "保存中…" : saved ? "保存修改" : "保存工作台"}
                                </Button>
                            </>
                        )}
                    </div>
                    {save.isError && (
                        <p role="alert" className="pt-4 text-label text-destructive">
                            保存失败，工作台可能已在其他设备更新；请返回列表重新打开。
                        </p>
                    )}
                    {draft ? (
                        <LiveWorkspaceComponents document={draft} />
                    ) : (
                        <p className="py-8 text-label text-muted-foreground">工作台草稿不可用，请返回创建入口。</p>
                    )}
                </div>
            </WorkspaceSplitView>
            {pickerOpen && (
                <LiveSourcePicker
                    sources={sources.data ?? []}
                    selectedIds={selectedSources}
                    onClose={() => setPickerOpen(false)}
                    onConfirm={setSelectedSources}
                    onAdd={onAddSource}
                />
            )}
            <ConfirmDialog
                open={discardOpen}
                onOpenChange={setDiscardOpen}
                title="放弃这次生成的工作台？"
                description="当前草稿和对话会被丢弃，已保存的工作台不受影响。"
                confirmLabel="放弃修改"
                cancelLabel="继续编辑"
                onConfirm={() => {
                    setDiscardOpen(false)
                    onDiscardNew?.()
                }}
            />
        </>
    )
}
