import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { WorkspaceDocument, WorkspaceQuery } from "@/shared/workspace-schema"
import { previewQuery } from "@/services/community-api"

function display(value: unknown) {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export function LiveWorkspaceComponents({ document }: { document: WorkspaceDocument }) {
  return <div className="grid gap-4 p-5 md:p-7">{document.components.map((component) => {
    if (component.type === "placeholder") return <section key={component.id} className="min-w-0 rounded-lg border border-dashed border-border bg-muted/20 p-4"><div className="flex flex-wrap items-center gap-2"><h2 className="text-label font-medium">{component.title}</h2><span className="rounded-md border border-border px-1.5 py-0.5 text-caption text-muted-foreground">待接入</span></div><p className="mt-2 text-label leading-relaxed text-muted-foreground">{component.description}</p></section>
    const query = document.queries.find((item) => item.id === component.queryId)
    return query ? <LiveComponent key={`${component.id}:${JSON.stringify(query)}`} component={component} query={query} /> : null
  })}</div>
}

function LiveComponent({ component, query }: { component: Exclude<WorkspaceDocument["components"][number], { type: "placeholder" }>; query: WorkspaceQuery }) {
  const [searchField, setSearchField] = useState(query.fields[0] ?? "")
  const [search, setSearch] = useState("")
  const [appliedSearch, setAppliedSearch] = useState("")
  const [offset, setOffset] = useState(query.offset)
  const [orderBy, setOrderBy] = useState(query.orderBy)
  const activeQuery = { ...query, offset, ...(orderBy ? { orderBy } : {}), filters: [...query.filters, ...(appliedSearch ? [{ field: searchField, operator: "contains" as const, value: appliedSearch }] : [])] }
  const result = useQuery({ queryKey: ["live-query", activeQuery], queryFn: () => previewQuery(activeQuery), retry: false })
  const rows = result.data?.rows ?? []
  return <section className="min-w-0 rounded-lg border bg-card">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><h2 className="font-medium">{component.title}</h2>{component.type === "table" && <form className="flex max-w-full flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setOffset(0); setAppliedSearch(search) }}><select aria-label="搜索字段" className="h-8 max-w-36 rounded-md border bg-background px-2 text-sm" value={searchField} onChange={(event) => setSearchField(event.target.value)}>{query.fields.map((field) => <option key={field}>{field}</option>)}</select>
        <Input
            className="h-8 w-36"
            aria-label="搜索内容"
            placeholder="输入搜索关键词"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline">搜索</Button></form>}</div>
    {result.isPending ? <p className="p-5 text-sm text-muted-foreground" aria-busy="true">正在读取数据…</p> : result.isError ? <div className="p-5 text-sm text-destructive" role="alert">此模块的数据读取失败。<Button className="ml-2" size="sm" variant="outline" onClick={() => void result.refetch()}>重试</Button></div> : rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">没有符合条件的数据。</p> : component.type === "metric" ? <p className="p-5 text-3xl font-semibold">{display(rows[0]?.[component.field])}</p> : component.type === "detail" ? <dl className="grid gap-3 p-5 sm:grid-cols-2">{query.fields.map((field) => <div key={field}><dt className="text-xs text-muted-foreground">{field}</dt><dd className="mt-1 break-words text-sm">{display(rows[0]?.[field])}</dd></div>)}</dl> : <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/30"><tr>{query.fields.map((field) => <th className="px-4 py-3 font-medium" key={field}><button type="button" className="hover:underline" onClick={() => { setOffset(0); setOrderBy({ field, direction: orderBy?.field === field && orderBy.direction === "asc" ? "desc" : "asc" }) }}>{field}{orderBy?.field === field ? orderBy.direction === "asc" ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-t" key={index}>{query.fields.map((field) => <td className="max-w-80 break-words px-4 py-3" key={field}>{display(row[field])}</td>)}</tr>)}</tbody></table></div><div className="flex items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground"><span>当前显示 {rows.length} 条</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0 || result.isFetching} onClick={() => setOffset(Math.max(0, offset - query.limit))}>上一页</Button><Button size="sm" variant="outline" disabled={rows.length < query.limit || result.isFetching} onClick={() => setOffset(offset + query.limit)}>下一页</Button></div></div></>}
  </section>
}
