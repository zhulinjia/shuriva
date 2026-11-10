import { createContext, useContext } from "react"
import type {
  ModuleAccess,
  OrderRecord,
  PermissionPolicy,
  Workspace,
} from "@/services"
import type { DayFilter, OrderChannel, OrderSort } from "./order-selectors"

/** State and derived results owned by the orders module. */
export type OrdersView = {
  workspace: Workspace
  policy: PermissionPolicy | null
  orders: readonly OrderRecord[]
  access: ModuleAccess
  available: boolean
  canExport: boolean
  showCost: boolean
  search: string
  days: DayFilter
  channel: OrderChannel
  sort: OrderSort
  page: number
  currentPage: number
  totalPages: number
  paged: OrderRecord[]
  filtered: OrderRecord[]
  totalAmount: number
  pendingCount: number
  setSearch: (value: string) => void
  setDays: (value: DayFilter) => void
  setChannel: (value: OrderChannel) => void
  setSort: (value: OrderSort) => void
  setPage: (update: number | ((current: number) => number)) => void
  resetFilters: () => void
}

export const OrdersViewContext = createContext<OrdersView | null>(null)

export function useOrdersView(): OrdersView {
  const view = useContext(OrdersViewContext)
  if (!view) {
    throw new Error("useOrdersView must be used within OrdersViewProvider")
  }
  return view
}
