import { Clock3, Table2, Users, Wallet } from "lucide-react"
import type { WorkspaceDataset, WorkspaceKind } from "@/services"
import { formatCurrency } from "@/lib/format"
import { Metric } from "../../module-shared/module-frame"
import { useOrdersView } from "./orders-view-context"

type MetricType = "metric-count" | "metric-amount" | "metric-pending"

/** Metrics share the order filter state in the saved view and preview. */
export function WorkspaceMetric({
  type,
  kind,
  dataset,
  structural = false,
}: {
  type: MetricType
  kind: WorkspaceKind
  dataset: WorkspaceDataset
  structural?: boolean
}) {
  const { available, filtered, totalAmount, pendingCount } = useOrdersView()
  const members = kind === "members"
  const usable = members ? dataset.access.profile.ok : available
  const showValue = !structural && usable
  const metric = members
    ? type === "metric-count"
      ? { label: "客户总数", icon: Users, value: dataset.customers.length, unit: "位", description: "当前授权范围内的客户" }
      : type === "metric-amount"
        ? { label: "已授权客户", icon: Users, value: dataset.customers.length, unit: "位", description: "按当前演示策略展示" }
        : { label: "方案分布", icon: Table2, value: new Set(dataset.customers.map((customer) => customer.plan)).size, unit: "种", description: "当前客户的方案类型" }
    : type === "metric-count"
      ? { label: "匹配订单", icon: Table2, value: filtered.length, unit: "笔", description: "当前筛选与记录权限范围" }
      : type === "metric-amount"
        ? { label: "实付金额", icon: Wallet, value: formatCurrency(totalAmount), unit: undefined, description: "按订单去重，不仅统计当前页" }
        : { label: "待核查订单", icon: Clock3, value: pendingCount, unit: "笔", description: "履约超时、失败或状态不一致" }

  return (
    <div className="h-full min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <Metric
        label={metric.label}
        icon={metric.icon}
        value={showValue ? metric.value : "--"}
        unit={showValue ? metric.unit : undefined}
        description={structural ? "等待查询返回" : usable ? metric.description : "数据来源当前不可用"}
      />
    </div>
  )
}
