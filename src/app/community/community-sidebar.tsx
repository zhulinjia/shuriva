import { Database, LayoutGrid, LogOut, Plus, Server, Settings, Table2 } from "lucide-react"
import { Link } from "react-router"
import { BrandGlyph } from "@/app/layout/app-sidebar"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarSeparator, useSidebar } from "@/components/ui/sidebar"
import type { LiveWorkspace } from "@/services/community-api"
import type { LiveWorkspaceSelection } from "./workspaces-page"

export type CommunitySection = "workspaces" | "sources" | "settings"

export function CommunitySidebar({ section, selection, workspaces, workspacesLoading, workspacesError, username, onSection, onSelect, onLogout, canLeave }: {
  section: CommunitySection
  selection: LiveWorkspaceSelection
  workspaces: readonly LiveWorkspace[]
  workspacesLoading: boolean
  workspacesError: boolean
  username: string
  onSection: (section: CommunitySection) => void
  onSelect: (selection: LiveWorkspaceSelection) => void
  onLogout: () => void
  canLeave: () => boolean
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = () => { if (isMobile) setOpenMobile(false) }
  const sectionClick = (next: CommunitySection) => { onSection(next); closeMobile() }
  const selectClick = (next: LiveWorkspaceSelection) => { onSelect(next); closeMobile() }
  return <Sidebar collapsible="icon" aria-label="应用侧栏">
    <SidebarHeader><SidebarMenu className="gap-2">
      <SidebarMenuItem><SidebarMenuButton size="lg" tooltip="我的工作台" onClick={() => selectClick(null)}>
        <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><BrandGlyph /></div>
        <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden"><span className="truncate font-semibold">Shuriva</span><span className="truncate text-xs text-muted-foreground">AI 业务工作台</span></div>
      </SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton size="lg" tooltip="个人工作空间" onClick={() => sectionClick("settings")}>
        <div className="flex size-8 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar text-sm font-semibold">P</div>
        <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden"><span className="truncate text-sm font-medium">个人工作空间</span><span className="truncate text-xs text-muted-foreground">Community · 自部署</span></div>
      </SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu></SidebarHeader>
    <SidebarContent>
      <SidebarGroup><SidebarGroupContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton variant="outline" tooltip="创建工作台" onClick={() => selectClick("new")}><Plus aria-hidden="true" /><span>创建工作台</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarGroupContent></SidebarGroup>
      <SidebarGroup><SidebarGroupLabel>导航</SidebarGroupLabel><SidebarGroupContent><SidebarMenu aria-label="主导航">
        <SidebarMenuItem><SidebarMenuButton tooltip="我的工作台" isActive={section === "workspaces" && selection === null} onClick={() => selectClick(null)}><LayoutGrid aria-hidden="true" /><span>我的工作台</span></SidebarMenuButton>{!workspacesLoading && !workspacesError && <SidebarMenuBadge>{workspaces.length}</SidebarMenuBadge>}</SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton tooltip="数据源" isActive={section === "sources"} onClick={() => sectionClick("sources")}><Database aria-hidden="true" /><span>数据源</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu></SidebarGroupContent></SidebarGroup>
      <SidebarGroup><SidebarGroupLabel>最近使用</SidebarGroupLabel><SidebarGroupContent><SidebarMenu aria-label="最近使用的工作台">
        {workspacesLoading ? <SidebarMenuItem><p className="px-2 py-1 text-xs text-muted-foreground">正在读取工作台…</p></SidebarMenuItem> : workspacesError ? <SidebarMenuItem><p className="px-2 py-1 text-xs text-destructive">工作台读取失败。</p></SidebarMenuItem> : workspaces.length ? workspaces.slice(0, 4).map((workspace) => <SidebarMenuItem key={workspace.id}><SidebarMenuButton tooltip={workspace.document.title} isActive={typeof selection === "object" && selection?.id === workspace.id && section === "workspaces"} onClick={() => selectClick(workspace)}><Table2 aria-hidden="true" /><span>{workspace.document.title}</span></SidebarMenuButton></SidebarMenuItem>) : <SidebarMenuItem><p className="px-2 py-1 text-xs text-muted-foreground">还没有工作台。</p></SidebarMenuItem>}
      </SidebarMenu></SidebarGroupContent></SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarMenu>
      <SidebarMenuItem><div className="flex items-start gap-2 rounded-lg border border-sidebar-border bg-sidebar p-2 group-data-[collapsible=icon]:hidden"><Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><strong className="block text-xs font-medium">后端直接连接数据库</strong><span className="block text-xs text-muted-foreground">无需额外部署 Connector</span></div></div></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton tooltip="设置" isActive={section === "settings"} onClick={() => sectionClick("settings")}><Settings aria-hidden="true" /><span>设置</span></SidebarMenuButton></SidebarMenuItem>
      <SidebarMenuItem><SidebarMenuButton tooltip="查看设计演示" render={<Link to="/workspaces" onClick={(event) => { if (!canLeave()) event.preventDefault(); else closeMobile() }} />}><LayoutGrid aria-hidden="true" /><span>设计演示 · 模拟功能</span></SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu><SidebarSeparator /><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" tooltip="退出登录" aria-label="退出登录" onClick={onLogout}><Avatar size="sm"><AvatarFallback className="bg-primary/10 text-xs font-semibold">{username.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden"><span className="truncate text-sm font-medium">{username}</span><span className="truncate text-xs text-muted-foreground">单用户 · 多数据源</span></div><LogOut className="size-4 text-muted-foreground group-data-[collapsible=icon]:hidden" aria-hidden="true" /></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
    <SidebarRail />
  </Sidebar>
}
