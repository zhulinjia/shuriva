import {
  Copy,
  Info,
  LayoutGrid,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import type { Workspace } from "@/services"
import {
  useDatasources,
  useWorkspaceActions,
  useWorkspaces,
} from "@/hooks/use-workspaces"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format"
import { PageContainer } from "@/components/layout/page-container"
import { WorkspaceGlyph } from "@/components/workspace/workspace-glyph"
import { EngineMark } from "@/components/datasources/engine-mark"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

type RenameState = {
  workspace: Workspace
  title: string
  error: string | null
}

export function WorkspacesPage() {
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  const datasources = useDatasources()
  const actions = useWorkspaceActions()
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [rename, setRename] = useState<RenameState | null>(null)
  const [deleting, setDeleting] = useState<Workspace | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const sources = datasources.data ?? []
  const query = search.trim().toLowerCase()
  const rows = (workspaces.data ?? []).filter(
    (workspace) =>
      workspace.title.toLowerCase().includes(query) &&
      (sourceFilter === "all" ||
        workspace.datasourceIds.includes(sourceFilter))
  )

  const submitRename = () => {
    if (!rename) return
    const title = rename.title.trim()
    if (!title) {
      setRename({ ...rename, error: "名称不能为空。" })
      return
    }
    if (title.length > 60) {
      setRename({ ...rename, error: "名称不能超过 60 个字符。" })
      return
    }

    actions.rename.mutate(
      { id: rename.workspace.id, title },
      {
        onSuccess: () => {
          setStatus(`已重命名为「${title}」。`)
          setRename(null)
        },
        onError: () => {
          setRename({ ...rename, error: "重命名失败，请重试。" })
        },
      }
    )
  }

  const duplicate = (workspace: Workspace) => {
    actions.duplicate.mutate(workspace.id, {
      onSuccess: (copy) => setStatus(`已复制为「${copy.title}」。`),
      onError: () => setStatus("复制失败，请重试。"),
    })
  }

  const confirmDelete = () => {
    if (!deleting) return
    const title = deleting.title
    actions.remove.mutate(deleting.id, {
      onSuccess: () => {
        setStatus(`已删除「${title}」。不会影响任何真实数据库记录。`)
        setDeleting(null)
      },
      onError: () => setStatus("删除失败，请重试。"),
    })
  }

  return (
    <PageContainer
      eyebrow="WORKSPACES"
      title="我的工作台"
      description="把重复的业务查询，变成随时可以打开的工具。"
      actions={
        <Button type="button" onClick={() => navigate("/create")}>
          <Plus aria-hidden="true" />
          创建工作台
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <label htmlFor="workspace-search" className="sr-only">
            搜索工作台
          </label>
          <Input
            id="workspace-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索工作台"
            className="pl-8"
          />
        </div>

        <label htmlFor="workspace-source-filter" className="sr-only">
          按数据源筛选
        </label>
        <Select
          items={[
            { value: "all", label: "全部数据源" },
            ...sources.map((source) => ({
              value: source.id,
              label: source.name,
            })),
          ]}
          value={sourceFilter}
          onValueChange={(value) => setSourceFilter(String(value))}
        >
          <SelectTrigger id="workspace-source-filter" size="default">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="all">全部数据源</SelectItem>
            {sources.map((source) => (
              <SelectItem key={source.id} value={source.id}>
                {source.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="ml-auto text-caption text-muted-foreground tabular-nums">
          {rows.length} 个工作台
        </span>
      </div>

      <p role="status" className="sr-only">
        {status}
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

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,320px)_120px_104px] gap-4 border-b border-border bg-muted/50 px-4 py-2 text-caption font-medium text-muted-foreground min-[981px]:grid">
          <span>工作台</span>
          <span>使用的数据源</span>
          <span>修改时间</span>
          <span className="sr-only">操作</span>
        </div>

        {workspaces.isPending ? (
          <div className="divide-y divide-border" aria-busy="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="flex items-center gap-3 px-4 py-3.5"
              >
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64 max-w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : workspaces.isError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-label text-destructive">工作台加载失败。</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void workspaces.refetch()}
            >
              重试
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <LayoutGrid
              className="mx-auto size-7 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="mt-2 text-label font-medium text-foreground">
              {workspaces.data.length === 0
                ? "还没有工作台"
                : "没有找到工作台"}
            </p>
            <p className="mt-1 text-caption text-muted-foreground">
              {workspaces.data.length === 0
                ? "从创建入口描述需求，创建第一个工作台。"
                : "换个名称或数据源试试。"}
            </p>
            {workspaces.data.length === 0 ? (
              <Button
                type="button"
                size="sm"
                className="mt-3"
                onClick={() => navigate("/create")}
              >
                <Plus aria-hidden="true" />
                创建工作台
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((workspace) => {
              const boundSources = sources.filter((source) =>
                workspace.datasourceIds.includes(source.id)
              )

              return (
                <li
                  key={workspace.id}
                  className={cn(
                    "grid items-center gap-3 px-3 py-3 transition-colors hover:bg-accent min-[981px]:grid-cols-[minmax(0,1fr)_minmax(0,320px)_120px_104px] min-[981px]:gap-4 min-[981px]:px-4"
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <WorkspaceGlyph kind={workspace.kind} />
                    <div className="min-w-0">
                      <Link
                        to={`/workspaces/${workspace.id}`}
                        className="block truncate text-label font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {workspace.title}
                      </Link>
                      <p className="mt-0.5 line-clamp-1 text-caption text-muted-foreground">
                        {workspace.description}
                      </p>
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {boundSources.length > 0 ? (
                      boundSources.map((source) => (
                        <span
                          key={source.id}
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-caption text-muted-foreground"
                          title={source.name}
                        >
                          <EngineMark engine={source.engine} size="sm" />
                          <span className="truncate">{source.name}</span>
                        </span>
                      ))
                    ) : (
                      <span className="text-caption text-warning">
                        未绑定数据源
                      </span>
                    )}
                  </div>

                  <span className="text-caption text-muted-foreground tabular-nums">
                    <span className="min-[981px]:hidden">
                      修改于{" "}
                    </span>
                    {formatDateTime(workspace.updatedAt)}
                  </span>

                  <div className="flex items-center gap-0.5 min-[981px]:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`重命名 ${workspace.title}`}
                      onClick={() =>
                        setRename({
                          workspace,
                          title: workspace.title,
                          error: null,
                        })
                      }
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`复制 ${workspace.title}`}
                      disabled={actions.duplicate.isPending}
                      onClick={() => duplicate(workspace)}
                    >
                      <Copy aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除 ${workspace.title}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleting(workspace)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        删除工作台不会删除数据库记录；复制工作台不会复制更高的数据权限。
        当前目录和修改时间均为本地模拟数据。
      </p>

      <Dialog
        open={Boolean(rename)}
        onOpenChange={(open) => {
          if (!open && !actions.rename.isPending) setRename(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名工作台</DialogTitle>
            <DialogDescription>
              只修改显示名称，不改变数据源绑定和权限范围。
            </DialogDescription>
          </DialogHeader>
          <div>
            <label
              htmlFor="workspace-rename"
              className="mb-1.5 block text-label font-medium text-foreground"
            >
              工作台名称
            </label>
            <Input
              id="workspace-rename"
              value={rename?.title ?? ""}
              maxLength={60}
              autoFocus
              aria-invalid={Boolean(rename?.error)}
              aria-describedby={rename?.error ? "rename-error" : undefined}
              onChange={(event) =>
                setRename((current) =>
                  current
                    ? { ...current, title: event.target.value, error: null }
                    : current
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRename()
              }}
            />
            {rename?.error ? (
              <p id="rename-error" role="alert" className="mt-1.5 text-label text-destructive">
                {rename.error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={actions.rename.isPending}
              onClick={() => setRename(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={actions.rename.isPending || !rename?.title.trim()}
              onClick={submitRename}
            >
              {actions.rename.isPending ? "保存中…" : "保存名称"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !actions.remove.isPending) setDeleting(null)
        }}
        title="删除工作台？"
        description={`「${deleting?.title ?? ""}」将从本地演示数据中移除。此操作不会删除任何真实数据库记录，也无法撤销。`}
        confirmLabel="删除工作台"
        pending={actions.remove.isPending}
        onConfirm={confirmDelete}
      />
    </PageContainer>
  )
}
