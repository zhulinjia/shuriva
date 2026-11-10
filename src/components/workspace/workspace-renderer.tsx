import { Link2, Lock, Settings2, ShieldCheck } from "lucide-react"
import { useState } from "react"
import type { BindingKey, Datasource, Workspace, WorkspaceConfig, WorkspaceDataset } from "@/services"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { sourceForBinding } from "./module-shared/binding-source"
import { ActivityModule } from "./modules/activity/activity-module"
import { CustomerDirectoryModule, CustomerProfileModule } from "./modules/customers/customer-module"
import { OrderControl } from "./modules/orders/order-controls"
import { OrdersSection } from "./modules/orders/orders-section"
import { WorkspaceMetric } from "./modules/orders/orders-summary"
import { OrdersViewProvider } from "./modules/orders/orders-view-provider"
import { BindingsDialog, DataNotesDialog } from "./workspace-info-dialogs"
import { WorkspaceStructuralBlock } from "./workspace-structural-block"
import type { StructuralBlockType } from "./workspace-structural-block"

type WorkspaceRendererProps = {
  workspace: Workspace
  datasources: readonly Datasource[]
  dataset: WorkspaceDataset
  compact?: boolean
  structural?: boolean
  onConfigChange?: (patch: Partial<WorkspaceConfig>) => void
  onOpenBindings?: () => void
  onEditBindings?: () => void
  onRestoreSource?: (sourceId: string) => void
  restoringSourceId?: string | null
  bindingsControl?: { open: boolean; onOpenChange: (open: boolean) => void }
}

export function WorkspaceRenderer({
  workspace, datasources, dataset, compact = false, structural = false,
  onConfigChange, onOpenBindings, onEditBindings, onRestoreSource, restoringSourceId,
  bindingsControl,
}: WorkspaceRendererProps) {
  const [customerSelection, setCustomerSelection] = useState({ customerId: "all", revision: 0 })
  const [internalBindingsOpen, setInternalBindingsOpen] = useState(false)
  const [moduleKey, setModuleKey] = useState<BindingKey | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const bindingsOpen = bindingsControl?.open ?? internalBindingsOpen
  const setBindingsOpen = bindingsControl?.onOpenChange ?? setInternalBindingsOpen
  const effectiveCustomerId = dataset.customers.some((customer) => customer.id === customerSelection.customerId) ? customerSelection.customerId : "all"
  const selectedCustomer = dataset.customers.find((customer) => customer.id === effectiveCustomerId)
  const policy = dataset.policy
  const selectCustomer = (customerId: string) => setCustomerSelection((current) => ({ customerId, revision: current.revision + 1 }))
  const openBindings = (key: BindingKey | null) => {
    if (onOpenBindings) { onOpenBindings(); return }
    setModuleKey(key)
    setBindingsOpen(true)
  }
  const ordersSource = sourceForBinding(datasources, workspace, "orders")
  const profileSource = sourceForBinding(datasources, workspace, "profile")
  const activitySource = sourceForBinding(datasources, workspace, "activity")

  const renderBlock = (type: StructuralBlockType) => {
    if (structural) return <WorkspaceStructuralBlock type={type} workspace={workspace} />
    if (type === "linkage") {
      return (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
          <Link2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <strong className="text-label font-medium text-foreground">客户联动</strong>
          <Select items={[{ value: "all", label: "全部授权客户" }, ...dataset.customers.map((customer) => ({ value: customer.id, label: `${customer.name} · ${customer.id}` }))]}
            value={effectiveCustomerId} onValueChange={(value) => selectCustomer(String(value))} disabled={!dataset.access.profile.ok}>
            <SelectTrigger size="sm" className="min-w-44 max-w-full bg-card" aria-label="选择要联动的客户"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部授权客户</SelectItem>{dataset.customers.map((customer) => <SelectItem key={customer.id} value={customer.id}>{customer.name} · {customer.id}</SelectItem>)}</SelectContent>
          </Select>
          <span className="min-w-0 flex-1 text-caption text-muted-foreground max-[1250px]:hidden">使用已确认的 <code>customer_id</code> 映射 · 非跨库 JOIN</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => openBindings(null)}><Settings2 aria-hidden="true" />查看绑定</Button>
        </div>
      )
    }
    if (type === "orders") return <OrdersSection workspaceKind={workspace.kind} source={ordersSource} onShowBindings={() => openBindings("orders")} onRestoreSource={onRestoreSource} restoringSourceId={restoringSourceId} />
    if (type === "activity") return <ActivityModule access={dataset.access.activity} trend={dataset.trend} activeCustomerCount={dataset.activeCustomerCount} hasSelectedCustomer={Boolean(selectedCustomer)} compact={compact} source={activitySource} onShowBindings={() => openBindings("activity")} onRestoreSource={onRestoreSource} restoringSourceId={restoringSourceId} />
    if (type === "directory") return <CustomerDirectoryModule access={dataset.access.profile} customers={dataset.customers} source={profileSource} onShowBindings={() => openBindings("profile")} onRestoreSource={onRestoreSource} restoringSourceId={restoringSourceId} />
    if (type === "profile") {
      return (
        <div className="grid gap-4">
          <CustomerProfileModule access={dataset.access.profile} customers={dataset.customers} selectedCustomer={selectedCustomer} policy={policy} showPhone={workspace.config.showPhone} source={profileSource} onSelect={(customer) => selectCustomer(customer.id)} onClear={() => selectCustomer("all")} onShowBindings={() => openBindings("profile")} onRestoreSource={onRestoreSource} restoringSourceId={restoringSourceId} />
          <div className="flex gap-2.5 px-2 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><div><strong className="block text-caption font-medium text-foreground">{policy ? `当前演示角色：${policy.label}` : "只读工作台"}</strong><p className="mt-1 text-caption leading-relaxed">{policy ? `${policy.description}。隐藏字段不会出现在此角色的详情和导出中。` : "各模块独立读取已绑定来源。工作台不会自动切换到其他数据库。"}</p></div></div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="min-w-0">
      <OrdersViewProvider workspace={workspace} dataset={dataset} customerId={effectiveCustomerId} customerRevision={customerSelection.revision}>
        <div className="workspace-canvas">
          {workspace.kind === "customer" ? <div className="workspace-linkage">{renderBlock("linkage")}</div> : null}
          <div className="workspace-metrics">
            <WorkspaceMetric type="metric-count" kind={workspace.kind} dataset={dataset} structural={structural} />
            <WorkspaceMetric type="metric-amount" kind={workspace.kind} dataset={dataset} structural={structural} />
            <WorkspaceMetric type="metric-pending" kind={workspace.kind} dataset={dataset} structural={structural} />
          </div>
          {workspace.kind === "members" ? renderBlock("directory") : (
            <div className={workspace.kind === "customer" ? "workspace-content workspace-content-customer" : "workspace-content"}>
              <div className="workspace-primary">
                <div className="workspace-filters">
                  <OrderControl type="order-search" structural={structural} onConfigChange={onConfigChange} />
                  <OrderControl type="order-days" structural={structural} onConfigChange={onConfigChange} />
                  <OrderControl type="order-channel" structural={structural} onConfigChange={onConfigChange} />
                  <OrderControl type="order-sort" structural={structural} onConfigChange={onConfigChange} />
                </div>
                {renderBlock("orders")}
                {workspace.kind === "customer" && workspace.config.showActivity ? renderBlock("activity") : null}
              </div>
              {workspace.kind === "customer" ? <div className="min-w-0">{renderBlock("profile")}</div> : null}
            </div>
          )}
        </div>
      </OrdersViewProvider>
      {!structural ? <div className="mt-4 flex flex-wrap items-start gap-2 text-caption text-muted-foreground"><Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /><p className="min-w-0 flex-1 leading-relaxed">前端展示只用于演示。正式的字段、记录范围和导出限制必须由可信服务端执行。</p><Button type="button" variant="ghost" size="xs" onClick={() => setNotesOpen(true)}>数据说明</Button></div> : null}
      {!onOpenBindings ? <BindingsDialog open={bindingsOpen} onOpenChange={setBindingsOpen} workspace={workspace} datasources={datasources} moduleKey={moduleKey} onEdit={onEditBindings} /> : null}
      {!structural ? <DataNotesDialog open={notesOpen} onOpenChange={setNotesOpen} workspace={workspace} datasources={datasources} policy={policy} /> : null}
    </div>
  )
}
