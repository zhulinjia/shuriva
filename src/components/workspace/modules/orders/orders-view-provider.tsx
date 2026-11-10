import { useState, type ReactNode } from "react"
import type { Workspace, WorkspaceDataset } from "@/services"
import {
  isOrderCostVisible,
  paginateOrders,
  selectOrders,
  type DayFilter,
  type OrderChannel,
  type OrderSort,
} from "./order-selectors"
import { OrdersViewContext, type OrdersView } from "./orders-view-context"

type OrdersViewProviderProps = {
  workspace: Workspace
  dataset: WorkspaceDataset
  /** Effective customer id after validating it against the returned records. */
  customerId: string
  /** Increments on every customer selection so pagination starts over. */
  customerRevision: number
  children: ReactNode
}

export function OrdersViewProvider({
  workspace,
  dataset,
  customerId,
  customerRevision,
  children,
}: OrdersViewProviderProps) {
  const [search, setSearchState] = useState("")
  const [days, setDaysState] = useState<DayFilter>(workspace.config.defaultDays)
  const [channel, setChannelState] = useState<OrderChannel>("all")
  const [sort, setSortState] = useState<OrderSort>("date")
  const [pageState, setPageState] = useState({
    revision: customerRevision,
    page: 1,
  })
  const [daysSource, setDaysSource] = useState(workspace.config.defaultDays)

  // The saved default can change after an AI draft is saved; adjust the filter
  // during render instead of syncing it with an effect.
  if (daysSource !== workspace.config.defaultDays) {
    setDaysSource(workspace.config.defaultDays)
    setDaysState(workspace.config.defaultDays)
  }

  // A customer selection invalidates the stored page during render instead of
  // synchronising it with an effect.
  const page = pageState.revision === customerRevision ? pageState.page : 1

  const setPage = (update: number | ((current: number) => number)) => {
    setPageState((current) => {
      const base = current.revision === customerRevision ? current.page : 1
      const next = typeof update === "function" ? update(base) : update
      return { revision: customerRevision, page: next }
    })
  }

  const setSearch = (value: string) => {
    setSearchState(value)
    setPage(1)
  }

  const setDays = (value: DayFilter) => {
    setDaysState(value)
    setPage(1)
  }

  const setChannel = (value: OrderChannel) => {
    setChannelState(value)
    setPage(1)
  }

  const setSort = (value: OrderSort) => {
    setSortState(value)
  }

  const resetFilters = () => {
    setSearchState("")
    setDaysState("all")
    setChannelState("all")
    setSortState("date")
    setPage(1)
  }

  const { filtered, totalAmount, pendingCount } = selectOrders(dataset.orders, {
    customerId,
    search,
    days,
    channel,
    sort,
  })
  const { paged, totalPages, currentPage } = paginateOrders(filtered, page)

  const view: OrdersView = {
    workspace,
    policy: dataset.policy,
    orders: dataset.orders,
    access: dataset.access.orders,
    available: dataset.access.orders.ok,
    canExport: dataset.canExport,
    showCost: isOrderCostVisible(workspace, dataset),
    search,
    days,
    channel,
    sort,
    page,
    currentPage,
    totalPages,
    paged,
    filtered,
    totalAmount,
    pendingCount,
    setSearch,
    setDays,
    setChannel,
    setSort,
    setPage,
    resetFilters,
  }

  return <OrdersViewContext.Provider value={view}>{children}</OrdersViewContext.Provider>
}
