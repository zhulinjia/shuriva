import { Database, Download } from "lucide-react"
import { useState } from "react"
import type { Datasource, Workspace } from "@/services"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ModuleFailure,
  ModuleFooter,
  ModuleHeading,
} from "../../module-shared/module-frame"
import { buildOrdersCsv, downloadOrdersCsv } from "./order-export"
import { ORDER_PAGE_SIZE } from "./order-selectors"
import { OrderDetailDrawer } from "./order-detail-drawer"
import { OrdersTable } from "./orders-table"
import { useOrdersView } from "./orders-view-context"

type ExportFeedback = {
  tone: "success" | "danger"
  text: string
}

type OrdersSectionProps = {
  workspaceKind: Workspace["kind"]
  source: Datasource | undefined
  onShowBindings: () => void
  onRestoreSource?: (sourceId: string) => void
  restoringSourceId?: string | null
}

export function OrdersSection({
  workspaceKind,
  source,
  onShowBindings,
  onRestoreSource,
  restoringSourceId,
}: OrdersSectionProps) {
  const {
    workspace,
    policy,
    orders,
    access,
    available,
    canExport,
    showCost,
    currentPage,
    totalPages,
    paged,
    filtered,
    setPage,
    resetFilters,
  } = useOrdersView()
  const [orderId, setOrderId] = useState<string | null>(null)
  const [exportState, setExportState] = useState<ExportFeedback | null>(null)

  const activeOrder = orders.find((order) => order.id === orderId)

  const exportOrders = () => {
    if (!available) {
      setExportState({
        tone: "danger",
        text: "订单来源当前不可用，无法导出。",
      })
      return
    }
    if (!canExport) {
      setExportState({
        tone: "danger",
        text: "当前演示角色不允许导出。",
      })
      return
    }

    downloadOrdersCsv(
      buildOrdersCsv({
        rows: filtered,
        allOrders: orders,
        workspace,
        showCost,
      })
    )
    setExportState({
      tone: "success",
      text: `已导出 ${filtered.length} 条授权范围内的模拟记录。`,
    })
  }

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <ModuleHeading
          title={workspaceKind === "orders" ? "异常订单" : "订单明细"}
          count={available ? filtered.length : undefined}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onShowBindings}
              >
                <Database aria-hidden="true" />
                来源
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!available || !canExport}
                title={
                  !canExport
                    ? "当前角色不允许导出"
                    : !available
                      ? "来源不可用"
                      : undefined
                }
                onClick={exportOrders}
              >
                <Download aria-hidden="true" />
                导出 CSV
              </Button>
            </>
          }
        />

        {available ? (
          <>
            {exportState ? (
              <p
                role="status"
                className={cn(
                  "mx-4 mb-2 rounded-md px-2.5 py-1.5 text-caption",
                  exportState.tone === "success"
                    ? "bg-success-soft text-success"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {exportState.text}
              </p>
            ) : null}

            <OrdersTable
              orders={paged}
              showCost={showCost}
              onOpen={(order) => setOrderId(order.id)}
              onResetFilters={resetFilters}
            />

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-caption text-muted-foreground">
              <span className="tabular-nums">
                显示{" "}
                {filtered.length ? (currentPage - 1) * ORDER_PAGE_SIZE + 1 : 0}–
                {Math.min(filtered.length, currentPage * ORDER_PAGE_SIZE)} 条，
                共 {filtered.length} 条
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={currentPage === 1}
                  onClick={() =>
                    setPage((current) => Math.max(1, current - 1))
                  }
                >
                  上一页
                </Button>
                <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-primary tabular-nums">
                  {currentPage}
                </span>
                <span className="px-0.5">/ {totalPages}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={currentPage === totalPages}
                  onClick={() =>
                    setPage((current) => Math.min(totalPages, current + 1))
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        ) : (
          <ModuleFailure
            access={access}
            onRestoreSource={onRestoreSource}
            restoringSourceId={restoringSourceId}
          />
        )}

        {available ? (
          <ModuleFooter
            source={source}
            fixedText={
              source ? `模拟更新时间 ${source.updatedAt}` : undefined
            }
          />
        ) : null}
      </section>

      <OrderDetailDrawer
        order={activeOrder ?? null}
        workspace={workspace}
        policy={policy}
        open={Boolean(activeOrder)}
        onOpenChange={(open) => {
          if (!open) setOrderId(null)
        }}
      />
    </>
  )
}
