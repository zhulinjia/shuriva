import { Info, Settings2 } from "lucide-react"
import type { Datasource, Workspace, WorkspaceConfig, WorkspaceDataset } from "@/services"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { WorkspaceRenderer } from "@/components/workspace/workspace-renderer"

const EMPTY_DATASET: WorkspaceDataset = {
  orders: [], customers: [], trend: [], activeCustomerCount: 0,
  access: { orders: { ok: false }, profile: { ok: false }, activity: { ok: false } },
  policy: null, canExport: false,
}

export function StructuralPreview({ draft, datasources, titleError, onTitleChange, onConfigChange, onOpenBindings, onAddSource }: {
  draft: Workspace
  datasources: readonly Datasource[]
  titleError: boolean
  onTitleChange: (title: string) => void
  onConfigChange: (patch: Partial<WorkspaceConfig>) => void
  onOpenBindings: () => void
  onAddSource: () => void
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-normal">工作台结构</Badge>
        <Badge variant="outline" className="border-warning-border bg-warning-soft font-normal text-warning">尚未执行查询</Badge>
        <span className="ml-auto text-caption text-muted-foreground">未保存草稿</span>
      </div>
      <Input value={draft.title} onChange={(event) => onTitleChange(event.target.value)} aria-label="工作台名称" aria-invalid={titleError}
        aria-describedby={titleError ? "draft-title-error" : undefined} placeholder="工作台名称"
        className={cn("mt-2 h-auto border-transparent bg-transparent px-1 py-1 text-page-title font-semibold shadow-none hover:border-border focus-visible:border-ring", titleError && "border-destructive/50")} />
      {titleError ? <p id="draft-title-error" className="mt-1 text-caption text-destructive">工作台名称不能为空。</p> : null}
      <p className="mt-1 text-label leading-relaxed text-muted-foreground">当前展示工作台结构，指标、列表与趋势尚未读取业务数据。</p>
      <div className="my-4 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-caption leading-relaxed text-muted-foreground">每个模块的来源可在数据与模块中查看。正式查询和权限仍需由服务端执行。</p>
        <Button type="button" variant="ghost" size="xs" onClick={onOpenBindings}><Settings2 aria-hidden="true" />数据与模块</Button>
        {datasources.length === 0 ? <Button type="button" variant="outline" size="xs" onClick={onAddSource}>添加数据源</Button> : null}
      </div>
      <WorkspaceRenderer workspace={draft} datasources={datasources} dataset={EMPTY_DATASET} structural onConfigChange={onConfigChange} onOpenBindings={onOpenBindings} />
    </div>
  )
}
