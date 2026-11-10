import type { BindingKey, Datasource, Workspace } from "@/services"

/** Resolves the datasource a workspace module is bound to. */
export function sourceForBinding(
  datasources: readonly Datasource[],
  workspace: Workspace,
  key: BindingKey
): Datasource | undefined {
  return datasources.find((source) => source.id === workspace.bindings[key])
}
