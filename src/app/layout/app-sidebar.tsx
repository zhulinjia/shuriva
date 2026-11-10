import {
  ChevronsUpDown,
  Cloud,
  Plus,
  Server,
  Table2,
} from "lucide-react"
import { Link, useLocation } from "react-router"
import { getPrimaryNav, SETTINGS_NAV_ITEM, type NavItem } from "@/app/navigation"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"

export function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" aria-hidden="true">
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" fill="currentColor" />
      <path
        d="m3 12 9 5 9-5M3 16l9 5 9-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function isNavActive(pathname: string, item: Pick<NavItem, "to" | "end">) {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const workspaces = useWorkspaces()
  const edition = useDemoStore((state) => state.edition)
  const primaryNav = getPrimaryNav(edition)
  const recentWorkspaces = workspaces.data?.slice(0, 4) ?? []

  const closeMobileNav = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar collapsible="icon" aria-label="应用侧栏">
      <SidebarHeader>
        <SidebarMenu className="gap-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="我的工作台"
              render={<Link to="/workspaces" onClick={closeMobileNav} />}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <BrandGlyph />
              </div>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">Shuriva</span>
                <span className="truncate text-xs text-muted-foreground">
                  AI 业务工作台
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip={edition === "team" ? "团队工作空间" : "个人工作空间"}
              render={<Link to="/settings" onClick={closeMobileNav} />}
            >
              <div className="flex size-8 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar text-sm font-semibold">
                {edition === "team" ? "T" : "P"}
              </div>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">
                  {edition === "team" ? "团队工作空间" : "个人工作空间"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {edition === "team" ? "Team · 设计预览" : "Community · 自部署"}
                </span>
              </div>
              <ChevronsUpDown
                className="ml-auto size-4 group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  variant="outline"
                  tooltip="创建工作台"
                  render={<Link to="/create" onClick={closeMobileNav} />}
                >
                  <Plus aria-hidden="true" />
                  <span>创建工作台</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>导航</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu aria-label="主导航">
              {primaryNav.map((item) => {
                const Icon = item.icon
                const isActive = isNavActive(pathname, item)

                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      isActive={isActive}
                      render={
                        <Link
                          to={item.to}
                          onClick={closeMobileNav}
                        />
                      }
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.to === "/workspaces" && workspaces.data ? (
                      <SidebarMenuBadge>
                        {workspaces.data.length}
                      </SidebarMenuBadge>
                    ) : null}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>最近使用</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu
              aria-busy={workspaces.isPending}
              aria-label="最近使用的工作台"
            >
              {workspaces.isPending
                ? Array.from({ length: 3 }, (_, index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))
                : null}

              {workspaces.isError ? (
                <SidebarMenuItem>
                  <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                    <p>工作台列表加载失败</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="mt-1 h-auto p-0 text-destructive hover:bg-transparent"
                      onClick={() => void workspaces.refetch()}
                    >
                      重试
                    </Button>
                  </div>
                </SidebarMenuItem>
              ) : null}

              {!workspaces.isPending &&
              !workspaces.isError &&
              recentWorkspaces.length === 0 ? (
                <SidebarMenuItem>
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    还没有工作台。{" "}
                    <Link
                      to="/create"
                      onClick={closeMobileNav}
                      className="underline underline-offset-2"
                    >
                      创建第一个
                    </Link>
                  </p>
                </SidebarMenuItem>
              ) : null}

              {recentWorkspaces.map((workspace) => (
                <SidebarMenuItem key={workspace.id}>
                  <SidebarMenuButton
                    tooltip={workspace.title}
                    isActive={pathname === `/workspaces/${workspace.id}`}
                    render={
                      <Link
                        to={`/workspaces/${workspace.id}`}
                        onClick={closeMobileNav}
                      />
                    }
                  >
                    <Table2 aria-hidden="true" />
                    <span>{workspace.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-start gap-2 rounded-lg border border-sidebar-border bg-sidebar p-2 group-data-[collapsible=icon]:hidden">
              {edition === "team" ? (
                <Cloud
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <Server
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <strong className="block text-xs font-medium">
                  {edition === "team"
                    ? "云版体验预览"
                    : "后端直接连接数据库"}
                </strong>
                <span className="block text-xs text-muted-foreground">
                  {edition === "team"
                    ? "连接方案待定"
                    : "无需额外部署 Connector"}
                </span>
              </div>
            </div>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={SETTINGS_NAV_ITEM.label}
              isActive={isNavActive(pathname, SETTINGS_NAV_ITEM)}
              render={<Link to={SETTINGS_NAV_ITEM.to} onClick={closeMobileNav} />}
            >
              <SETTINGS_NAV_ITEM.icon aria-hidden="true" />
              <span>{SETTINGS_NAV_ITEM.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarSeparator />

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Shuriva Demo · 单用户 · 多数据源"
              className="group-data-[collapsible=icon]:justify-center"
              render={<Link to="/settings" onClick={closeMobileNav} />}
            >
              <Avatar size="sm">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold">
                  S
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">
                  Shuriva Demo
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  单用户 · 多数据源
                </span>
              </div>
              <Badge
                variant="secondary"
                className="h-5 shrink-0 px-1.5 text-[11px] group-data-[collapsible=icon]:hidden"
              >
                MOCK
              </Badge>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
