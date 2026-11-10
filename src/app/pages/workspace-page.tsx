import { ArrowLeft, Info, Loader2, Lock, RefreshCw, RotateCcw, Save } from "lucide-react"
import { useEffect, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import { Link, useBlocker, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { useDatasourceActions, useWorkspaceActions, useWorkspaceScreen, workspaceScreenQueryKey } from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import { previewRoleLabel } from "@/lib/roles"
import { BINDING_LABELS, findMissingBindings } from "@/lib/workspace-draft"
import { buildWorkspaceDataset } from "@/services"
import type { PreviewRole, Workspace, WorkspaceScreen } from "@/services"
import { PageContainer } from "@/components/layout/page-container"
import { WorkspaceRenderer } from "@/components/workspace/workspace-renderer"
import { WorkspaceAiSidebar } from "@/components/workspace/workspace-ai-sidebar"
import { WorkspaceSplitView } from "@/components/workspace/workspace-split-view"
import { DraftBindingsDialog } from "@/components/create/draft-bindings-dialog"
import { SourcePickerDialog } from "@/components/datasources/source-picker-dialog"
import { DataNotesDialog } from "@/components/workspace/workspace-info-dialogs"
import { EngineMark } from "@/components/datasources/engine-mark"
import { Notice } from "@/components/common/notice"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

function workspaceSignature(workspace: Workspace) {
  return JSON.stringify({
    title: workspace.title, description: workspace.description, kind: workspace.kind,
    datasourceIds: workspace.datasourceIds, bindings: workspace.bindings, config: workspace.config,
  })
}

export function WorkspacePage() {
  const { workspaceId } = useParams()
  return <WorkspaceRoute key={workspaceId} workspaceId={workspaceId} />
}

function WorkspaceRoute({ workspaceId }: { workspaceId: string | undefined }) {
  const edition = useDemoStore((state) => state.edition)
  const previewRole = useDemoStore((state) => state.previewRole)
  const role = edition === "team" ? previewRole : "owner"
  const screen = useWorkspaceScreen(workspaceId, role)
  const datasourceActions = useDatasourceActions()
  // Role previews refetch and remount the view; keep the owner's draft here.
  const [draft, setDraft] = useState<Workspace | null>(null)

  if (screen.isPending) return <PageContainer title="正在加载工作台" description="读取本地模拟数据。"><div aria-busy="true" className="grid gap-3"><Skeleton className="h-7 w-56" /><Skeleton className="h-20 w-full rounded-lg" /><Skeleton className="h-[420px] w-full rounded-lg" /></div></PageContainer>
  if (screen.isError) return <PageContainer title="工作台读取失败" description="本地模拟服务没有返回数据。已保存的工作台不会受影响。"><Button type="button" onClick={() => void screen.refetch()}><RefreshCw aria-hidden="true" />重试</Button></PageContainer>
  if (!screen.data) return <PageContainer title="工作台不存在" description="它可能已在本地演示数据中被删除。"><Button variant="outline" nativeButton={false} render={<Link to="/workspaces" />}><ArrowLeft aria-hidden="true" />返回工作台目录</Button></PageContainer>

  return <WorkspaceView key={screen.data.workspace.id} data={screen.data} role={role} previewRole={previewRole} draft={draft} setDraft={setDraft} isFetching={screen.isFetching} onRefresh={() => void screen.refetch()}
    restoringSourceId={datasourceActions.setStatus.isPending ? (datasourceActions.setStatus.variables?.id ?? null) : null}
    onRestoreSource={(sourceId) => datasourceActions.setStatus.mutate({ id: sourceId, status: "connected" })} />
}

function WorkspaceView({ data, role, previewRole, draft, setDraft, isFetching, onRefresh, restoringSourceId, onRestoreSource }: {
  data: WorkspaceScreen
  role: PreviewRole
  previewRole: PreviewRole
  draft: Workspace | null
  setDraft: Dispatch<SetStateAction<Workspace | null>>
  isFetching: boolean
  onRefresh: () => void
  restoringSourceId: string | null
  onRestoreSource: (sourceId: string) => void
}) {
  const { workspace, datasources, dataset } = data
  const canEdit = role === "owner"
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const actions = useWorkspaceActions()
  const [notesOpen, setNotesOpen] = useState(false)
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const [editBindingsOpen, setEditBindingsOpen] = useState(false)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [draftSaving, setDraftSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const draftDirty = draft ? workspaceSignature(draft) !== workspaceSignature(workspace) : false
  const activeWorkspace = canEdit && draft ? draft : workspace
  const activeDataset = canEdit && draft ? buildWorkspaceDataset(draft, datasources, role) : dataset
  const blocker = useBlocker(({ currentLocation, nextLocation }) => draftDirty && currentLocation.pathname !== nextLocation.pathname)

  useEffect(() => {
    if (!draftDirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [draftDirty])

  const discardDraft = () => {
    setDraft(null)
    setDraftError(null)
    setDiscardOpen(false)
  }
  const saveDraft = async () => {
    if (!draft || !draftDirty || draftSaving || generating || !canEdit) return
    const missing = findMissingBindings(draft, datasources)
    if (missing.length) {
      setDraftError(`请先为${missing.map((key) => `「${BINDING_LABELS[key]}」`).join("、")}绑定兼容的数据源。`)
      setEditBindingsOpen(true)
      return
    }
    setDraftSaving(true)
    setDraftError(null)
    try {
      const saved = await actions.save.mutateAsync(draft)
      queryClient.setQueryData<WorkspaceScreen>(workspaceScreenQueryKey(saved.id, role), {
        workspace: saved, datasources, dataset: buildWorkspaceDataset(saved, datasources, role),
      })
      setDraft(null)
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "保存失败，草稿仍然保留。请检查后重试。")
    } finally {
      setDraftSaving(false)
    }
  }

  const sidebar = <WorkspaceAiSidebar draft={activeWorkspace} datasources={datasources} saving={draftSaving} canEdit={canEdit} onGeneratingChange={setGenerating}
    onDraftChange={(next) => { if (canEdit && !draftSaving) { setDraft(next); setDraftError(null) } }}
    onOpenBindings={() => setBindingsOpen(true)} />
  const boundSources = datasources.filter((source) => activeWorkspace.datasourceIds.includes(source.id))

  return (
    <>
      <WorkspaceSplitView sidebar={sidebar}>
        <header className="workspace-toolbar sticky top-0 z-20 border-b border-border bg-background">
          <div className="mx-auto w-full max-w-(--spacing-page) px-6 py-3 max-[980px]:px-5 max-[700px]:px-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="line-clamp-2 min-w-0 max-w-full text-page-title font-semibold break-all text-foreground" title={workspace.title}>{workspace.title}</h1>
                <span role="status" aria-live="polite" className="flex flex-wrap items-center gap-2">
                  {canEdit && draftDirty ? (
                    <Badge variant="outline" className="border-warning-border bg-warning-soft font-normal text-warning">未保存草稿</Badge>
                  ) : (
                    <Badge variant="outline" className="border-success-border bg-success-soft font-normal text-success">已保存</Badge>
                  )}
                  {generating ? <span className="text-caption text-muted-foreground">AI 正在修改…</span> : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}><RefreshCw className={isFetching ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden="true" />刷新</Button>
                {canEdit && draftDirty ? (
                  <>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDiscardOpen(true)} disabled={draftSaving || generating}><RotateCcw aria-hidden="true" />放弃修改</Button>
                    <Button type="button" size="sm" onClick={() => void saveDraft()} disabled={draftSaving || generating}>
                      {draftSaving ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save aria-hidden="true" />}
                      {draftSaving ? "正在保存…" : "保存修改"}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            {draftError ? <p role="alert" className="mt-2 text-caption text-destructive">{draftError}</p> : null}
          </div>
        </header>
        <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-4 pb-10 max-[980px]:px-5 max-[700px]:px-4">
          {workspace.description ? <p className="mb-5 max-w-3xl text-body text-muted-foreground">{workspace.description}</p> : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-label text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1.5">{boundSources.map((source) => <span key={source.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-caption text-foreground"><EngineMark engine={source.engine} size="sm" />{source.name}</span>)}</div>
            <span className="inline-flex items-center gap-1"><Lock className="size-3.5" aria-hidden="true" />只读</span>
            <span className="tabular-nums">v{workspace.version}</span>
            {dataset.policy ? <Badge variant="outline" className="gap-1 border-warning-border bg-warning-soft font-normal text-warning">{dataset.policy.label} · 演示策略</Badge> : null}
            <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setNotesOpen(true)}><Info aria-hidden="true" />数据说明</Button>
          </div>
          {!canEdit ? <div className="mt-3"><Notice tone="warning">当前为「{previewRoleLabel(previewRole)}」权限预览，工作台只读。字段脱敏与记录范围由本地模拟策略决定，不是服务端授权实现。</Notice></div> : null}
          <div className="mt-4">
            <WorkspaceRenderer workspace={activeWorkspace} datasources={datasources} dataset={activeDataset}
              onEditBindings={canEdit ? () => setEditBindingsOpen(true) : undefined}
              bindingsControl={{ open: bindingsOpen, onOpenChange: setBindingsOpen }} restoringSourceId={restoringSourceId} onRestoreSource={onRestoreSource} />
          </div>
        </div>
      </WorkspaceSplitView>
      <ConfirmDialog open={discardOpen} onOpenChange={setDiscardOpen} title="放弃未保存的修改？" description="工作台会恢复到已保存版本，本次 AI 修改和绑定调整都不会保留。" confirmLabel="放弃修改" onConfirm={discardDraft} />
      <ConfirmDialog open={blocker.state === "blocked"} onOpenChange={(open) => { if (!open && blocker.state === "blocked") blocker.reset() }} title="离开未保存的草稿？" description="离开后本次 AI 修改和绑定调整不会保留，已保存的工作台不会受影响。" confirmLabel="离开并放弃" onConfirm={() => { if (blocker.state === "blocked") blocker.proceed() }} />
      {canEdit ? <DraftBindingsDialog open={editBindingsOpen} onOpenChange={setEditBindingsOpen} draft={activeWorkspace} datasources={datasources}
        onBindingChange={(key, sourceId) => { setDraft((current) => ({ ...(current ?? workspace), bindings: { ...(current ?? workspace).bindings, [key]: sourceId } })); setDraftError(null) }}
        onOpenSourcePicker={() => { setEditBindingsOpen(false); setSourcePickerOpen(true) }} onAddSource={() => navigate("/datasources")} /> : null}
      {canEdit ? <SourcePickerDialog open={sourcePickerOpen} onOpenChange={(open) => { setSourcePickerOpen(open); if (!open) setEditBindingsOpen(true) }} datasources={datasources} selectedIds={activeWorkspace.datasourceIds}
        onConfirm={(ids) => setDraft((current) => {
          const base = current ?? workspace
          const bindings = { ...base.bindings }
          for (const key of Object.keys(bindings) as (keyof typeof bindings)[]) {
            if (bindings[key] && !ids.includes(bindings[key]!)) delete bindings[key]
          }
          return { ...base, datasourceIds: ids, bindings }
        })} onAdd={() => navigate("/datasources")} /> : null}
      <DataNotesDialog open={notesOpen} onOpenChange={setNotesOpen} workspace={workspace} datasources={datasources} policy={dataset.policy} />
    </>
  )
}
