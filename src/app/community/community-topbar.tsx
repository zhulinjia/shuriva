import { ChevronRight, Database, LayoutGrid, Settings, Sparkles, Table2 } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import type { CommunitySection } from "./community-sidebar"
import type { LiveWorkspaceSelection } from "./workspaces-page"

export function CommunityTopbar({ section, selection, username, onWorkspaces, onSettings }: { section: CommunitySection; selection: LiveWorkspaceSelection; username: string; onWorkspaces: () => void; onSettings: () => void }) {
  const label = section === "sources" ? "数据源" : section === "settings" ? "设置" : selection === "new" ? "创建工作台" : selection ? selection.document.title : "我的工作台"
  const Icon = section === "sources" ? Database : section === "settings" ? Settings : selection === "new" ? Sparkles : selection ? Table2 : LayoutGrid
  return <header className="sticky top-0 z-20 flex h-(--spacing-topbar) items-center justify-between gap-3 border-b border-border bg-card px-4 max-[700px]:px-3">
    <div className="flex min-w-0 items-center gap-2"><SidebarTrigger className="-ml-1" /><nav aria-label="面包屑" className="min-w-0"><ol className="flex min-w-0 items-center gap-1.5">
      {section === "workspaces" && selection && <><li className="max-[520px]:hidden"><button type="button" className="text-nav text-muted-foreground hover:text-foreground" onClick={onWorkspaces}>我的工作台</button></li><li aria-hidden="true" className="text-muted-foreground max-[520px]:hidden"><ChevronRight className="size-3.5" /></li></>}
      <li className="flex min-w-0 items-center gap-1.5 text-nav font-medium"><Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{label}</span></li>
    </ol></nav></div>
    <div className="flex shrink-0 items-center gap-2"><Badge variant="secondary" className="border border-border font-normal">Community · 自部署</Badge><Button type="button" variant="ghost" size="sm" aria-label="设置" onClick={onSettings}><Settings aria-hidden="true" /><span className="max-[520px]:hidden">设置</span></Button><Avatar size="sm"><AvatarFallback className="bg-muted text-xs font-semibold">{username.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="sr-only">当前用户：{username}</span></div>
  </header>
}
