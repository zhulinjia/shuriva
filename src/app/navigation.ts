import type { LucideIcon } from "lucide-react"
import {
  Database,
  LayoutGrid,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Table2,
} from "lucide-react"

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

export type PageMeta = {
  label: string
  icon: LucideIcon
  parent?: {
    to: string
    label: string
  }
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/workspaces", label: "我的工作台", icon: LayoutGrid },
  { to: "/datasources", label: "数据源", icon: Database },
]

export const TEAM_NAV_ITEM: NavItem = {
  to: "/permissions",
  label: "成员与数据权限",
  icon: ShieldCheck,
}

/**
 * Community is a single-user edition and must not advertise team permission
 * management. The route stays registered for the team design preview, but the
 * sidebar only adds TEAM_NAV_ITEM while the team preview is selected.
 */
export function getPrimaryNav(edition: "community" | "team"): readonly NavItem[] {
  return edition === "team" ? [...PRIMARY_NAV, TEAM_NAV_ITEM] : PRIMARY_NAV
}

export const SETTINGS_NAV_ITEM: NavItem = {
  to: "/settings",
  label: "设置与演示",
  icon: Settings,
}

const PAGE_META: Record<string, PageMeta> = {
  // `/` immediately redirects to the workspace catalog; this meta only avoids
  // a "page not found" flash on the frame before the redirect resolves.
  "/": { label: "我的工作台", icon: LayoutGrid },
  "/workspaces": { label: "我的工作台", icon: LayoutGrid },
  "/datasources": { label: "数据源", icon: Database },
  "/permissions": { label: "成员与数据权限", icon: ShieldCheck },
  "/settings": { label: "设置与演示", icon: Settings },
}

const WORKSPACE_META: PageMeta = {
  label: "工作台",
  icon: Table2,
  parent: { to: "/workspaces", label: "我的工作台" },
}

const EDITOR_META: PageMeta = {
  label: "AI 编辑器",
  icon: Sparkles,
  parent: { to: "/workspaces", label: "我的工作台" },
}

const CREATE_META: PageMeta = {
  label: "创建工作台",
  icon: Sparkles,
  parent: { to: "/workspaces", label: "我的工作台" },
}

const NOT_FOUND_META: PageMeta = { label: "页面不存在", icon: Search }

export function getPageMeta(pathname: string): PageMeta {
  if (pathname.startsWith("/workspaces/")) return WORKSPACE_META
  if (pathname === "/create") return CREATE_META
  if (pathname === "/editor" || pathname.startsWith("/editor/")) {
    return EDITOR_META
  }

  return PAGE_META[pathname] ?? NOT_FOUND_META
}
