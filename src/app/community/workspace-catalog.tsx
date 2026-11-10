import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Copy, Info, LayoutGrid, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { PageContainer } from "@/components/layout/page-container"
import { EngineMark } from "@/components/datasources/engine-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatDateTime } from "@/lib/format"
import { getSources, getWorkspaces } from "@/services/community-api"
import type { LiveWorkspace } from "@/services/community-api"
import { engineName } from "./source-display"

export function WorkspaceCatalog({ onCreate, onOpen }: { onCreate: () => void; onOpen: (workspace: LiveWorkspace) => void }) {
  const workspaces = useQuery({ queryKey: ["live-workspaces"], queryFn: getWorkspaces })
  const sources = useQuery({ queryKey: ["live-sources"], queryFn: getSources })
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState("all")
  const rows = (workspaces.data ?? []).filter((workspace) => workspace.document.title.toLowerCase().includes(search.trim().toLowerCase()) && (sourceFilter === "all" || workspace.document.queries.some((query) => query.datasourceId === sourceFilter)))
  return <PageContainer eyebrow="WORKSPACES" title="我的工作台" description="把重复的业务查询，变成随时可以打开的工具。" actions={<Button type="button" onClick={onCreate}><Plus aria-hidden="true" />创建工作台</Button>}>
    <div className="flex flex-wrap items-center gap-2"><div className="relative min-w-0 flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索工作台" aria-label="搜索工作台" className="pl-8" /></div>
      <Select items={[{ value: "all", label: "全部数据源" }, ...(sources.data ?? []).map((source) => ({ value: source.id, label: source.name }))]} value={sourceFilter} onValueChange={(value) => setSourceFilter(String(value))}><SelectTrigger aria-label="按数据源筛选" size="default"><SelectValue /></SelectTrigger><SelectContent align="start"><SelectItem value="all">全部数据源</SelectItem>{sources.data?.map((source) => <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>)}</SelectContent></Select>
      <span className="ml-auto text-caption text-muted-foreground tabular-nums">{rows.length} 个工作台</span>
    </div>
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card"><div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,320px)_120px_104px] gap-4 border-b border-border bg-muted/50 px-4 py-2 text-caption font-medium text-muted-foreground min-[981px]:grid"><span>工作台</span><span>使用的数据源</span><span>修改时间</span><span className="sr-only">操作</span></div>
      {workspaces.isPending ? <p className="px-4 py-10 text-center text-label text-muted-foreground" aria-busy="true">正在读取工作台…</p> : workspaces.isError ? <div className="px-4 py-10 text-center"><p className="text-label text-destructive">工作台加载失败。</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void workspaces.refetch()}>重试</Button></div> : rows.length === 0 ? <div className="px-4 py-12 text-center"><LayoutGrid className="mx-auto size-7 text-muted-foreground" aria-hidden="true" /><p className="mt-2 text-label font-medium">{workspaces.data.length ? "没有找到工作台" : "还没有工作台"}</p><p className="mt-1 text-caption text-muted-foreground">{workspaces.data.length ? "换个名称或数据源试试。" : "从创建入口描述需求，创建第一个工作台。"}</p>{workspaces.data.length === 0 && <Button type="button" size="sm" className="mt-3" onClick={onCreate}><Plus aria-hidden="true" />创建工作台</Button>}</div> : <ul className="divide-y divide-border">{rows.map((workspace) => {
        const ids = new Set(workspace.document.queries.map((query) => query.datasourceId))
        const bound = (sources.data ?? []).filter((source) => ids.has(source.id))
        return <li key={workspace.id} className="grid items-center gap-3 px-3 py-3 transition-colors hover:bg-accent min-[981px]:grid-cols-[minmax(0,1fr)_minmax(0,320px)_120px_104px] min-[981px]:gap-4 min-[981px]:px-4">
          <div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><LayoutGrid className="size-4" aria-hidden="true" /></span><div className="min-w-0"><button type="button" className="block truncate text-left text-label font-medium underline-offset-2 hover:underline" onClick={() => onOpen(workspace)}>{workspace.document.title}</button><p className="mt-0.5 line-clamp-1 text-caption text-muted-foreground">{workspace.document.description}</p></div></div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">{bound.map((source) => <span key={source.id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-caption text-muted-foreground"><EngineMark engine={engineName[source.engine]} size="sm" /><span className="truncate">{source.name}</span></span>)}{!bound.length && <span className="text-caption text-muted-foreground">{sources.isPending ? "正在读取数据源…" : "数据源不可用或已移除"}</span>}</div>
          <span className="text-caption text-muted-foreground tabular-nums"><span className="min-[981px]:hidden">修改于 </span>{formatDateTime(workspace.updatedAt)}</span>
          <div className="flex items-center gap-0.5 min-[981px]:justify-end"><Button type="button" variant="ghost" size="icon-sm" aria-label={`重命名 ${workspace.document.title}（待接入）`} title="待接入" disabled><Pencil aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label={`复制 ${workspace.document.title}（待接入）`} title="待接入" disabled><Copy aria-hidden="true" /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label={`删除 ${workspace.document.title}（待接入）`} title="待接入" disabled><Trash2 aria-hidden="true" /></Button></div>
        </li>
      })}</ul>}
    </div>
    <p className="mt-3 flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />工作台的重命名、复制和删除入口暂未接入，保留用于后续开发。</p>
  </PageContainer>
}
