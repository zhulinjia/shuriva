import { ChevronRight } from "lucide-react"
import type { OrderRecord } from "@/services"
import { cn } from "@/lib/utils"
import { formatCurrency, formatDateTime } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ORDER_STATUS_TONES } from "./order-status"

type OrdersTableProps = {
  orders: readonly OrderRecord[]
  showCost: boolean
  onOpen: (order: OrderRecord) => void
  onResetFilters: () => void
}

export function OrdersTable({
  orders,
  showCost,
  onOpen,
  onResetFilters,
}: OrdersTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead className="h-9 px-4 text-caption font-medium tracking-wide text-muted-foreground">
            订单编号
          </TableHead>
          <TableHead className="h-9 px-3 text-caption font-medium text-muted-foreground">
            客户
          </TableHead>
          <TableHead className="h-9 px-3 text-right text-caption font-medium text-muted-foreground">
            实付金额
          </TableHead>
          {showCost ? (
            <TableHead className="h-9 px-3 text-right text-caption font-medium text-muted-foreground">
              成本
            </TableHead>
          ) : null}
          <TableHead className="h-9 px-3 text-caption font-medium text-muted-foreground">
            支付渠道
          </TableHead>
          <TableHead className="h-9 px-3 text-caption font-medium text-muted-foreground">
            状态
          </TableHead>
          <TableHead className="h-9 px-3 text-caption font-medium text-muted-foreground">
            创建时间
          </TableHead>
          <TableHead className="w-10 px-2">
            <span className="sr-only">操作</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.length > 0 ? (
          orders.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              showCost={showCost}
              onOpen={() => onOpen(order)}
            />
          ))
        ) : (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={showCost ? 8 : 7}
              className="px-4 py-10 text-center whitespace-normal"
            >
              <p className="text-label font-medium text-foreground">
                没有符合条件的订单
              </p>
              <p className="mx-auto mt-1 max-w-sm text-caption leading-relaxed text-muted-foreground">
                调整筛选或搜索条件；当前角色的记录范围仍会生效。
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-3"
                onClick={onResetFilters}
              >
                重置筛选
              </Button>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

function OrderRow({
  order,
  showCost,
  onOpen,
}: {
  order: OrderRecord
  showCost: boolean
  onOpen: () => void
}) {
  return (
    <TableRow
      className="cursor-pointer"
      onClick={onOpen}
    >
      <TableCell className="px-4 py-2.5">
        <span className="block font-mono text-caption text-foreground">
          {order.id}
        </span>
        <span className="mt-0.5 block text-caption text-muted-foreground">
          {order.product}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <span className="flex items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-caption font-medium text-muted-foreground">
            {order.customer.slice(0, 1)}
          </span>
          <span className="min-w-0">
            <span className="block text-table text-foreground">
              {order.customer}
            </span>
            <span className="block max-w-40 truncate text-caption text-muted-foreground">
              {order.email ?? order.store}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5 text-right text-table font-medium text-foreground tabular-nums">
        {formatCurrency(order.amount)}
      </TableCell>
      {showCost ? (
        <TableCell className="px-3 py-2.5 text-right text-table text-muted-foreground tabular-nums">
          {order.cost === undefined ? "不可见" : formatCurrency(order.cost)}
        </TableCell>
      ) : null}
      <TableCell className="px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-table text-foreground">
          <span
            className={cn(
              "grid size-4 place-items-center rounded-sm text-[9px] font-semibold",
              order.channel === "Stripe"
                ? "bg-primary/10 text-primary"
                : order.channel === "支付宝"
                  ? "bg-info-soft text-info"
                  : "bg-success-soft text-success"
            )}
            aria-hidden="true"
          >
            {order.channel === "Stripe" ? "S" : order.channel.slice(0, 1)}
          </span>
          {order.channel}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <Badge
          variant="outline"
          className={cn("gap-1 font-normal", ORDER_STATUS_TONES[order.status])}
        >
          <span className="size-1 rounded-full bg-current" aria-hidden="true" />
          {order.status}
        </Badge>
      </TableCell>
      <TableCell className="px-3 py-2.5 text-caption text-muted-foreground">
        {formatDateTime(order.createdAt)}
      </TableCell>
      <TableCell className="px-2 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`查看订单 ${order.id}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  )
}
