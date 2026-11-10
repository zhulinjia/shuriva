import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ApiError, api, getWorkspaces } from "@/services/community-api"
import { AiSettingsPage } from "./ai-settings-page"
import { CommunitySidebar } from "./community-sidebar"
import type { CommunitySection } from "./community-sidebar"
import { CommunityTopbar } from "./community-topbar"
import { LoginPage } from "./login-page"
import { SourcePage } from "./source-page"
import { LiveWorkspacesPage } from "./workspaces-page"
import type { LiveWorkspaceSelection } from "./workspaces-page"

export function CommunityApp() {
    const client = useQueryClient()
    const session = useQuery({
        queryKey: ["live-session"],
        queryFn: async () => {
            try {
                return await api<{ username: string }>("/auth/session")
            } catch (error) {
                if (error instanceof ApiError && error.status === 401) return null
                throw error
            }
        },
        retry: false,
    })
    if (session.isPending) return <div className="p-8 text-sm text-muted-foreground">正在连接服务…</div>
    if (session.isError)
        return (
            <main className="mx-auto max-w-lg p-8">
                <h1 className="text-lg font-semibold">无法连接 Shuriva 服务</h1>
                <p className="mt-2 text-sm text-muted-foreground">请先启动服务端，再刷新页面。</p>
                <Button className="mt-4" variant="outline" onClick={() => void session.refetch()}>
                    重试
                </Button>
                <Link className="ml-4 text-sm underline" to="/workspaces">
                    查看设计演示
                </Link>
            </main>
        )
    if (!session.data) return <LoginPage onLogin={(username) => client.setQueryData(["live-session"], { username })} />
    return <CommunityShell username={session.data.username} />
}

function CommunityShell({ username }: { username: string }) {
    const client = useQueryClient()
    const [section, setSection] = useState<CommunitySection>("workspaces")
    const [selection, setSelection] = useState<LiveWorkspaceSelection>(null)
    const [dirty, setDirty] = useState(false)
    const [logoutError, setLogoutError] = useState(false)
    const workspaces = useQuery({ queryKey: ["live-workspaces"], queryFn: getWorkspaces })
    const canLeave = () => !dirty || window.confirm("当前修改尚未保存，确定离开吗？")
    const changeSelection = (next: LiveWorkspaceSelection) => {
        const same =
            section === "workspaces" &&
            (selection === next ||
                (typeof selection === "object" &&
                    selection !== null &&
                    typeof next === "object" &&
                    next !== null &&
                    selection.id === next.id))
        if (same || !canLeave()) return
        setSelection(next)
        setSection("workspaces")
    }
    const changeSection = (next: CommunitySection) => {
        if (section === next || !canLeave()) return
        setSelection(null)
        setSection(next)
    }
    const logout = () => {
        if (!canLeave()) return
        setLogoutError(false)
        void api("/auth/logout", { method: "POST" })
            .then(() => {
                client.removeQueries({ predicate: (query) => query.queryKey[0] !== "live-session" })
                client.setQueryData(["live-session"], null)
            })
            .catch(() => setLogoutError(true))
    }
    return (
        <SidebarProvider>
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-body focus:font-medium focus:text-foreground focus:shadow-dialog focus:outline-2 focus:outline-ring"
            >
                跳到主要内容
            </a>
            <CommunitySidebar
                section={section}
                selection={selection}
                workspaces={workspaces.data ?? []}
                workspacesLoading={workspaces.isPending}
                workspacesError={workspaces.isError}
                username={username}
                onSection={changeSection}
                onSelect={changeSelection}
                onLogout={logout}
                canLeave={canLeave}
            />
            <div className="flex min-h-svh min-w-0 flex-1 flex-col">
                <CommunityTopbar
                    section={section}
                    selection={selection}
                    username={username}
                    onWorkspaces={() => changeSelection(null)}
                    onSettings={() => changeSection("settings")}
                />
                {logoutError && (
                    <p role="alert" className="px-4 pt-3 text-sm text-destructive">
                        退出登录失败，请检查服务连接后重试。
                    </p>
                )}
                <main id="main-content" className="min-w-0 flex-1">
                    {section === "workspaces" ? (
                        <LiveWorkspacesPage
                            selected={selection}
                            onSelect={changeSelection}
                            onAddSource={() => changeSection("sources")}
                            onDirtyChange={setDirty}
                            onAiSettings={() => changeSection("settings")}
                        />
                    ) : section === "sources" ? (
                        <SourcePage onDirtyChange={setDirty} />
                    ) : (
                        <AiSettingsPage />
                    )}
                </main>
            </div>
        </SidebarProvider>
    )
}
