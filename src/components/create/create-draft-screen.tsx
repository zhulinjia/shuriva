import { ArrowLeft, Check, Database, Loader2, Lock, RotateCcw } from "lucide-react"
import { useEffect, useState } from "react"
import type { Datasource, Workspace, WorkspaceConfig } from "@/services"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { WorkspaceSplitView } from "@/components/workspace/workspace-split-view"
import { DraftChat } from "./draft-chat"
import { StructuralPreview } from "./structural-preview"

type CreateDraftScreenProps = {
  draft: Workspace
  datasources: readonly Datasource[]
  titleError: boolean
  saveError: string | null
  saving: boolean
  onTitleChange: (title: string) => void
  onConfigChange: (patch: Partial<WorkspaceConfig>) => void
  onOpenBindings: () => void
  onOpenSourcePicker: () => void
  onAddSource: () => void
  onDraftChange: (draft: Workspace) => void
  onSave: () => void
  onDiscard: () => void
  onExit: () => void
}

export function CreateDraftScreen({ draft, datasources, titleError, saveError, saving, onTitleChange, onConfigChange, onOpenBindings, onOpenSourcePicker, onAddSource, onDraftChange, onSave, onDiscard, onExit }: CreateDraftScreenProps) {
  const [discardOpen, setDiscardOpen] = useState(false)
  const [exitOpen, setExitOpen] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  return (
    <>
      <WorkspaceSplitView sidebar={<DraftChat draft={draft} datasources={datasources} onDraftChange={onDraftChange} onOpenBindings={onOpenBindings} onRunningChange={setGenerating} readOnly={saving} readOnlyMessage="正在保存，请稍候。" />}>
        <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-5 pb-8 max-[700px]:px-4">
          <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 border-b border-border bg-background px-2 py-3">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="返回创建入口" onClick={() => setExitOpen(true)}><ArrowLeft aria-hidden="true" /></Button>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2"><span className="truncate text-card-title font-medium">{draft.title.trim() || "未命名工作台"}</span><Badge variant="outline" className="border-warning-border bg-warning-soft font-normal text-warning">未保存草稿</Badge><span className="text-caption text-muted-foreground">{draft.datasourceIds.length} 个数据源</span></div>
            <Button type="button" variant="outline" size="sm" onClick={() => setDiscardOpen(true)} disabled={saving}><RotateCcw aria-hidden="true" />放弃修改</Button>
            <Button type="button" size="sm" onClick={onSave} disabled={saving || generating}>{saving ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check aria-hidden="true" />}{saving ? "保存中…" : "保存工作台"}</Button>
          </div>
          {saveError ? <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-label text-destructive"><span className="min-w-0 flex-1">{saveError}</span><Button type="button" variant="outline" size="xs" onClick={onOpenBindings}>检查数据与模块</Button></div> : null}
          <div className="mt-4"><StructuralPreview draft={draft} datasources={datasources} titleError={titleError} onTitleChange={onTitleChange} onConfigChange={onConfigChange} onOpenBindings={onOpenBindings} onAddSource={onAddSource} /></div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-caption text-muted-foreground"><Lock className="size-3.5 shrink-0" aria-hidden="true" /><p className="min-w-0 flex-1">这是本地 Mock 草稿，不连接真实数据库；正式权限与查询限制必须由可信服务端执行。</p><Button type="button" variant="ghost" size="xs" onClick={onOpenSourcePicker}><Database aria-hidden="true" />数据源</Button></div>
        </div>
      </WorkspaceSplitView>
      <ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen} title="放弃这次生成的工作台？" description="当前草稿和对话会被丢弃，已保存的工作台不受影响。" confirmLabel="放弃修改" cancelLabel="继续编辑" onConfirm={() => { setDiscardOpen(false); onDiscard() }} />
      <ConfirmDialog open={exitOpen} onOpenChange={setExitOpen} title="离开当前草稿？" description="当前草稿尚未保存，离开后需要重新生成。" confirmLabel="离开并丢弃草稿" cancelLabel="继续编辑" onConfirm={() => { setExitOpen(false); onExit() }} />
    </>
  )
}
