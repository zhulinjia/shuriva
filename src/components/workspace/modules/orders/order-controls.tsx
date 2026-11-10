import { Search } from "lucide-react"
import type { WorkspaceConfig } from "@/services"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DayFilter, OrderChannel, OrderSort } from "./order-selectors"
import { useOrdersView } from "./orders-view-context"

type ControlType = "order-search" | "order-days" | "order-channel" | "order-sort"

export function OrderControl({
  type,
  structural = false,
  onConfigChange,
}: {
  type: ControlType
  structural?: boolean
  onConfigChange?: (patch: Partial<WorkspaceConfig>) => void
}) {
  const view = useOrdersView()
  const disabled = structural || !view.available

  if (type === "order-search") {
    return (
      <div className="relative min-w-0">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={view.search} onChange={(event) => view.setSearch(event.target.value)} disabled={disabled}
          placeholder={structural ? "接入查询后可搜索" : "搜索订单、客户或可见邮箱"}
          aria-label="搜索订单、客户或可见邮箱" className="h-9 w-full pl-8 text-label" />
      </div>
    )
  }

  if (type === "order-days") {
    return (
      <Select items={{ "7": "近 7 天", "30": "近 30 天", all: "全部时间" }} value={view.days}
        disabled={!structural && !view.available}
        onValueChange={(value) => {
          const days = String(value) as DayFilter
          view.setDays(days)
          if (structural) onConfigChange?.({ defaultDays: days })
        }}>
        <SelectTrigger size="sm" className="h-9 w-full min-w-0 bg-card text-label" aria-label="订单时间范围"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="7">近 7 天</SelectItem><SelectItem value="30">近 30 天</SelectItem><SelectItem value="all">全部时间</SelectItem></SelectContent>
      </Select>
    )
  }

  if (type === "order-channel") {
    return (
      <Select items={{ all: "全部支付渠道", 微信支付: "微信支付", 支付宝: "支付宝", Stripe: "Stripe" }} value={view.channel} disabled={disabled}
        onValueChange={(value) => view.setChannel(String(value) as OrderChannel)}>
        <SelectTrigger size="sm" className="h-9 w-full min-w-0 bg-card text-label" aria-label="支付渠道"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">全部支付渠道</SelectItem><SelectItem value="微信支付">微信支付</SelectItem><SelectItem value="支付宝">支付宝</SelectItem><SelectItem value="Stripe">Stripe</SelectItem></SelectContent>
      </Select>
    )
  }

  return (
    <Select items={{ date: "时间倒序", amount: "金额从高到低" }} value={view.sort} disabled={disabled}
      onValueChange={(value) => view.setSort(String(value) as OrderSort)}>
      <SelectTrigger size="sm" className="h-9 w-full min-w-0 bg-card text-label" aria-label="订单排序"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="date">时间倒序</SelectItem><SelectItem value="amount">金额从高到低</SelectItem></SelectContent>
    </Select>
  )
}
