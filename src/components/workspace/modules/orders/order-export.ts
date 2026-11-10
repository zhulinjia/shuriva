import type { OrderRecord, Workspace } from "@/services"

const ORDERS_CSV_FILENAME = "shuriva-orders-mock.csv"

type OrderCsvInput = {
  rows: readonly OrderRecord[]
  allOrders: readonly OrderRecord[]
  workspace: Workspace
  showCost: boolean
}

/**
 * Builds the CSV from already permission-processed rows. Column presence
 * follows the workspace layout and the fields that survived redaction.
 */
export function buildOrdersCsv({
  rows,
  allOrders,
  workspace,
  showCost,
}: OrderCsvInput): string {
  const columns: [keyof OrderRecord, string][] = [
    ["id", "订单编号"],
    ["customer", "客户"],
    ["amount", "实付金额"],
    ["channel", "支付渠道"],
    ["status", "状态"],
    ["store", "门店"],
    ...(workspace.config.showPhone &&
    allOrders.some((order) => order.phone !== undefined)
      ? ([["phone", "手机号"]] as [keyof OrderRecord, string][])
      : []),
    ...(allOrders.some((order) => order.email !== undefined)
      ? ([["email", "邮箱"]] as [keyof OrderRecord, string][])
      : []),
    ...(showCost ? ([["cost", "成本"]] as [keyof OrderRecord, string][]) : []),
  ]

  const safeCell = (value: unknown) =>
    `"${String(value ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replace(/"/g, '""')}"`

  return (
    "﻿" +
    [
      columns.map(([, label]) => safeCell(label)).join(","),
      ...rows.map((row) =>
        columns.map(([key]) => safeCell(row[key])).join(",")
      ),
    ].join("\r\n")
  )
}

export function downloadOrdersCsv(csv: string) {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" })
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = ORDERS_CSV_FILENAME
  anchor.click()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
