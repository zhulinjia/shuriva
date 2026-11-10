import { getBindingDomain, isBindingCompatible } from "@/services"
import type {
  BindingKey,
  Datasource,
  Workspace,
  WorkspaceConfig,
  WorkspaceKind,
} from "@/services"

export const WORKSPACE_KIND_LABELS: Record<WorkspaceKind, string> = {
  customer: "客户业务工作台",
  orders: "订单管理工作台",
  members: "会员订阅工作台",
}

export const WORKSPACE_PRESETS: Record<
  WorkspaceKind,
  { title: string; description: string }
> = {
  customer: {
    title: "客户业务总览",
    description: "把客户资料、订单和使用情况放在同一个工作台。",
  },
  orders: {
    title: "异常订单排查",
    description: "定位已支付但未履约的订单，核查业务异常。",
  },
  members: {
    title: "高价值客户检索",
    description: "查看会员资料与订阅状态。",
  },
}

export const BINDING_LABELS: Record<BindingKey, string> = {
  orders: "订单明细",
  profile: "客户资料",
  activity: "使用趋势",
}

const KIND_REQUIRED_DOMAINS: Record<
  WorkspaceKind,
  readonly Datasource["domain"][]
> = {
  customer: ["orders", "members"],
  orders: ["orders"],
  members: ["members"],
}

const KIND_REQUIRED_TABLES: Record<WorkspaceKind, string> = {
  customer: "orders 与 customers",
  orders: "orders",
  members: "customers",
}

export function makeWorkspaceId() {
  return `workspace-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

export function inferWorkspaceKind(prompt: string): WorkspaceKind | null {
  const mentionsOrders = /订单|履约|支付|退款|消费/.test(prompt)
  const mentionsMembers = /会员|客户|订阅|用户/.test(prompt)

  if (mentionsOrders && mentionsMembers) return "customer"
  if (mentionsMembers) return "members"
  if (mentionsOrders) return "orders"
  return null
}

function findSource(
  domain: Datasource["domain"],
  allowedIds: readonly string[],
  datasources: readonly Datasource[]
) {
  const candidates = allowedIds
    .map((id) => datasources.find((source) => source.id === id))
    .filter(
      (source): source is Datasource =>
        Boolean(source) && source?.domain === domain
    )

  return (
    candidates.find((source) => source.status === "connected") ?? candidates[0]
  )
}

export function isWorkspaceKindAvailable(
  kind: WorkspaceKind,
  allowedIds: readonly string[],
  datasources: readonly Datasource[]
) {
  return KIND_REQUIRED_DOMAINS[kind].every((domain) =>
    findSource(domain, allowedIds, datasources)
  )
}

export type ResolvedCreationKind =
  | { kind: WorkspaceKind; problem: null }
  | { kind: null; problem: string }

/**
 * Resolves the template implied by the prompt (or falls back to an available
 * one) without silently swapping an explicit request for a different kind.
 */
export function resolveCreationKind(
  prompt: string,
  allowedIds: readonly string[],
  datasources: readonly Datasource[]
): ResolvedCreationKind {
  const requested = inferWorkspaceKind(prompt)

  if (requested) {
    if (isWorkspaceKindAvailable(requested, allowedIds, datasources)) {
      return { kind: requested, problem: null }
    }
    return {
      kind: null,
      problem: `所选数据源缺少 ${KIND_REQUIRED_TABLES[requested]} 表，无法生成「${WORKSPACE_KIND_LABELS[requested]}」。请更换或添加数据源。`,
    }
  }

  for (const kind of ["customer", "orders", "members"] as const) {
    if (isWorkspaceKindAvailable(kind, allowedIds, datasources)) {
      return { kind, problem: null }
    }
  }

  return {
    kind: null,
    problem:
      "所选数据源中没有可用的订单或客户数据表。请更换数据源，或先连接包含 orders / customers 表的数据库。",
  }
}

function requiredBindingKeys(
  kind: WorkspaceKind,
  config: Pick<WorkspaceConfig, "showActivity">
): BindingKey[] {
  if (kind === "customer") {
    return [
      "orders",
      "profile",
      ...(config.showActivity ? (["activity"] as const) : []),
    ]
  }
  return kind === "orders" ? ["orders"] : ["profile"]
}

export function requiredBindings(workspace: Workspace): BindingKey[] {
  return requiredBindingKeys(workspace.kind, workspace.config)
}

export function buildNewDraft(
  kind: WorkspaceKind,
  allowedIds: readonly string[],
  datasources: readonly Datasource[],
  options?: { title?: string; description?: string }
): Workspace {
  const orders = findSource("orders", allowedIds, datasources)?.id
  const profile = findSource("members", allowedIds, datasources)?.id
  const activity = findSource("events", allowedIds, datasources)?.id

  const bindings: Workspace["bindings"] =
    kind === "customer"
      ? {
          ...(orders ? { orders } : {}),
          ...(profile ? { profile } : {}),
          ...(activity ? { activity } : {}),
        }
      : kind === "orders"
        ? orders
          ? { orders }
          : {}
        : profile
          ? { profile }
          : {}

  return {
    id: makeWorkspaceId(),
    title: options?.title ?? WORKSPACE_PRESETS[kind].title,
    description: options?.description ?? WORKSPACE_PRESETS[kind].description,
    kind,
    datasourceIds: [...allowedIds],
    bindings,
    version: 0,
    config: {
      showActivity: kind === "customer" && Boolean(activity),
      showPhone: true,
      showCost: false,
      defaultDays: "30",
    },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Keeps existing module bindings when sources change, and only fills required
 * modules that no longer have a usable source. Never silently rebinds a module
 * that still points at a selected source.
 */
export function reconcileWorkspaceSources(
  workspace: Workspace,
  allowedIds: readonly string[],
  datasources: readonly Datasource[]
): Workspace {
  const validIds = allowedIds.filter((id) =>
    datasources.some((source) => source.id === id)
  )

  const bindings = { ...workspace.bindings }

  for (const key of Object.keys(bindings) as BindingKey[]) {
    const sourceId = bindings[key]
    const source = datasources.find((item) => item.id === sourceId)
    if (
      !sourceId ||
      !validIds.includes(sourceId) ||
      !source ||
      source.domain !== getBindingDomain(key)
    ) {
      bindings[key] = undefined
    }
  }

  for (const key of requiredBindingKeys(workspace.kind, {
    showActivity: workspace.config.showActivity,
  })) {
    if (!bindings[key]) {
      bindings[key] = findSource(
        getBindingDomain(key),
        validIds,
        datasources
      )?.id
    }
  }

  const showActivity =
    workspace.kind === "customer" &&
    workspace.config.showActivity &&
    Boolean(bindings.activity)

  return {
    ...workspace,
    datasourceIds: validIds,
    bindings,
    config: { ...workspace.config, showActivity },
  }
}

export function findMissingBindings(
  workspace: Workspace,
  datasources: readonly Datasource[]
): BindingKey[] {
  return requiredBindings(workspace).filter((key) => {
    const sourceId = workspace.bindings[key]
    const source = datasources.find((item) => item.id === sourceId)
    return !source || !isBindingCompatible(key, source)
  })
}
