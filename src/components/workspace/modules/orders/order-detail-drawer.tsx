import { Check, Copy, Lock, ShieldCheck, Table2 } from "lucide-react"
import { useState } from "react"
import type {
  OrderRecord,
  PermissionPolicy,
  Workspace,
} from "@/services"
import { cn } from "@/lib/utils"
import { formatCurrency, formatDateTime } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Notice } from "@/components/common/notice"
import { ORDER_STATUS_TONES } from "./order-status"

type OrderDetailDrawerProps = {
  order: OrderRecord | null
  workspace: Workspace
  policy: PermissionPolicy | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OrderDetailDrawer({
  order,
  workspace,
  policy,
  open,
  onOpenChange,
}: OrderDetailDrawerProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  )
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (!order) return null

  const showCost = workspace.config.showCost && order.cost !== undefined
  const showPhone = workspace.config.showPhone && order.phone !== undefined
  const copied = copyState === "copied" && copiedId === order.id

  const copyOrderId = async () => {
    try {
      await navigator.clipboard.writeText(order.id)
      setCopiedId(order.id)
      setCopyState("copied")
    } catch {
      setCopiedId(order.id)
      setCopyState("error")
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent className="sm:[--drawer-content-width:485px]">
        <DrawerHeader className="border-b border-border pb-4">
          <div className="flex items-start gap-3 pr-8">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Table2 className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 text-left">
              <DrawerTitle className="font-mono text-body">
                {order.id}
              </DrawerTitle>
              <DrawerDescription className="mt-0.5 text-label">
                {order.product} · 只读记录
              </DrawerDescription>
            </div>
            <Badge
              variant="outline"
              className={cn("font-normal", ORDER_STATUS_TONES[order.status])}
            >
              {order.status}
            </Badge>
          </div>
        </DrawerHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
          <dl className="divide-y divide-border">
            <DetailRow label="客户">
              <span className="inline-flex items-center gap-2">
                <span className="grid size-6 place-items-center rounded-full bg-muted text-caption font-medium text-muted-foreground">
                  {order.customer.slice(0, 1)}
                </span>
                {order.customer}
              </span>
            </DetailRow>
            <DetailRow label="实付金额">
              <span className="font-medium tabular-nums">
                {formatCurrency(order.amount)}
              </span>
            </DetailRow>
            {showCost ? (
              <DetailRow label="订单成本">
                <span className="tabular-nums">
                  {formatCurrency(order.cost ?? 0)}
                </span>
              </DetailRow>
            ) : null}
            <DetailRow label="支付渠道">{order.channel}</DetailRow>
            <DetailRow label="状态">
              <Badge
                variant="outline"
                className={cn("font-normal", ORDER_STATUS_TONES[order.status])}
              >
                {order.status}
              </Badge>
            </DetailRow>
            {showPhone ? (
              <DetailRow
                label="手机号"
                hint={
                  policy?.fields.phone === "masked" ? "脱敏展示" : undefined
                }
              >
                {order.phone}
              </DetailRow>
            ) : null}
            {order.email !== undefined ? (
              <DetailRow
                label="邮箱"
                hint={
                  policy?.fields.email === "masked" ? "脱敏展示" : undefined
                }
              >
                {order.email}
              </DetailRow>
            ) : null}
            <DetailRow label="所属门店">{order.store}</DetailRow>
            <DetailRow label="创建时间">
              {formatDateTime(order.createdAt)}
            </DetailRow>
          </dl>

          {policy ? (
            <Notice icon="lock" className="mt-4">
              当前按「{policy.label}」演示策略返回字段；隐藏字段不会出现在此详情和导出中。这不是服务端授权实现。
            </Notice>
          ) : (
            <Notice icon="lock" className="mt-4">
              只读预览，不提供退款或修改业务状态的操作。
            </Notice>
          )}

          <div className="mt-4 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              字段范围提示
            </p>
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              工作台的显示开关只影响布局；真实字段与记录权限必须由可信服务端在查询和返回时执行。
            </p>
          </div>
        </div>

        <DrawerFooter className="flex-row items-center border-t border-border pt-3">
          <span className="flex items-center gap-1 text-caption text-muted-foreground">
            <Lock className="size-3" aria-hidden="true" />
            只读
          </span>
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyOrderId()}
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            {copyState === "error" && copiedId === order.id
              ? "复制失败"
              : copied
                ? "已复制"
                : "复制订单号"}
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

function DetailRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-2.5 text-label">
      <dt className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {label}
        {hint ? (
          <Badge
            variant="outline"
            className="h-4 border-warning-border bg-warning-soft px-1 text-[10px] font-normal text-warning"
          >
            {hint}
          </Badge>
        ) : null}
      </dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  )
}
