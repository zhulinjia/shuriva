import type { PreviewRole } from "@/services"

export const PREVIEW_ROLES = [
  { value: "owner", label: "数据管理员" },
  { value: "support", label: "客服" },
  { value: "finance", label: "财务" },
  { value: "operator", label: "门店运营" },
] as const satisfies readonly { value: PreviewRole; label: string }[]

export function previewRoleLabel(role: PreviewRole) {
  return PREVIEW_ROLES.find((item) => item.value === role)?.label ?? "数据管理员"
}
