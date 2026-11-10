import type { OrderRecord } from "@/services"

export const ORDER_STATUS_TONES: Record<OrderRecord["status"], string> = {
  履约超时: "border-warning-border bg-warning-soft text-warning",
  履约失败: "border-destructive/30/25 bg-destructive/10 text-destructive",
  状态不一致: "border-primary/20 bg-primary/10 text-primary",
  已完成: "border-success-border bg-success-soft text-success",
}
