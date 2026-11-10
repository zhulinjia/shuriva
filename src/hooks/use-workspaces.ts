import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addDatasource,
  deleteDatasource,
  deleteWorkspace,
  duplicateWorkspace,
  getWorkspaceScreen,
  listDatasources,
  listPermissionPolicies,
  listWorkspaces,
  renameWorkspace,
  resetDemoData,
  savePermissionPolicy,
  saveWorkspace,
  setDatasourceStatus,
  updateDatasource,
} from "@/services"
import type {
  DatasourceInput,
  DatasourceStatus,
  PreviewRole,
  RoleId,
  Workspace,
} from "@/services"

export const workspacesQueryKey = ["mock", "workspaces"] as const
export const datasourcesQueryKey = ["mock", "datasources"] as const
export const policiesQueryKey = ["mock", "policies"] as const

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesQueryKey,
    queryFn: listWorkspaces,
    staleTime: 30_000,
  })
}

export function useDatasources() {
  return useQuery({
    queryKey: datasourcesQueryKey,
    queryFn: listDatasources,
    staleTime: 30_000,
  })
}

export function workspaceScreenQueryKey(
  workspaceId: string | undefined,
  role: PreviewRole | undefined
) {
  return ["mock", "workspace", workspaceId, role ?? "owner"] as const
}

export function useWorkspaceScreen(
  workspaceId: string | undefined,
  role: PreviewRole | undefined
) {
  return useQuery({
    queryKey: workspaceScreenQueryKey(workspaceId, role),
    queryFn: () => getWorkspaceScreen(workspaceId ?? "", role),
    enabled: Boolean(workspaceId),
    staleTime: 15_000,
  })
}

export function usePermissionPolicies() {
  return useQuery({
    queryKey: policiesQueryKey,
    queryFn: listPermissionPolicies,
    staleTime: 30_000,
  })
}

function useInvalidateDemoData() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ["mock"] })
}

export function useWorkspaceActions() {
  const invalidate = useInvalidateDemoData()

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameWorkspace(id, title),
    onSuccess: invalidate,
  })
  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateWorkspace(id),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: invalidate,
  })
  const save = useMutation({
    mutationFn: (workspace: Workspace) => saveWorkspace(workspace),
    onSuccess: invalidate,
  })

  return { rename, duplicate, remove, save }
}

export function useDatasourceActions() {
  const invalidate = useInvalidateDemoData()

  const setStatus = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string
      status: DatasourceStatus
    }) => setDatasourceStatus(id, status),
    onSuccess: invalidate,
  })
  const add = useMutation({
    mutationFn: (input: DatasourceInput) => addDatasource(input),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: DatasourceInput }) =>
      updateDatasource(id, input),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteDatasource(id),
    onSuccess: invalidate,
  })

  return { setStatus, add, update, remove }
}

export function usePolicyActions() {
  const invalidate = useInvalidateDemoData()
  const save = useMutation({
    mutationFn: ({
      role,
      policy,
    }: {
      role: RoleId
      policy: Parameters<typeof savePermissionPolicy>[1]
    }) => savePermissionPolicy(role, policy),
    onSuccess: invalidate,
  })

  return { save }
}

export function useResetDemoData() {
  const invalidate = useInvalidateDemoData()
  return useMutation({
    mutationFn: resetDemoData,
    onSuccess: invalidate,
  })
}
