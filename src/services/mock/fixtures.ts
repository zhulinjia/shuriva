import type {
  CustomerRecord,
  Datasource,
  MockDatabaseState,
  OrderRecord,
  PolicySet,
  Workspace,
} from "./types"

export const MOCK_NOW = "2026-11-08T14:32:00+08:00"

const CUSTOMER_NAMES = [
  "陈以宁",
  "林予安",
  "王知远",
  "张可欣",
  "周一航",
  "李沐晴",
  "赵书言",
  "许亦辰",
] as const

const CUSTOMER_SLUGS = [
  "yining.chen",
  "yuan.lin",
  "zhiyuan.wang",
  "kexin.zhang",
  "yihang.zhou",
  "muqing.li",
  "shuyan.zhao",
  "yichen.xu",
] as const

const AMOUNTS = [899, 129, 249, 1299, 499, 199, 2499, 59] as const
const COSTS = [420, 60, 95, 680, 230, 90, 1100, 20] as const
const CHANNELS = ["微信支付", "支付宝", "Stripe"] as const
const STATUSES = ["履约超时", "履约失败", "状态不一致", "已完成"] as const
const PRODUCTS = ["专业版年费", "团队版月费", "API 用量包"] as const

export const MOCK_DATASOURCES: readonly Datasource[] = [
  {
    id: "orders",
    name: "订单生产库",
    engine: "PostgreSQL",
    environment: "生产",
    host: "orders.internal.example",
    port: "5432",
    database: "commerce",
    status: "connected",
    tables: ["orders", "payments"],
    domain: "orders",
    ssl: true,
    updatedAt: "14:32",
  },
  {
    id: "members",
    name: "会员中心",
    engine: "MySQL",
    environment: "生产",
    host: "members.internal.example",
    port: "3306",
    database: "crm",
    status: "connected",
    tables: ["customers", "subscriptions"],
    domain: "members",
    ssl: true,
    updatedAt: "14:32",
  },
  {
    id: "events",
    name: "行为分析仓",
    engine: "ClickHouse",
    environment: "分析",
    host: "analytics.internal.example",
    port: "8443",
    database: "analytics",
    status: "connected",
    tables: ["user_events"],
    domain: "events",
    ssl: true,
    updatedAt: "14:32",
  },
  {
    id: "orders-test",
    name: "订单测试库",
    engine: "PostgreSQL",
    environment: "测试",
    host: "127.0.0.1",
    port: "5432",
    database: "commerce_test",
    status: "offline",
    tables: ["orders", "payments"],
    domain: "orders",
    ssl: false,
    updatedAt: "昨天 17:20",
  },
]

export const MOCK_WORKSPACES: readonly Workspace[] = [
  {
    id: "customer-360",
    title: "客户业务总览",
    description: "把客户资料、订单和使用情况放在同一个工作台。",
    kind: "customer",
    datasourceIds: ["orders", "members", "events"],
    bindings: { orders: "orders", profile: "members", activity: "events" },
    version: 3,
    config: {
      showActivity: true,
      showPhone: true,
      showCost: true,
      defaultDays: "30",
    },
    updatedAt: "2026-11-08T14:30:00+08:00",
  },
  {
    id: "order-exceptions",
    title: "异常订单排查",
    description: "定位已支付但未履约的订单，快速核查异常原因。",
    kind: "orders",
    datasourceIds: ["orders"],
    bindings: { orders: "orders" },
    version: 2,
    config: {
      showActivity: false,
      showPhone: true,
      showCost: true,
      defaultDays: "7",
    },
    updatedAt: "2026-11-07T10:20:00+08:00",
  },
  {
    id: "members-view",
    title: "高价值客户检索",
    description: "查看会员资料与订阅状态，定位需要重点跟进的客户。",
    kind: "members",
    datasourceIds: ["members"],
    bindings: { profile: "members" },
    version: 1,
    config: {
      showActivity: false,
      showPhone: true,
      showCost: false,
      defaultDays: "30",
    },
    updatedAt: "2026-11-06T09:40:00+08:00",
  },
]

export const MOCK_POLICIES: PolicySet = {
  support: {
    label: "客服",
    description: "只查看自己负责的订单",
    fields: { phone: "masked", cost: "hidden", email: "masked" },
    rowScope: "assigned",
    export: false,
    aiSensitive: false,
    allowedSources: ["orders", "members", "events", "orders-test"],
  },
  finance: {
    label: "财务",
    description: "查看公司范围内的财务数据",
    fields: { phone: "hidden", cost: "raw", email: "hidden" },
    rowScope: "all",
    export: true,
    aiSensitive: false,
    allowedSources: ["orders", "members", "events", "orders-test"],
  },
  operator: {
    label: "门店运营",
    description: "仅查看杭州门店的数据",
    fields: { phone: "masked", cost: "hidden", email: "masked" },
    rowScope: "store",
    export: false,
    aiSensitive: false,
    allowedSources: ["orders", "members", "orders-test"],
  },
}

export const MOCK_TREND = [18, 32, 26, 40, 30, 57, 44, 66, 52, 70, 60, 83]

export function makeOrders(sourceId: string): OrderRecord[] {
  const prefix =
    sourceId === "orders"
      ? "ORD"
      : sourceId === "orders-test"
        ? "TEST"
        : `DEMO-${sourceId.slice(-4).toUpperCase()}`

  return Array.from({ length: 48 }, (_, index) => ({
    id: `${prefix}-261108-${1048 - index}`,
    customerId: `CUS-${1001 + (index % 8)}`,
    customer: CUSTOMER_NAMES[index % 8],
    email: `${CUSTOMER_SLUGS[index % 8]}@example.com`,
    phone: `138${String(20105678 + (index % 8)).padStart(8, "0")}`,
    amount: AMOUNTS[index % 8],
    cost: COSTS[index % 8],
    channel: CHANNELS[index % 3],
    status: STATUSES[index % 4],
    createdAt: new Date(
      Date.parse(MOCK_NOW) - index * 5 * 3600_000
    ).toISOString(),
    store: index % 2 ? "上海门店" : "杭州门店",
    assignee: index % 3 === 0 ? "support-01" : "support-02",
    product: PRODUCTS[index % 3],
  }))
}

export function makeCustomers(): CustomerRecord[] {
  return CUSTOMER_NAMES.map((name, index) => ({
    id: `CUS-${1001 + index}`,
    name,
    email: `${CUSTOMER_SLUGS[index]}@example.com`,
    phone: `138${String(20105678 + index).padStart(8, "0")}`,
    plan: index % 3 === 0 ? "团队版" : "专业版",
    store: index % 2 ? "上海门店" : "杭州门店",
    assignee: index % 3 === 0 ? "support-01" : "support-02",
    registered: `2026-08-${String(10 + index).padStart(2, "0")}`,
  }))
}

export function createInitialMockState(): MockDatabaseState {
  return {
    schemaVersion: 1,
    datasources: structuredClone([...MOCK_DATASOURCES]),
    workspaces: structuredClone([...MOCK_WORKSPACES]),
    policies: structuredClone(MOCK_POLICIES),
  }
}
