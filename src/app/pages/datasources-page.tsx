import {
  ArrowRight,
  Cloud,
  Database,
  Lock,
  Pencil,
  Plus,
  Search,
  Server,
} from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import type { Datasource, DatasourceEngine, DatasourceInput } from "@/services"
import {
  useDatasourceActions,
  useDatasources,
  useWorkspaces,
} from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import { cn } from "@/lib/utils"
import { PageContainer } from "@/components/layout/page-container"
import { DatasourceDetailDialog } from "@/components/datasources/datasource-detail-dialog"
import { DatasourceFormDialog } from "@/components/datasources/datasource-form-dialog"
import { DatasourceStatusBadge } from "@/components/datasources/datasource-status-badge"
import { EngineMark } from "@/components/datasources/engine-mark"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Notice } from "@/components/common/notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

const ENGINE_FILTERS: { value: "all" | DatasourceEngine; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "PostgreSQL", label: "PostgreSQL" },
  { value: "MySQL", label: "MySQL" },
  { value: "ClickHouse", label: "ClickHouse" },
]

export function DatasourcesPage() {
  const datasources = useDatasources()
  const workspaces = useWorkspaces()
  const actions = useDatasourceActions()
  const edition = useDemoStore((state) => state.edition)
  const [search, setSearch] = useState("")
  const [engine, setEngine] = useState<"all" | DatasourceEngine>("all")
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<"overview" | "schema" | "usage">(
    "overview"
  )
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const sources = datasources.data ?? []
  const query = search.trim().toLowerCase()
  const rows = sources.filter(
    (source) =>
      (source.name.toLowerCase().includes(query) ||
        source.database.toLowerCase().includes(query)) &&
      (engine === "all" || source.engine === engine)
  )
  const connected = sources.filter(
    (source) => source.status === "connected"
  ).length
  const offline = sources.length - connected
  const engineCount = new Set(sources.map((source) => source.engine)).size

  const detailSource =
    sources.find((source) => source.id === detailId) ?? null
  const editingSource =
    sources.find((source) => source.id === editingId) ?? null
  const deletingSource =
    sources.find((source) => source.id === deleteId) ?? null

  const openAdd = () => {
    setEditingId(null)
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (source: Datasource) => {
    setDetailId(null)
    setEditingId(source.id)
    setFormError(null)
    setFormOpen(true)
  }

  const openDetail = (source: Datasource, tab: "overview" | "usage") => {
    setDetailTab(tab)
    setDetailId(source.id)
  }

  const submitForm = (input: DatasourceInput) => {
    setFormError(null)
    if (editingId) {
      actions.update.mutate(
        { id: editingId, input },
        {
          onSuccess: () => {
            setFormOpen(false)
            setStatus(`已更新「${input.name}」的模拟连接配置。`)
          },
          onError: (error) => setFormError(error.message),
        }
      )
    } else {
      actions.add.mutate(input, {
        onSuccess: () => {
          setFormOpen(false)
          setStatus(
            `已保存「${input.name}」的模拟数据源，未保存密码或建立真实连接。`
          )
        },
        onError: (error) => setFormError(error.message),
      })
    }
  }

  const toggleStatus = (source: Datasource) => {
    setActionError(null)
    actions.setStatus.mutate(
      {
        id: source.id,
        status: source.status === "connected" ? "offline" : "connected",
      },
      {
        onSuccess: (updated) =>
          setStatus(
            updated.status === "offline"
              ? `已模拟断开「${updated.name}」；其他来源不受影响。`
              : `「${updated.name}」的模拟连接已恢复。`
          ),
        onError: (error) => setActionError(error.message),
      }
    )
  }

  const confirmDelete = () => {
    if (!deleteId) return
    setActionError(null)
    actions.remove.mutate(deleteId, {
      onSuccess: () => {
        setStatus("模拟数据源已删除。没有删除任何数据库。")
        setDeleteId(null)
      },
      onError: (error) => {
        setActionError(error.message)
        setDeleteId(null)
      },
    })
  }

  return (
    <PageContainer
      eyebrow="DATA SOURCES"
      title="数据源"
      description="管理数据库连接。在同一个工作台中，按需组合不同来源的数据。"
      actions={
        <Button type="button" onClick={openAdd}>
          <Plus aria-hidden="true" />
          添加数据源
        </Button>
      }
    >
      <div className="flex gap-2.5 rounded-lg border border-border bg-card px-4 py-3">
        {edition === "team" ? (
          <Cloud
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <Server
            className="mt-0.5 size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <strong className="block text-label font-medium text-foreground">
            {edition === "team"
              ? "团队版连接方式待定"
              : "开源版 · 应用后端直连"}
          </strong>
          <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
            {edition === "team"
              ? "此界面仅演示数据源管理；不预设云端托管凭证或独立连接节点。"
              : "由你部署的 Shuriva 后端连接数据库，无需额外安装 Connector。当前为模拟连接。"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 self-center max-[700px]:hidden"
          nativeButton={false}
          render={<Link to="/settings" />}
        >
          了解部署边界
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4">
        <Stat label="个数据源" value={sources.length} />
        <Stat
          label="连接可用"
          value={connected}
          dot="bg-success"
        />
        <Stat label="暂时离线" value={offline} dot="bg-destructive" />
        <Stat label="种数据库类型" value={engineCount} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <label htmlFor="source-search" className="sr-only">
            搜索连接名称或数据库名
          </label>
          <Input
            id="source-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索连接名称或数据库名"
            className="pl-8"
          />
        </div>

        <div
          role="group"
          aria-label="按数据库类型筛选"
          className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
        >
          {ENGINE_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={engine === option.value}
              onClick={() => setEngine(option.value)}
              className={cn(
                "min-h-7 rounded-md px-2 text-label transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                engine === option.value
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p role="status" className="sr-only">
        {status ?? actionError}
      </p>
      {status ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-success-border bg-success-soft px-3 py-2 text-label text-success">
          <span className="flex-1">{status}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setStatus(null)}
          >
            关闭
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive">
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setActionError(null)}
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_180px_170px_130px_112px] gap-4 border-b border-border bg-muted/50 px-4 py-2 text-caption font-medium text-muted-foreground min-[981px]:grid">
          <span>数据源</span>
          <span>环境与访问</span>
          <span>连接状态</span>
          <span>使用情况</span>
          <span className="sr-only">操作</span>
        </div>

        {datasources.isPending ? (
          <div className="divide-y divide-border" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-4 py-4">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-52 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : datasources.isError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-label text-destructive">数据源加载失败。</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void datasources.refetch()}
            >
              重试
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Database
              className="mx-auto size-7 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="mt-2 text-label font-medium text-foreground">
              没有匹配的数据源
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {sources.length === 0
                ? "添加一个模拟连接，或直接使用示例数据源。"
                : "支持同一种数据库创建多条连接。"}
            </p>
            <Button type="button" size="sm" className="mt-3" onClick={openAdd}>
              <Plus aria-hidden="true" />
              添加数据源
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((source) => {
              const usage = (workspaces.data ?? []).filter((workspace) =>
                workspace.datasourceIds.includes(source.id)
              )

              return (
                <li
                  key={source.id}
                  className="grid items-center gap-x-4 gap-y-2 px-3 py-3 transition-colors hover:bg-accent min-[981px]:grid-cols-[minmax(0,1fr)_180px_170px_130px_112px] min-[981px]:px-4"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <EngineMark engine={source.engine} size="lg" />
                    <button
                      type="button"
                      onClick={() => openDetail(source, "overview")}
                      className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <strong className="block truncate text-label font-medium text-foreground">
                        {source.name}
                      </strong>
                      <small className="block truncate text-caption text-muted-foreground">
                        {source.engine} · <code>{source.database}</code>
                      </small>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 min-[981px]:block">
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-normal",
                        source.environment === "生产"
                          ? "border-info-border bg-info-soft text-info"
                          : "border-border bg-muted/50 text-muted-foreground"
                      )}
                    >
                      {source.environment}
                    </Badge>
                    <small className="mt-0 flex items-center gap-1 text-caption text-muted-foreground min-[981px]:mt-1">
                      <Lock className="size-3" aria-hidden="true" />
                      只读访问
                    </small>
                  </div>

                  <div className="min-[981px]:block">
                    <DatasourceStatusBadge status={source.status} />
                    <small className="mt-0 block text-caption text-muted-foreground min-[981px]:mt-1">
                      模拟状态 · {source.updatedAt}
                    </small>
                  </div>

                  <button
                    type="button"
                    onClick={() => openDetail(source, "usage")}
                    className="flex w-fit items-center gap-1 rounded-sm text-label text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {usage.length} 个工作台
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </button>

                  <div className="flex items-center gap-0.5 min-[981px]:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openDetail(source, "overview")}
                    >
                      管理
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`编辑 ${source.name}`}
                      onClick={() => openEdit(source)}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Guide
          number="01"
          title="连接彼此独立"
          description="生产、测试库分别管理，不会因为页面切换而替换工作台的执行目标。"
        />
        <Guide
          number="02"
          title="每个模块明确来源"
          description="客户资料来自会员库，订单来自交易库。按查询绑定，而非全局切换。"
        />
        <Guide
          number="03"
          title="密码不在浏览器保存"
          description="原型不接收真实凭证；正式开源版交由用户部署的后端保存和使用。"
        />
      </div>

      <div className="mt-3">
        <Notice>
          本页不验证数据库网络连通性，也不保存真实凭证。连接状态、表结构和更新时间均为本地模拟。
        </Notice>
      </div>

      <DatasourceDetailDialog
        datasource={detailSource}
        workspaces={workspaces.data ?? []}
        open={Boolean(detailSource)}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
        initialTab={detailTab}
        pending={actions.setStatus.isPending || actions.remove.isPending}
        onEdit={openEdit}
        onToggleStatus={toggleStatus}
        onDelete={(source) => {
          setDetailId(null)
          setDeleteId(source.id)
        }}
      />

      <DatasourceFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setFormError(null)
        }}
        datasource={editingSource}
        pending={actions.add.isPending || actions.update.isPending}
        submitError={formError}
        onSubmit={submitForm}
      />

      <ConfirmDialog
        open={Boolean(deleteId)}
        onOpenChange={(open) => {
          if (!open && !actions.remove.isPending) setDeleteId(null)
        }}
        title="删除这个数据源？"
        description={`仅删除当前浏览器里的「${deletingSource?.name ?? ""}」模拟连接配置，不会删除数据库。已被工作台引用的连接必须先解除绑定。`}
        confirmLabel="删除连接"
        pending={actions.remove.isPending}
        onConfirm={confirmDelete}
      />
    </PageContainer>
  )
}

function Stat({
  label,
  value,
  dot,
}: {
  label: string
  value: number
  dot?: string
}) {
  return (
    <div className="border-b border-border px-4 py-2.5 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0 [&:nth-child(2)]:border-r-0 sm:[&:nth-child(2)]:border-r">
      <div className="flex items-center gap-1.5">
        {dot ? (
          <span
            className={cn("size-1.5 rounded-full", dot)}
            aria-hidden="true"
          />
        ) : null}
        <strong className="text-number font-semibold text-foreground tabular-nums">
          {value}
        </strong>
      </div>
      <span className="text-caption text-muted-foreground">{label}</span>
    </div>
  )
}

function Guide({
  number,
  title,
  description,
}: {
  number: string
  title: string
  description: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <span className="text-caption font-medium tracking-widest text-primary">
        {number}
      </span>
      <h2 className="mt-1 text-label font-medium text-foreground">{title}</h2>
      <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}
