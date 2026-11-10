import { useState } from "react"
import { Database, Plus, Search } from "lucide-react"
import { EngineMark } from "@/components/datasources/engine-mark"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { LiveSource } from "@/services/community-api"
import { engineName } from "./source-display"

export function LiveSourcePicker({ sources, selectedIds, onClose, onConfirm, onAdd }: {
  sources: readonly LiveSource[]
  selectedIds: readonly string[]
  onClose: () => void
  onConfirm: (ids: string[]) => void
  onAdd: () => void
}) {
  const [selected, setSelected] = useState([...selectedIds])
  const [search, setSearch] = useState("")
  const filtered = sources.filter((source) => `${source.name} ${engineName[source.engine]}`.toLowerCase().includes(search.trim().toLowerCase()))

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader className="pr-8"><DialogTitle>选择工作台数据源</DialogTitle><DialogDescription>可选择多个来源。每个模块独立查询，不执行隐式跨库关联。</DialogDescription></DialogHeader>
      <div className="flex min-w-0 items-center gap-2">
        <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或数据库类型…" aria-label="搜索数据源" className="bg-card pl-8" /></div>
        <Button type="button" variant="outline" className="shrink-0 bg-card" onClick={onAdd}><Plus aria-hidden="true" />添加数据源</Button>
      </div>
      <div className="grid max-h-[46svh] gap-1.5 overflow-y-auto pr-1">
        {filtered.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center"><Database className="mx-auto size-5 text-muted-foreground" aria-hidden="true" /><p className="mt-2 text-label font-medium">{sources.length ? "没有找到匹配的数据源" : "还没有数据源"}</p><p className="mt-1 text-caption text-muted-foreground">{sources.length ? "调整搜索词后再试。" : "添加数据库连接后即可用于创建工作台。"}</p></div> : filtered.map((source) => {
          const checked = selected.includes(source.id)
          return <label key={source.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${checked ? "border-primary/30 bg-primary/10" : "border-border bg-card hover:bg-accent"}`}>
            <Checkbox checked={checked} onCheckedChange={(value) => setSelected(value === true ? [...new Set([...selected, source.id])] : selected.filter((id) => id !== source.id))} aria-label={`选择 ${source.name}`} />
            <EngineMark engine={engineName[source.engine]} /><span className="min-w-0 flex-1"><strong className="block truncate text-label font-medium">{source.name}</strong><small className="block truncate text-caption text-muted-foreground">{engineName[source.engine]} · 只读</small></span>
          </label>
        })}
      </div>
      <DialogFooter className="items-center"><span className="text-label text-muted-foreground">已选 {selected.length} 个</span><span className="flex-1" /><Button type="button" variant="outline" size="sm" onClick={onClose}>取消</Button><Button type="button" size="sm" disabled={!selected.length} onClick={() => { onConfirm(selected); onClose() }}>确认选择</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
