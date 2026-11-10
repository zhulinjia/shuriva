import { ArrowLeft, Lock } from "lucide-react"
import { useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import type {
  BindingKey,
  Datasource,
  DatasourceInput,
  Workspace,
  WorkspaceConfig,
  WorkspaceKind,
} from "@/services"
import {
  useDatasourceActions,
  useDatasources,
  useWorkspaceActions,
} from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import {
  BINDING_LABELS,
  buildNewDraft,
  findMissingBindings,
  reconcileWorkspaceSources,
  resolveCreationKind,
} from "@/lib/workspace-draft"
import { PageContainer } from "@/components/layout/page-container"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DatasourceFormDialog } from "@/components/datasources/datasource-form-dialog"
import { SourcePickerDialog } from "@/components/datasources/source-picker-dialog"
import { CreateDraftScreen } from "@/components/create/create-draft-screen"
import { CreateEntry } from "@/components/create/create-entry"
import type { CreateFeedback } from "@/components/create/create-entry"
import { DraftBindingsDialog } from "@/components/create/draft-bindings-dialog"
import { GenerationProgress } from "@/components/create/generation-progress"

export function CreatePage() {
  const datasources = useDatasources()
  const edition = useDemoStore((state) => state.edition)
  const previewRole = useDemoStore((state) => state.previewRole)
  const canCreate = edition !== "team" || previewRole === "owner"

  if (datasources.isPending) {
    return (
      <PageContainer
        title="正在准备创建入口"
        description="读取当前工作区中的数据源。"
      >
        <div aria-busy="true" className="grid gap-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-52 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      </PageContainer>
    )
  }

  if (datasources.isError) {
    return (
      <PageContainer
        title="创建入口加载失败"
        description="本地模拟服务没有返回数据源。"
      >
        <Button type="button" onClick={() => void datasources.refetch()}>
          重试
        </Button>
      </PageContainer>
    )
  }

  if (!canCreate) {
    return (
      <PageContainer
        title="当前预览角色不能创建工作台"
        description="成员权限预览只展示可见结果，不提供工作台创建能力。"
      >
        <Notice tone="warning">
          你正在以普通成员身份预览。请先在页面顶部的权限预览栏切回「数据管理员」，再创建工作台。
        </Notice>
        <Button
          className="mt-3"
          variant="outline"
          nativeButton={false}
          render={<Link to="/workspaces" />}
        >
          <ArrowLeft aria-hidden="true" />
          返回工作台目录
        </Button>
      </PageContainer>
    )
  }

  return (
    <CreateFlow
      key={`${edition}:${previewRole}`}
      datasources={datasources.data}
    />
  )
}

type CreateFlowProps = {
  datasources: Datasource[]
}

type Phase = "entry" | "generating" | "draft"

export function CreateFlow({ datasources }: CreateFlowProps) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const workspaceActions = useWorkspaceActions()
  const datasourceActions = useDatasourceActions()

  const [phase, setPhase] = useState<Phase>("entry")
  const [prompt, setPrompt] = useState(
    () => searchParams.get("prompt")?.trim() ?? ""
  )
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const initialSources = searchParams
      .get("sources")
      ?.split(",")
      .filter(Boolean)

    if (initialSources && initialSources.length > 0) {
      return initialSources.filter((id) =>
        datasources.some((source) => source.id === id)
      )
    }
    return datasources
      .filter((source) => source.status === "connected")
      .map((source) => source.id)
  })
  const [feedback, setFeedback] = useState<CreateFeedback | null>(null)
  const [draft, setDraft] = useState<Workspace | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [titleError, setTitleError] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const promptRef = useRef<HTMLTextAreaElement>(null)
  const resolvedKindRef = useRef<WorkspaceKind | null>(null)

  const allowedSources = selectedIds
    .map((id) => datasources.find((source) => source.id === id))
    .filter((source): source is Datasource => Boolean(source))

  const applySourceIds = (ids: string[]) => {
    setSelectedIds(ids)
    setDraft((current) =>
      current ? reconcileWorkspaceSources(current, ids, datasources) : current
    )
    setSaveError(null)
    if (ids.length > 0) setFeedback(null)
  }

  const openSourcePicker = () => {
    setFeedback(null)
    setPickerOpen(true)
  }

  const openAddSource = () => {
    setPickerOpen(false)
    setAddError(null)
    setFormOpen(true)
  }

  const startGeneration = () => {
    const text = prompt.trim()

    if (!text) {
      setFeedback({
        message: "先描述你想完成的业务任务，再开始构建。AI 需要知道你要管理什么业务。",
        action: "prompt",
      })
      promptRef.current?.focus()
      return
    }

    if (selectedIds.length === 0) {
      const message =
        datasources.length > 0
          ? "还没有选择数据源。请选择包含订单或客户表的数据库，AI 才能规划查询结构。"
          : "还没有数据源。先添加一个数据库连接，再创建工作台。"
      setFeedback({ message, action: datasources.length > 0 ? "sources" : "add" })
      if (datasources.length > 0) setPickerOpen(true)
      else openAddSource()
      return
    }

    const resolved = resolveCreationKind(text, selectedIds, datasources)
    if (!resolved.kind) {
      setFeedback({ message: resolved.problem, action: "sources" })
      setPickerOpen(true)
      return
    }

    resolvedKindRef.current = resolved.kind
    setFeedback(null)
    setPhase("generating")
  }

  const finishGeneration = () => {
    const kind = resolvedKindRef.current
    if (!kind) {
      setPhase("entry")
      return
    }

    setDraft(buildNewDraft(kind, selectedIds, datasources))
    setTitleError(false)
    setSaveError(null)
    setPhase("draft")
  }

  const cancelGeneration = () => {
    resolvedKindRef.current = null
    setPhase("entry")
  }

  const updateTitle = (title: string) => {
    setDraft((current) => (current ? { ...current, title } : current))
    setTitleError(false)
    setSaveError(null)
  }

  const updateConfig = (patch: Partial<WorkspaceConfig>) => {
    setDraft((current) =>
      current
        ? { ...current, config: { ...current.config, ...patch } }
        : current
    )
    setSaveError(null)
  }

  const changeBinding = (key: BindingKey, sourceId: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            bindings: { ...current.bindings, [key]: sourceId },
          }
        : current
    )
    setSaveError(null)
  }

  const handleDraftChange = (next: Workspace) => {
    setDraft(next)
    setSaveError(null)
  }

  const save = async () => {
    if (!draft || saving) return
    const title = draft.title.trim()

    if (!title) {
      setTitleError(true)
      setSaveError("工作台名称不能为空，请填写名称后保存。")
      return
    }

    const missing = findMissingBindings(draft, datasources)
    if (missing.length > 0) {
      setSaveError(
        `请先为${missing
          .map((key) => `「${BINDING_LABELS[key]}」`)
          .join("、")}绑定兼容的数据源，再保存工作台。`
      )
      setBindingsOpen(true)
      return
    }

    setTitleError(false)
    setSaveError(null)
    setSaving(true)
    try {
      const saved = await workspaceActions.save.mutateAsync({
        ...draft,
        title,
      })
      navigate(`/workspaces/${saved.id}`, { replace: true })
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请重试。已保存的工作台没有被修改。")
    } finally {
      setSaving(false)
    }
  }

  const resetToEntry = () => {
    setDraft(null)
    setTitleError(false)
    setSaveError(null)
    setBindingsOpen(false)
    setPhase("entry")
  }

  const addDatasource = async (input: DatasourceInput) => {
    setAddError(null)
    try {
      const created = await datasourceActions.add.mutateAsync(input)
      setFormOpen(false)
      applySourceIds([...new Set([...selectedIds, created.id])])
      setPickerOpen(true)
    } catch {
      setAddError("添加数据源失败，请重试。")
    }
  }

  return (
    <>
      {phase === "entry" ? (
        <CreateEntry
          prompt={prompt}
          onPromptChange={(value) => {
            setPrompt(value)
            if (feedback?.action === "prompt") setFeedback(null)
          }}
          promptRef={promptRef}
          selectedSources={allowedSources}
          allSources={datasources}
          feedback={feedback}
          onOpenSources={openSourcePicker}
          onAddSource={openAddSource}
          onSubmit={startGeneration}
          onExample={(value) => {
            setPrompt(value)
            setFeedback(null)
            promptRef.current?.focus()
          }}
        />
      ) : null}

      {phase === "generating" ? (
        <GenerationProgress
          prompt={prompt.trim()}
          sourceCount={selectedIds.length}
          onComplete={finishGeneration}
          onCancel={cancelGeneration}
        />
      ) : null}

      {phase === "draft" && draft ? (
        <CreateDraftScreen
          draft={draft}
          datasources={datasources}
          titleError={titleError}
          saveError={saveError}
          saving={saving}
          onTitleChange={updateTitle}
          onConfigChange={updateConfig}
          onOpenBindings={() => setBindingsOpen(true)}
          onOpenSourcePicker={openSourcePicker}
          onAddSource={openAddSource}
          onDraftChange={handleDraftChange}
          onSave={() => void save()}
          onDiscard={resetToEntry}
          onExit={resetToEntry}
        />
      ) : null}

      <SourcePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        datasources={datasources}
        selectedIds={selectedIds}
        onConfirm={applySourceIds}
        onAdd={openAddSource}
        title="选择工作台数据源"
        description="可选择多个来源。每个模块独立查询；不执行任意跨库 JOIN。"
        note="当前为 Mock：这里只记录选择范围，不会连接数据库。移除正在使用的来源后，对应模块会变为未绑定，不会自动切换到其他数据库。"
      />

      <DatasourceFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setAddError(null)
        }}
        pending={datasourceActions.add.isPending}
        submitError={addError}
        onSubmit={(input) => void addDatasource(input)}
      />

      {draft ? (
        <DraftBindingsDialog
          open={bindingsOpen}
          onOpenChange={setBindingsOpen}
          draft={draft}
          datasources={datasources}
          onBindingChange={changeBinding}
          onOpenSourcePicker={openSourcePicker}
          onAddSource={openAddSource}
        />
      ) : null}

      {phase !== "draft" ? (
        <p className="mx-auto flex w-full max-w-(--spacing-page) items-start gap-1.5 px-6 pb-8 text-caption leading-relaxed text-muted-foreground max-[980px]:px-5 max-[700px]:px-4">
          <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          创建流程与 AI 回复均为本地 Mock。数据库凭证、真实查询、字段权限和行级权限必须由可信服务端实现与验证。
        </p>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {phase === "generating"
          ? "正在生成工作台结构。"
          : phase === "draft"
            ? "工作台草稿已生成，尚未执行任何查询。"
            : ""}
      </div>
    </>
  )
}
