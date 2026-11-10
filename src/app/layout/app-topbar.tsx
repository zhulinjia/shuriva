import { ChevronRight, Settings } from "lucide-react"
import { Link } from "react-router"
import { getPageMeta } from "@/app/navigation"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"

type AppTopbarProps = {
  pathname: string
}

export function AppTopbar({ pathname }: AppTopbarProps) {
  const meta = getPageMeta(pathname)
  const MetaIcon = meta.icon
  const workspaces = useWorkspaces()
  const workspaceId = pathname.startsWith("/workspaces/")
    ? decodeURIComponent(pathname.slice("/workspaces/".length))
    : null
  const currentLabel =
    (workspaceId
      ? workspaces.data?.find((workspace) => workspace.id === workspaceId)?.title
      : null) ?? meta.label

  return (
    <header className="sticky top-0 z-20 flex h-(--spacing-topbar) items-center justify-between gap-3 border-b border-border bg-card px-4 max-[700px]:px-3">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" />

        <nav aria-label="面包屑" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-1.5">
            {meta.parent ? (
              <>
                <li className="min-w-0 max-[520px]:hidden">
                  <Link
                    to={meta.parent.to}
                    className="truncate rounded-sm text-nav text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {meta.parent.label}
                  </Link>
                </li>
                <li
                  aria-hidden="true"
                  className="text-muted-foreground max-[520px]:hidden"
                >
                  <ChevronRight className="size-3.5" />
                </li>
              </>
            ) : null}
            <li className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5 text-nav font-medium text-foreground">
                <MetaIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{currentLabel}</span>
              </span>
            </li>
          </ol>
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge
          variant="secondary"
          className="gap-1.5 border border-border font-normal"
        >
          <span
            className="size-1.5 rounded-full bg-muted-foreground"
            aria-hidden="true"
          />
          <span className="max-[520px]:hidden">Mock 交互原型</span>
          <span className="hidden max-[520px]:inline">MOCK</span>
        </Badge>

        <Link
          to="/settings"
          aria-label="演示设置"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "max-[520px]:size-8 max-[520px]:px-0"
          )}
        >
          <Settings className="size-4" aria-hidden="true" />
          <span className="max-[520px]:hidden">演示设置</span>
        </Link>

        <span className="flex items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback className="bg-muted text-xs font-semibold text-foreground">
              S
            </AvatarFallback>
          </Avatar>
          <span className="sr-only">当前用户：Shuriva Demo</span>
        </span>
      </div>
    </header>
  )
}
