import { Outlet, useLocation } from "react-router"
import { useDemoStore } from "@/stores/demo-store"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppFooter } from "@/components/layout/app-footer"
import { RolePreviewBar } from "@/components/workspace/role-preview-bar"
import { AppSidebar } from "./app-sidebar"
import { AppTopbar } from "./app-topbar"

export function AppShell() {
  const { pathname } = useLocation()
  const edition = useDemoStore((state) => state.edition)

  return (
    <SidebarProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-body focus:font-medium focus:text-foreground focus:shadow-dialog focus:outline-2 focus:outline-ring"
      >
        跳到主要内容
      </a>

      <AppSidebar />

      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <AppTopbar pathname={pathname} />
        <main id="main-content" className="flex-1">
          {edition === "team" &&
          (pathname.startsWith("/workspaces/") ||
            pathname.startsWith("/editor") ||
            pathname.startsWith("/create")) ? (
            <RolePreviewBar />
          ) : null}
          <Outlet />
        </main>
        <AppFooter className="app-shell-footer" />
      </div>
    </SidebarProvider>
  )
}
