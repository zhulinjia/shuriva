import { MOCK_NOW } from "@/services"
import type { OrderRecord, Workspace, WorkspaceDataset } from "@/services"

export const ORDER_PAGE_SIZE = 6

export type DayFilter = "7" | "30" | "all"

export type OrderSort = "date" | "amount"

export type OrderChannel = "all" | OrderRecord["channel"]

export type OrderFilters = {
  customerId: string
  search: string
  days: DayFilter
  channel: OrderChannel
  sort: OrderSort
}

export type OrderSelection = {
  filtered: OrderRecord[]
  totalAmount: number
  pendingCount: number
}

export type OrderPage = {
  paged: OrderRecord[]
  totalPages: number
  currentPage: number
}

/** Applies the module's search, scope, date, channel and sort rules. */
export function selectOrders(
  orders: readonly OrderRecord[],
  filters: OrderFilters
): OrderSelection {
  const cutoff =
    filters.days === "all"
      ? null
      : Date.parse(MOCK_NOW) - Number(filters.days) * 86_400_000
  const query = filters.search.trim().toLowerCase()

  const filtered = orders
    .filter(
      (order) =>
        filters.customerId === "all" || order.customerId === filters.customerId
    )
    .filter((order) => cutoff === null || Date.parse(order.createdAt) >= cutoff)
    .filter(
      (order) => filters.channel === "all" || order.channel === filters.channel
    )
    .filter(
      (order) =>
        !query ||
        [order.id, order.customer, order.email ?? ""].some((value) =>
          value.toLowerCase().includes(query)
        )
    )
    .sort((left, right) =>
      filters.sort === "amount"
        ? right.amount - left.amount
        : Date.parse(right.createdAt) - Date.parse(left.createdAt)
    )

  return {
    filtered,
    totalAmount: filtered.reduce((sum, order) => sum + order.amount, 0),
    pendingCount: filtered.filter((order) => order.status !== "已完成").length,
  }
}

/** Clamps the requested page to the available result pages. */
export function paginateOrders(
  orders: readonly OrderRecord[],
  page: number
): OrderPage {
  const totalPages = Math.max(1, Math.ceil(orders.length / ORDER_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)

  return {
    paged: orders.slice(
      (currentPage - 1) * ORDER_PAGE_SIZE,
      currentPage * ORDER_PAGE_SIZE
    ),
    totalPages,
    currentPage,
  }
}

/**
 * Cost is only rendered when the workspace layout asks for it and the
 * returned records still carry raw cost values. Masked or hidden cost is
 * never treated as displayable.
 */
export function isOrderCostVisible(
  workspace: Workspace,
  dataset: WorkspaceDataset
): boolean {
  const costIsRaw = !dataset.policy || dataset.policy.fields.cost === "raw"

  return (
    workspace.config.showCost &&
    costIsRaw &&
    dataset.orders.some((order) => order.cost !== undefined)
  )
}
