export type DatasourceEngine = "PostgreSQL" | "MySQL" | "ClickHouse"

export type DatasourceStatus = "connected" | "offline"

export type DatasourceDomain = "orders" | "members" | "events"

export type DatasourceEnvironment = "生产" | "测试" | "分析"

export interface Datasource {
  id: string
  name: string
  engine: DatasourceEngine
  environment: DatasourceEnvironment
  host: string
  port: string
  database: string
  status: DatasourceStatus
  tables: string[]
  domain: DatasourceDomain
  ssl: boolean
  updatedAt: string
}

export type WorkspaceKind = "customer" | "orders" | "members"

export type BindingKey = "orders" | "profile" | "activity"

export type WorkspaceBindings = Partial<Record<BindingKey, string>>

export interface WorkspaceConfig {
  showActivity: boolean
  showPhone: boolean
  showCost: boolean
  defaultDays: "7" | "30" | "all"
}

export interface Workspace {
  id: string
  title: string
  description: string
  kind: WorkspaceKind
  datasourceIds: string[]
  bindings: WorkspaceBindings
  version: number
  config: WorkspaceConfig
  /** Retained only to avoid discarding layout data saved by earlier versions. */
  layout?: unknown
  updatedAt: string
}

export type WorkspaceSummary = Workspace

export type FieldAccess = "raw" | "masked" | "hidden"

export type RowScope = "all" | "assigned" | "store"

export type RoleId = "support" | "finance" | "operator"

export type PreviewRole = "owner" | RoleId

export type ProductEdition = "community" | "team"

export type PolicyField = "phone" | "email" | "cost"

export interface PermissionPolicy {
  label: string
  description: string
  fields: Record<PolicyField, FieldAccess>
  rowScope: RowScope
  export: boolean
  aiSensitive: boolean
  allowedSources: string[]
}

export type PolicySet = Record<RoleId, PermissionPolicy>

export interface OrderRecord {
  id: string
  customerId: string
  customer: string
  email?: string
  phone?: string
  amount: number
  cost?: number
  channel: "微信支付" | "支付宝" | "Stripe"
  status: "履约超时" | "履约失败" | "状态不一致" | "已完成"
  createdAt: string
  store: "上海门店" | "杭州门店"
  assignee: "support-01" | "support-02"
  product: string
}

export interface CustomerRecord {
  id: string
  name: string
  email?: string
  phone?: string
  plan: "团队版" | "专业版"
  store: "上海门店" | "杭州门店"
  assignee: "support-01" | "support-02"
  registered: string
}

export type ModuleFailureKind = "missing" | "denied" | "offline" | "table"

export interface ModuleAccess {
  ok: boolean
  kind?: ModuleFailureKind
  title?: string
  description?: string
  source?: Datasource
}

export interface WorkspaceDataset {
  orders: OrderRecord[]
  customers: CustomerRecord[]
  trend: number[]
  activeCustomerCount: number
  access: Record<BindingKey, ModuleAccess>
  policy: PermissionPolicy | null
  canExport: boolean
}

export interface WorkspaceScreen {
  workspace: Workspace
  datasources: Datasource[]
  dataset: WorkspaceDataset
}

export interface DatasourceInput {
  name: string
  engine: DatasourceEngine
  environment: DatasourceEnvironment
  host: string
  port: string
  database: string
  domain: DatasourceDomain
  tables: string[]
  ssl: boolean
}

export interface MockDatabaseState {
  schemaVersion: 1
  datasources: Datasource[]
  workspaces: Workspace[]
  policies: PolicySet
}
