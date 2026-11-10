import { createBrowserRouter, Navigate } from "react-router"
import { AppShell } from "./layout/app-shell"
import { CreatePage } from "./pages/create-page"
import { DatasourcesPage } from "./pages/datasources-page"
import { EditorPage } from "./pages/editor-page"
import { NotFoundPage } from "./pages/not-found-page"
import { PermissionsPage } from "./pages/permissions-page"
import { SettingsPage } from "./pages/settings-page"
import { WorkspacePage } from "./pages/workspace-page"
import { WorkspacesPage } from "./pages/workspaces-page"
import { CommunityApp } from "./community/community-app"

export const router = createBrowserRouter([
  { path: "/community", element: <CommunityApp /> },
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/community" replace /> },
      { path: "create", element: <CreatePage /> },
      { path: "workspaces", element: <WorkspacesPage /> },
      { path: "workspaces/:workspaceId", element: <WorkspacePage /> },
      { path: "editor", element: <EditorPage /> },
      { path: "editor/:workspaceId", element: <EditorPage /> },
      { path: "datasources", element: <DatasourcesPage /> },
      { path: "permissions", element: <PermissionsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])
