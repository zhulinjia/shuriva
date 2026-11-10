import {
  MOCK_TREND,
  createInitialMockState,
  makeCustomers,
  makeOrders,
} from "./fixtures"
import type {
  BindingKey,
  CustomerRecord,
  Datasource,
  DatasourceInput,
  DatasourceStatus,
  ModuleAccess,
  MockDatabaseState,
  OrderRecord,
  PermissionPolicy,
  PolicySet,
  PreviewRole,
  RoleId,
  Workspace,
  WorkspaceDataset,
  WorkspaceScreen,
} from "./types"

const MOCK_LATENCY_MS = 180
const STORAGE_KEY = "shuriva-demo-v1"

const REQUIRED_TABLES: Record<BindingKey, string> = {
  orders: "orders",
  profile: "customers",
  activity: "user_events",
}

const BINDING_DOMAINS: Record<BindingKey, Datasource["domain"]> = {
  orders: "orders",
  profile: "members",
  activity: "events",
}

function wait(ms = MOCK_LATENCY_MS) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

function isMockDatabaseState(value: unknown): value is MockDatabaseState {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<MockDatabaseState>
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.datasources) &&
    Array.isArray(candidate.workspaces) &&
    typeof candidate.policies === "object" &&
    candidate.policies !== null
  )
}

function readState(): MockDatabaseState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return createInitialMockState()
    const parsed: unknown = JSON.parse(raw)
    return isMockDatabaseState(parsed) ? parsed : createInitialMockState()
  } catch {
    return createInitialMockState()
  }
}

/** A write must not replace unreadable existing data with fresh fixtures. */
function readStateForWrite(): MockDatabaseState {
  try {
    if (!globalThis.localStorage) throw new Error("missing storage")
    const raw = globalThis.localStorage.getItem(STORAGE_KEY)
    if (!raw) return createInitialMockState()
    const parsed: unknown = JSON.parse(raw)
    if (isMockDatabaseState(parsed)) return parsed
  } catch {
    throw new Error("浏览器存储无法读取，未覆盖已有数据；当前草稿仍保留。")
  }
  throw new Error("浏览器存储数据格式无效，未覆盖已有数据；当前草稿仍保留。")
}

let db = readState()

function persist() {
  try {
    if (!globalThis.localStorage) return false
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    return true
  } catch {
    // The preview still works in memory when browser storage is unavailable.
    return false
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

function resolvePolicy(role?: PreviewRole): PermissionPolicy | null {
  if (!role || role === "owner") return null
  return db.policies[role] ?? null
}

function rowAllowed(
  row: Pick<OrderRecord | CustomerRecord, "assignee" | "store">,
  policy: PermissionPolicy | null
) {
  if (!policy || policy.rowScope === "all") return true
  if (policy.rowScope === "store") return row.store === "杭州门店"
  return row.assignee === "support-01"
}

function maskPhone(value: string) {
  return value.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
}

function maskEmail(value: string) {
  return value.replace(/^(.).+(@.+)$/, "$1***$2")
}

function redactOrder(row: OrderRecord, policy: PermissionPolicy | null) {
  if (!policy) return row
  const result = { ...row }
  if (policy.fields.phone === "hidden") delete result.phone
  else if (policy.fields.phone === "masked" && result.phone) {
    result.phone = maskPhone(result.phone)
  }
  if (policy.fields.email === "hidden") delete result.email
  else if (policy.fields.email === "masked" && result.email) {
    result.email = maskEmail(result.email)
  }
  if (policy.fields.cost !== "raw") {
    // 成本目前没有安全的脱敏表示；masked 也按不可见处理，避免原文越界。
    delete result.cost
  }
  return result
}

function redactCustomer(row: CustomerRecord, policy: PermissionPolicy | null) {
  if (!policy) return row
  const result = { ...row }
  if (policy.fields.phone === "hidden") delete result.phone
  else if (policy.fields.phone === "masked" && result.phone) {
    result.phone = maskPhone(result.phone)
  }
  if (policy.fields.email === "hidden") delete result.email
  else if (policy.fields.email === "masked" && result.email) {
    result.email = maskEmail(result.email)
  }
  return result
}

function moduleAccess(
  workspace: Workspace,
  key: BindingKey,
  datasources: readonly Datasource[],
  policy: PermissionPolicy | null
): ModuleAccess {
  const sourceId = workspace.bindings[key]
  if (!sourceId) {
    return {
      ok: false,
      kind: "missing",
      title: "尚未绑定数据源",
      description: "在编辑器中为这个模块选择一个兼容的数据源。",
    }
  }

  const source = datasources.find((item) => item.id === sourceId)
  if (!source) {
    return {
      ok: false,
      kind: "missing",
      title: "数据源已不存在",
      description: "原数据源可能已被删除，请重新为模块选择来源。",
    }
  }

  if (policy && !policy.allowedSources.includes(sourceId)) {
    return {
      ok: false,
      kind: "denied",
      title: "没有数据源访问权限",
      description: "当前演示角色未获准使用此来源，其他已授权模块不受影响。",
      source,
    }
  }

  if (source.status === "offline") {
    return {
      ok: false,
      kind: "offline",
      title: "数据源暂时不可用",
      description: "模拟连接已断开。恢复此数据源后即可重新读取。",
      source,
    }
  }

  if (source.domain !== BINDING_DOMAINS[key]) {
    return {
      ok: false,
      kind: "table",
      title: "数据源类型不兼容",
      description: "请选择与此模块查询结构匹配的数据源。",
      source,
    }
  }

  if (!source.tables.includes(REQUIRED_TABLES[key])) {
    return {
      ok: false,
      kind: "table",
      title: `${REQUIRED_TABLES[key]} 表未获授权`,
      description: `此连接的可用表不包含 ${REQUIRED_TABLES[key]}。请由管理员调整授权范围。`,
      source,
    }
  }

  return { ok: true, source }
}

/**
 * Builds the mock query result for a workspace definition. Access, record
 * scope and field masking are applied here so the workspace and editor preview
 * share one data path. This is a browser-only simulation, not a security
 * boundary.
 */
export function buildWorkspaceDataset(
  workspace: Workspace,
  datasources: readonly Datasource[],
  role?: PreviewRole
): WorkspaceDataset {
  const policy = resolvePolicy(role)
  const access: Record<BindingKey, ModuleAccess> = {
    orders: moduleAccess(workspace, "orders", datasources, policy),
    profile: moduleAccess(workspace, "profile", datasources, policy),
    activity: moduleAccess(workspace, "activity", datasources, policy),
  }

  let orders: OrderRecord[] = []
  if (access.orders.ok && workspace.bindings.orders) {
    orders = makeOrders(workspace.bindings.orders)
      .filter((row) => rowAllowed(row, policy))
      .filter((row) => workspace.kind !== "orders" || row.status !== "已完成")
      .map((row) => redactOrder(row, policy))
  }

  let customers: CustomerRecord[] = []
  if (access.profile.ok) {
    customers = makeCustomers()
      .filter((row) => rowAllowed(row, policy))
      .map((row) => redactCustomer(row, policy))
  }

  const trend = access.activity.ok ? [...MOCK_TREND] : []

  return {
    orders,
    customers,
    trend,
    activeCustomerCount: access.profile.ok ? customers.length : 0,
    access,
    policy,
    canExport: !policy || policy.export,
  }
}

export async function listWorkspaces(): Promise<Workspace[]> {
  await wait()
  return clone(db.workspaces)
}

export async function listRecentWorkspaces(
  limit = 4
): Promise<Workspace[]> {
  const workspaces = await listWorkspaces()
  return workspaces.slice(0, limit)
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  await wait()
  const workspace = db.workspaces.find((item) => item.id === id)
  return workspace ? clone(workspace) : null
}

export async function listDatasources(): Promise<Datasource[]> {
  await wait()
  return clone(db.datasources)
}

export async function listPermissionPolicies(): Promise<PolicySet> {
  await wait()
  return clone(db.policies)
}

export async function getWorkspaceScreen(
  id: string,
  role?: PreviewRole
): Promise<WorkspaceScreen | null> {
  await wait()
  const workspace = db.workspaces.find((item) => item.id === id)
  if (!workspace) return null

  const datasources = clone(db.datasources)
  return {
    workspace: clone(workspace),
    datasources,
    dataset: clone(buildWorkspaceDataset(workspace, datasources, role)),
  }
}

export async function saveWorkspace(input: Workspace): Promise<Workspace> {
  await wait(140)
  // Read the latest saved version so another tab cannot be silently overwritten.
  const latest = readStateForWrite()
  const existing = latest.workspaces.find((item) => item.id === input.id)
  if ((existing && existing.version !== input.version) || (!existing && input.version !== 0)) {
    throw new Error("工作台已在其他页面修改或删除，当前草稿仍保留，请先核对其他页面的变更。")
  }
  const datasourceIds = [
    ...new Set([...input.datasourceIds, ...Object.values(input.bindings).filter(Boolean)]),
  ] as string[]

  const workspace: Workspace = {
    ...clone(input),
    title: input.title.trim(),
    datasourceIds,
    version: existing ? existing.version + 1 : 1,
    updatedAt: new Date().toISOString(),
  }

  const previous = db
  db = { ...latest, workspaces: existing
    ? latest.workspaces.map((item) =>
        item.id === workspace.id ? workspace : item
      )
    : [workspace, ...latest.workspaces] }
  if (!persist()) {
    db = previous
    throw new Error("浏览器存储不可用，无法保存工作台；当前草稿仍保留。")
  }
  return clone(workspace)
}

export async function renameWorkspace(id: string, title: string) {
  await wait(120)
  const latest = readStateForWrite()
  const workspace = latest.workspaces.find((item) => item.id === id)
  if (!workspace) throw new Error("工作台不存在")
  workspace.title = title.trim()
  workspace.version += 1
  workspace.updatedAt = new Date().toISOString()
  const previous = db
  db = latest
  if (!persist()) {
    db = previous
    throw new Error("浏览器存储不可用，无法重命名工作台。")
  }
  return clone(workspace)
}

export async function duplicateWorkspace(id: string) {
  await wait(120)
  const original = db.workspaces.find((item) => item.id === id)
  if (!original) throw new Error("工作台不存在")

  const copy: Workspace = {
    ...clone(original),
    id: makeId("workspace"),
    title: `${original.title} · 副本`,
    version: 1,
    updatedAt: new Date().toISOString(),
  }
  db.workspaces = [copy, ...db.workspaces]
  persist()
  return clone(copy)
}

export async function deleteWorkspace(id: string) {
  await wait(120)
  db.workspaces = db.workspaces.filter((item) => item.id !== id)
  persist()
}

export async function setDatasourceStatus(
  id: string,
  status: DatasourceStatus
) {
  await wait(120)
  const datasource = db.datasources.find((item) => item.id === id)
  if (!datasource) throw new Error("数据源不存在")
  datasource.status = status
  datasource.updatedAt = "刚刚"
  persist()
  return clone(datasource)
}

export async function addDatasource(
  input: DatasourceInput
): Promise<Datasource> {
  await wait(160)
  const datasource: Datasource = {
    ...clone(input),
    id: makeId("ds"),
    status: "connected",
    updatedAt: "刚刚",
  }
  db.datasources = [...db.datasources, datasource]
  persist()
  return clone(datasource)
}

export async function updateDatasource(
  id: string,
  input: DatasourceInput
): Promise<Datasource> {
  await wait(160)
  const existing = db.datasources.find((item) => item.id === id)
  if (!existing) throw new Error("数据源不存在")

  const referenced = db.workspaces.some((workspace) =>
    Object.entries(workspace.bindings).some(
      ([key, sourceId]) =>
        sourceId === id &&
        BINDING_DOMAINS[key as BindingKey] !== input.domain
    )
  )
  if (referenced) {
    throw new Error("此来源已被模块引用，不能直接变更其示例业务结构")
  }

  const datasource: Datasource = {
    ...existing,
    ...clone(input),
    id,
    updatedAt: "刚刚",
  }
  db.datasources = db.datasources.map((item) =>
    item.id === id ? datasource : item
  )
  persist()
  return clone(datasource)
}

export async function deleteDatasource(id: string) {
  await wait(120)
  const referenced = db.workspaces.some((workspace) =>
    workspace.datasourceIds.includes(id)
  )
  if (referenced) {
    throw new Error("请先解除所有工作台引用")
  }
  db.datasources = db.datasources.filter((item) => item.id !== id)
  persist()
}

export async function savePermissionPolicy(
  role: RoleId,
  policy: PermissionPolicy
) {
  await wait(120)
  db.policies = { ...db.policies, [role]: clone(policy) }
  persist()
  return clone(db.policies)
}

export async function resetDemoData() {
  await wait(120)
  db = createInitialMockState()
  persist()
}

export function getBindingDomain(key: BindingKey) {
  return BINDING_DOMAINS[key]
}

export function getBindingTable(key: BindingKey) {
  return REQUIRED_TABLES[key]
}

/** Checks the same source compatibility rules used by module access. */
export function isBindingCompatible(key: BindingKey, source: Datasource) {
  return (
    source.domain === BINDING_DOMAINS[key] &&
    source.tables.includes(REQUIRED_TABLES[key])
  )
}
