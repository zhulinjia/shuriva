import {
  ArrowLeft,
  ArrowRight,
  ChartColumn,
  Check,
  Database,
  Info,
  Link2,
  Loader2,
  Lock,
  Plus,
  Send,
  Sparkles,
  Table2,
  Users,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import {
  buildWorkspaceDataset,
  getBindingDomain,
  isBindingCompatible,
} from "@/services"
import type {
  BindingKey,
  Datasource,
  Workspace,
  WorkspaceKind,
} from "@/services"
import {
  useDatasources,
  useWorkspaceActions,
  useWorkspaces,
} from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import {
  BINDING_LABELS,
  buildNewDraft,
  requiredBindings,
} from "@/lib/workspace-draft"
import { cn } from "@/lib/utils"
import { PageContainer } from "@/components/layout/page-container"
import { WorkspaceRenderer } from "@/components/workspace/workspace-renderer"
import { WorkspaceSplitView } from "@/components/workspace/workspace-split-view"
import { DataNotesDialog } from "@/components/workspace/workspace-info-dialogs"
import { SourcePickerDialog } from "@/components/datasources/source-picker-dialog"
import { EngineMark } from "@/components/datasources/engine-mark"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Notice } from "@/components/common/notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const BINDING_ICONS = {
  orders: Table2,
  profile: Users,
  activity: ChartColumn,
} as const

const BINDING_HINTS: Record<BindingKey, string> = {
  orders: "orders · 按 customer_id 筛选",
  profile: "customers · id → customer_id",
  activity: "user_events · user_id → customer_id",
}

type Message = {
  role: "user" | "assistant"
  text: string
  changes?: string[]
}

const DRAFT_KEY_PREFIX = "shuriva-editor-draft-v1:"

function readStoredDraft(original: Workspace): Workspace | null {
  try {
    const raw = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}${original.id}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const candidate = parsed as Workspace
    if (
      candidate.id !== original.id ||
      candidate.kind !== original.kind ||
      typeof candidate.title !== "string" ||
      !candidate.bindings ||
      !candidate.config ||
      !Array.isArray(candidate.datasourceIds)
    ) {
      return null
    }
    return candidate
  } catch {
    return null
  }
}

function initialMessages(original: Workspace | null, prompt: string): Message[] {
  const messages: Message[] = []
  if (prompt) messages.push({ role: "user", text: prompt })
  messages.push({
    role: "assistant",
    text: original
      ? "可以继续描述你希望怎样调整这个工作台。修改会先进入草稿，保存后才影响正式界面。"
      : "已使用预设模板生成草稿。每个模块单独绑定数据源，你可以在「数据与模块」中检查来源。",
    changes: original
      ? undefined
      : [
          "订单查询、客户查询与行为查询分别执行",
          "客户联动使用已确认的 customer_id 映射",
          "所有查询和 AI 响应均为本地模拟",
        ],
  })
  return messages
}

export function EditorPage() {
  const { workspaceId } = useParams()
  const [searchParams] = useSearchParams()
  const workspaces = useWorkspaces()
  const datasources = useDatasources()

  const queryWorkspaceId = workspaceId ?? searchParams.get("workspace")
  const prompt = searchParams.get("prompt") ?? ""
  const kindParam = searchParams.get("kind")
  const kind: WorkspaceKind =
    kindParam === "orders" || kindParam === "members" || kindParam === "customer"
      ? kindParam
      : "customer"
  const sourcesParam = searchParams.get("sources")
  const allowedIds = sourcesParam
    ? sourcesParam.split(",").filter(Boolean)
    : undefined

  if (workspaces.isPending || datasources.isPending) {
    return (
      <PageContainer title="正在准备编辑器" description="读取本地模拟数据。">
        <div aria-busy="true" className="grid gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-[420px] w-full rounded-lg" />
        </div>
      </PageContainer>
    )
  }

  if (workspaces.isError || datasources.isError) {
    return (
      <PageContainer
        title="编辑器加载失败"
        description="本地模拟服务没有返回工作台或数据源。"
      >
        <Button
          type="button"
          onClick={() => {
            void workspaces.refetch()
            void datasources.refetch()
          }}
        >
          重试
        </Button>
      </PageContainer>
    )
  }

  const original = queryWorkspaceId
    ? workspaces.data.find((workspace) => workspace.id === queryWorkspaceId)
    : undefined

  if (queryWorkspaceId && !original) {
    return (
      <PageContainer
        title="工作台不存在"
        description="无法基于一个已删除的工作台创建草稿。"
      >
        <Button
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
    <EditorScreen
      key={queryWorkspaceId ?? `new:${prompt}:${kind}:${sourcesParam ?? ""}`}
      original={original}
      datasources={datasources.data}
      allowedIds={allowedIds}
      prompt={prompt}
      kind={kind}
    />
  )
}

type EditorScreenProps = {
  original: Workspace | undefined
  datasources: Datasource[]
  allowedIds: string[] | undefined
  prompt: string
  kind: WorkspaceKind
}

function EditorScreen({
  original,
  datasources,
  allowedIds,
  prompt,
  kind,
}: EditorScreenProps) {
  const navigate = useNavigate()
  const edition = useDemoStore((state) => state.edition)
  const previewRole = useDemoStore((state) => state.previewRole)
  const canEdit = edition !== "team" || previewRole === "owner"
  const actions = useWorkspaceActions()

  const [draft, setDraft] = useState<Workspace>(() => {
    if (original) return readStoredDraft(original) ?? structuredClone(original)
    const ids =
      allowedIds?.filter((id) =>
        datasources.some((source) => source.id === id)
      ) ??
      datasources
        .filter((source) => source.status === "connected")
        .map((source) => source.id)
    return buildNewDraft(kind, ids, datasources)
  })
  const [restoredDraft] = useState(
    () => Boolean(original && readStoredDraft(original))
  )
  const [messages, setMessages] = useState<Message[]>(() =>
    initialMessages(original ?? null, prompt)
  )
  const [input, setInput] = useState("")
  const [tab, setTab] = useState<"chat" | "data">("chat")
  const [generating, setGenerating] = useState(false)
  const generationTimer = useRef<number | null>(null)
  const generationToken = useRef(0)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  const dirty =
    !original || JSON.stringify(draft) !== JSON.stringify(original)
  const workspaceHref = original
    ? `/workspaces/${original.id}`
    : "/workspaces"

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!original || !dirty) return
    try {
      sessionStorage.setItem(
        `${DRAFT_KEY_PREFIX}${original.id}`,
        JSON.stringify(draft)
      )
    } catch {
      // Editing still works when browser storage is unavailable.
    }
  }, [draft, dirty, original])

  useEffect(() => {
    return () => {
      if (generationTimer.current !== null) {
        window.clearTimeout(generationTimer.current)
      }
      generationToken.current += 1
    }
  }, [])

  const updateDraft = (updater: (current: Workspace) => Workspace) => {
    setDraft((current) => updater(current))
    setFormError(null)
  }

  const send = () => {
    const text = input.trim()
    if (!text || generating) return
    if (!canEdit) return

    setInput("")
    setFormError(null)
    setMessages((current) => [...current, { role: "user", text }])
    setGenerating(true)
    const token = generationToken.current + 1
    generationToken.current = token

    generationTimer.current = window.setTimeout(() => {
      if (token !== generationToken.current) return
      generationTimer.current = null

      const changes: string[] = []
      const next = structuredClone(draft)
      const hide = /隐藏|移除|去掉/.test(text)

      if (/手机/.test(text)) {
        next.config.showPhone = !hide
        changes.push(
          hide
            ? "在布局中隐藏手机号，不改变底层数据权限"
            : "显示已授权的手机号；成员脱敏规则仍然生效"
        )
      }
      if (/成本/.test(text)) {
        next.config.showCost = !hide
        changes.push(
          next.config.showCost ? "显示有权读取的订单成本" : "隐藏成本列"
        )
      }
      if (/趋势|行为/.test(text)) {
        if (hide) {
          next.config.showActivity = false
          changes.push("隐藏使用趋势模块")
        } else if (next.kind !== "customer") {
          changes.push(
            "此演示只在客户总览模板支持使用趋势，当前模板未修改"
          )
        } else {
          next.config.showActivity = true
          if (!next.bindings.activity) {
            const eventSource = next.datasourceIds.find(
              (id) =>
                datasources.find((source) => source.id === id)?.domain ===
                "events"
            )
            if (eventSource) {
              next.bindings.activity = eventSource
              changes.push("增加使用趋势；沿用已确认的客户标识映射")
            } else {
              changes.push(
                "已添加趋势占位，请在数据与模块中绑定行为数据源"
              )
            }
          } else {
            changes.push("使用趋势已显示")
          }
        }
      }

      setGenerating(false)
      if (changes.length > 0) {
        setDraft(next)
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: "草稿预览已更新，请核对后保存。",
            changes,
          },
        ])
      } else {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: "这个请求超出当前 Mock 范围。可以试试「隐藏手机号」「显示成本」或「增加使用趋势」，也可以直接在「数据与模块」中调整来源与显示配置。",
          },
        ])
      }
    }, 1100)
  }

  const stop = () => {
    if (generationTimer.current !== null) {
      window.clearTimeout(generationTimer.current)
      generationTimer.current = null
    }
    generationToken.current += 1
    setGenerating(false)
    setMessages((current) => [
      ...current,
      { role: "assistant", text: "已停止模拟生成，未应用这次请求。" },
    ])
  }

  const save = async () => {
    if (!canEdit || generating || saving) return

    const title = draft.title.trim()
    if (!title) {
      setFormError("工作台名称不能为空。")
      return
    }

    const missing = requiredBindings(draft).some((key) => {
      const sourceId = draft.bindings[key]
      const source = datasources.find((item) => item.id === sourceId)
      return !source || !isBindingCompatible(key, source)
    })

    if (missing) {
      setTab("data")
      setFormError("请先为所有显示中的模块绑定兼容的数据源。")
      return
    }

    setSaving(true)
    setFormError(null)
    try {
      const saved = await actions.save.mutateAsync({
        ...draft,
        title,
      })
      if (original) {
        try {
          sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${original.id}`)
        } catch {
          // Nothing to clean up when storage is unavailable.
        }
      }
      navigate(`/workspaces/${saved.id}`, { replace: true })
    } catch {
      setFormError("保存失败，请重试。已保存的工作台没有被修改。")
    } finally {
      setSaving(false)
    }
  }

  const requestLeave = () => {
    if (dirty) setLeaveOpen(true)
    else navigate(workspaceHref)
  }

  const confirmLeave = () => {
    stopGenerationSilently()
    setLeaveOpen(false)
    navigate(workspaceHref)
  }

  const confirmDiscard = () => {
    stopGenerationSilently()
    if (original) {
      try {
        sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${original.id}`)
      } catch {
        // Ignore unavailable storage.
      }
    }
    setDiscardOpen(false)
    navigate(workspaceHref, { replace: true })
  }

  const stopGenerationSilently = () => {
    if (generationTimer.current !== null) {
      window.clearTimeout(generationTimer.current)
      generationTimer.current = null
    }
    generationToken.current += 1
    setGenerating(false)
  }

  const dataset = buildWorkspaceDataset(draft, datasources, "owner")
  const selectedSources = draft.datasourceIds
    .map((id) => datasources.find((source) => source.id === id))
    .filter((source): source is Datasource => Boolean(source))

  if (!canEdit) {
    return (
      <PageContainer
        title="当前预览角色不能编辑"
        description="成员权限预览只展示可见结果，不提供工作台编辑能力。"
      >
        <Notice tone="warning">
          你正在以普通成员身份预览。请先在页面顶部的权限预览栏切回「数据管理员」，再打开 AI
          编辑器。
        </Notice>
        <Button
          className="mt-3"
          variant="outline"
          nativeButton={false}
          render={<Link to={workspaceHref} />}
        >
          <ArrowLeft aria-hidden="true" />
          返回工作台
        </Button>
      </PageContainer>
    )
  }

  return (
    <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-5 max-[980px]:px-5 max-[700px]:px-4">
      <div className="sticky top-(--spacing-topbar) z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="退出编辑"
          onClick={requestLeave}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-card-title font-medium text-foreground">
            {draft.title}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "font-normal",
              dirty
                ? "border-warning-border bg-warning-soft text-warning"
                : "border-success-border bg-success-soft text-success"
            )}
          >
            {dirty ? "未保存草稿" : "草稿已保存"}
          </Badge>
          <span className="text-caption text-muted-foreground tabular-nums">
            基于 v{original?.version ?? 0}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDiscardOpen(true)}
            disabled={!dirty || saving}
          >
            放弃修改
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={generating || saving}
          >
            {saving ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            {saving
              ? "保存中…"
              : original
                ? "保存更新"
                : "保存工作台"}
          </Button>
        </div>
      </div>

      {restoredDraft ? (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Info className="size-3.5" aria-hidden="true" />
          已恢复此浏览器中上次未保存的草稿。
        </p>
      ) : null}

      {formError ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <WorkspaceSplitView sidebar={
        <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card">
          <div
            role="tablist"
            aria-label="编辑面板"
            className="grid grid-cols-2 border-b border-border"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              onClick={() => setTab("chat")}
              className={cn(
                "flex min-h-10 items-center justify-center gap-1.5 border-b-2 px-2 text-label font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                tab === "chat"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              AI 修改
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "data"}
              onClick={() => setTab("data")}
              className={cn(
                "flex min-h-10 items-center justify-center gap-1.5 border-b-2 px-2 text-label font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                tab === "data"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Database className="size-3.5" aria-hidden="true" />
              数据与模块
            </button>
          </div>

          {tab === "chat" ? (
            <>
              <div
                className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
                role="log"
                aria-live="polite"
                aria-label="AI 修改对话"
              >
                <ol className="grid gap-2.5">
                  {messages.map((message, index) => (
                    <li
                      key={index}
                      className={cn(
                        "rounded-lg px-3 py-2 text-label leading-relaxed",
                        message.role === "user"
                          ? "ml-6 bg-primary/10 text-foreground"
                          : "mr-1 border border-border bg-muted/50 text-foreground"
                      )}
                    >
                      {message.role === "assistant" ? (
                        <div className="mb-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                          <span className="grid size-5 place-items-center rounded-md bg-primary/10 text-primary">
                            <Sparkles className="size-3" aria-hidden="true" />
                          </span>
                          <span className="font-medium text-foreground">
                            Shuriva
                          </span>
                          模拟响应
                        </div>
                      ) : null}
                      <p className="whitespace-pre-wrap">{message.text}</p>
                      {message.changes ? (
                        <div className="mt-1.5 grid gap-1 border-t border-border pt-1.5 text-caption text-muted-foreground">
                          {message.changes.map((change) => (
                            <span
                              key={change}
                              className="flex items-start gap-1.5"
                            >
                              <Check
                                className="mt-0.5 size-3 shrink-0 text-success"
                                aria-hidden="true"
                              />
                              {change}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>

                {generating ? (
                  <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-label text-muted-foreground">
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                    <span className="flex-1">正在更新预览草稿…</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={stop}
                    >
                      停止
                    </Button>
                  </div>
                ) : null}

                <p className="mt-2.5 flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
                  <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                  AI 不会改变数据权限，也不会执行数据库写入。
                </p>
              </div>

              <div className="shrink-0 border-t border-border p-3">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="bg-card"
                    onClick={() => setInput("增加使用趋势")}
                  >
                    增加使用趋势
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="bg-card"
                    onClick={() => setInput("隐藏手机号")}
                  >
                    隐藏手机号
                  </Button>
                </div>
                <label htmlFor="editor-prompt" className="sr-only">
                  描述如何修改工作台
                </label>
                <textarea
                  id="editor-prompt"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault()
                      send()
                    }
                  }}
                  rows={3}
                  placeholder="描述如何修改，比如：隐藏手机号……"
                  className="w-full resize-y rounded-md border border-input bg-card px-2.5 py-2 text-label leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-caption text-muted-foreground">
                    仅修改当前草稿
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    aria-label="发送修改指令"
                    disabled={!input.trim() || generating}
                    onClick={send}
                  >
                    <Send aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-label font-medium text-foreground">
                  工作台数据源
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setPickerOpen(true)}
                >
                  <Plus aria-hidden="true" />
                  选择
                </Button>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {selectedSources.length > 0 ? (
                  selectedSources.map((source) => (
                    <span
                      key={source.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-1 text-caption text-foreground"
                    >
                      <EngineMark engine={source.engine} size="sm" />
                      {source.name}
                      {source.status === "offline" ? (
                        <span className="text-destructive">离线</span>
                      ) : null}
                    </span>
                  ))
                ) : (
                  <p className="text-caption text-muted-foreground">
                    还没有选择数据源
                  </p>
                )}
              </div>
              <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
                选择来源只确定可用范围。每个模块仍需绑定具体来源与查询。
              </p>

              <h2 className="mt-4 mb-2 text-label font-medium text-foreground">
                模块与查询绑定
              </h2>
              <div className="grid gap-2">
                {(Object.keys(draft.bindings) as BindingKey[]).map((key) => {
                  const Icon = BINDING_ICONS[key]
                  const compatible = selectedSources.filter(
                    (source) => source.domain === getBindingDomain(key)
                  )
                  const bound = draft.bindings[key] ?? ""

                  return (
                    <div
                      key={key}
                      className="rounded-lg border border-border bg-card p-2.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon
                          className="size-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <strong className="text-label font-medium text-foreground">
                          {BINDING_LABELS[key]}
                        </strong>
                        <code className="ml-auto text-caption text-muted-foreground">
                          q_{key}
                        </code>
                      </div>
                      <label
                        htmlFor={`binding-${key}`}
                        className="sr-only"
                      >
                        {BINDING_LABELS[key]}数据源
                      </label>
                      <Select
                        items={[
                          { value: "none", label: "请选择兼容数据源" },
                          ...compatible.map((source) => ({
                            value: source.id,
                            label: `${source.name} · ${source.engine}`,
                          })),
                        ]}
                        value={bound || "none"}
                        onValueChange={(value) => {
                          const next = String(value)
                          updateDraft((current) => ({
                            ...current,
                            bindings: {
                              ...current.bindings,
                              [key]: next === "none" ? undefined : next,
                            },
                          }))
                        }}
                      >
                        <SelectTrigger
                          id={`binding-${key}`}
                          size="sm"
                          className="mt-1.5 w-full bg-card"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          <SelectItem value="none">
                            请选择兼容数据源
                          </SelectItem>
                          {compatible.map((source) => (
                            <SelectItem key={source.id} value={source.id}>
                              {source.name} · {source.engine}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <small className="mt-1 block text-caption text-muted-foreground">
                        {BINDING_HINTS[key]}
                      </small>
                      {bound &&
                      !compatible.some((source) => source.id === bound) ? (
                        <p className="mt-1 text-caption text-warning">
                          当前绑定不在可用来源中，保存前请重新选择。
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              <div className="mt-2 flex gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2">
                <Link2
                  className="mt-0.5 size-3.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div className="min-w-0 text-caption leading-relaxed">
                  <strong className="block text-foreground">
                    客户标识映射
                  </strong>
                  <code className="block text-muted-foreground">
                    customers.id → orders.customer_id
                  </code>
                  <code className="block text-muted-foreground">
                    customers.id → user_events.user_id
                  </code>
                  <small className="mt-0.5 block text-muted-foreground">
                    示例中已确认 · 不是自动猜测关联
                  </small>
                </div>
              </div>

              <h2 className="mt-4 mb-1.5 text-label font-medium text-foreground">
                显示配置
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border">
                <div className="flex items-center justify-between gap-3 px-2.5 py-2">
                  <label
                    htmlFor="config-showPhone"
                    className="text-label text-foreground"
                  >
                    显示手机号
                  </label>
                  <Checkbox
                    id="config-showPhone"
                    checked={draft.config.showPhone}
                    onCheckedChange={(value) =>
                      updateDraft((current) => ({
                        ...current,
                        config: {
                          ...current.config,
                          showPhone: value === true,
                        },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3 px-2.5 py-2">
                  <label
                    htmlFor="config-showCost"
                    className="text-label text-foreground"
                  >
                    显示订单成本
                  </label>
                  <Checkbox
                    id="config-showCost"
                    checked={draft.config.showCost}
                    onCheckedChange={(value) =>
                      updateDraft((current) => ({
                        ...current,
                        config: {
                          ...current.config,
                          showCost: value === true,
                        },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3 px-2.5 py-2">
                  <label
                    htmlFor="config-showActivity"
                    className={cn(
                      "text-label",
                      draft.kind === "customer"
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    显示使用趋势
                  </label>
                  <Checkbox
                    id="config-showActivity"
                    checked={draft.config.showActivity}
                    disabled={draft.kind !== "customer"}
                    onCheckedChange={(value) =>
                      updateDraft((current) => ({
                        ...current,
                        config: {
                          ...current.config,
                          showActivity: value === true,
                        },
                      }))
                    }
                  />
                </div>
              </div>
              {draft.kind !== "customer" ? (
                <p className="mt-1 text-caption text-muted-foreground">
                  使用趋势仅在客户总览模板中可用。
                </p>
              ) : null}
              <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
                显示列属于布局配置，不能覆盖成员的数据权限。
              </p>
            </div>
          )}
        </aside>
      }>
        <div className="min-w-0 overflow-hidden bg-background">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className="size-1.5 rounded-full bg-success"
                aria-hidden="true"
              />
              <strong className="text-label font-medium text-foreground">
                实时预览
              </strong>
              <Badge variant="secondary" className="font-normal">
                草稿
              </Badge>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-caption text-muted-foreground">
                {draft.datasourceIds.length} 个来源 · 模拟数据 · 只读
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="数据说明"
                onClick={() => setNotesOpen(true)}
              >
                <Info aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="bg-background p-3 max-[700px]:p-2">
            <WorkspaceRenderer
              workspace={draft}
              datasources={datasources}
              dataset={dataset}
              compact
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 px-3 pb-4 text-caption text-muted-foreground">
          <Lock className="size-3.5" aria-hidden="true" />
          编辑和预览均为本地模拟。保存后只写入当前浏览器的演示存储。
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            nativeButton={false}
            render={<Link to={workspaceHref} />}
          >
            <ArrowRight aria-hidden="true" />
            返回工作台
          </Button>
        </div>
      </WorkspaceSplitView>

      <SourcePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        datasources={datasources}
        selectedIds={draft.datasourceIds}
        onConfirm={(ids) =>
          updateDraft((current) => {
            const bindings = { ...current.bindings }
            for (const key of Object.keys(bindings) as BindingKey[]) {
              const sourceId = bindings[key]
              if (sourceId && !ids.includes(sourceId)) {
                bindings[key] = undefined
              }
            }
            return {
              ...current,
              datasourceIds: ids,
              bindings,
              config: {
                ...current.config,
                showActivity:
                  current.config.showActivity && Boolean(bindings.activity),
              },
            }
          })
        }
        title="选择工作台数据源"
        note="移除正在使用的数据源后，对应模块将进入「尚未绑定」状态。不会自动换到另一个数据库。"
      />

      <DataNotesDialog
        open={notesOpen}
        onOpenChange={setNotesOpen}
        workspace={draft}
        datasources={datasources}
        policy={dataset.policy}
      />

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title="离开未保存的草稿？"
        description="当前草稿会保留在这个浏览器的编辑器中；已保存的工作台不会被修改。"
        confirmLabel="保留草稿并离开"
        cancelLabel="继续编辑"
        tone="primary"
        onConfirm={confirmLeave}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="放弃当前修改？"
        description="将恢复已保存的工作台，不会修改任何数据库记录，也不会保留这次草稿。"
        confirmLabel="放弃修改"
        onConfirm={confirmDiscard}
      />
    </div>
  )
}
