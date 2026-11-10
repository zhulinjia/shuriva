import { ShieldCheck } from "lucide-react"
import { Link } from "react-router"
import { PREVIEW_ROLES, previewRoleLabel } from "@/lib/roles"
import { useDemoStore } from "@/stores/demo-store"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function RolePreviewBar() {
  const edition = useDemoStore((state) => state.edition)
  const previewRole = useDemoStore((state) => state.previewRole)
  const setPreviewRole = useDemoStore((state) => state.setPreviewRole)

  if (edition !== "team") return null

  return (
    <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-3 max-[980px]:px-5 max-[700px]:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-label">
        <ShieldCheck
          className="size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <strong className="font-medium text-foreground">
          {previewRoleLabel(previewRole)}权限预览
        </strong>
        <label htmlFor="preview-role" className="sr-only">
          预览角色
        </label>
        <Select
          items={PREVIEW_ROLES}
          value={previewRole}
          onValueChange={(value) =>
            setPreviewRole(value as (typeof PREVIEW_ROLES)[number]["value"])
          }
        >
          <SelectTrigger
            id="preview-role"
            size="sm"
            className="bg-card"
            aria-label="切换预览角色"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {PREVIEW_ROLES.map((role) => (
              <SelectItem key={role.value} value={role.value}>
                {role.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground max-[980px]:hidden">
          仅模拟不同成员的可见结果，不改变登录身份。
        </span>
        <Link
          to="/permissions"
          className="ml-auto shrink-0 rounded-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          编辑数据策略
        </Link>
      </div>
    </div>
  )
}
