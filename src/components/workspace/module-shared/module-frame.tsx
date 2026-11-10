import { Database, Lock, RefreshCw } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import type { Datasource, ModuleAccess } from "@/services"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function Metric({
  label,
  icon: Icon,
  value,
  unit,
  description,
}: {
  label: string
  icon: LucideIcon
  value: string | number
  unit?: string
  description: string
}) {
  return (
    <div className="min-w-0 border-r border-border px-4 py-3.5 last:border-r-0 max-[700px]:px-3 max-[700px]:py-3">
      <span className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
        <span className="truncate">{label}</span>
        <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
      </span>
      <strong className="mt-0.5 block truncate text-number font-semibold text-foreground tabular-nums max-[700px]:text-xl">
        {value}
        {unit ? (
          <small className="ml-1 text-caption font-normal text-muted-foreground">
            {unit}
          </small>
        ) : null}
      </strong>
      <p className="mt-0.5 truncate text-caption text-muted-foreground max-[700px]:hidden">
        {description}
      </p>
    </div>
  )
}

export function ModuleHeading({
  title,
  count,
  badge,
  aside,
  actions,
}: {
  title: string
  count?: number
  badge?: ReactNode
  aside?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-card-title font-medium text-foreground">{title}</h3>
        {count !== undefined ? (
          <Badge variant="secondary" className="font-normal tabular-nums">
            {count}
          </Badge>
        ) : null}
        {badge}
        {aside}
      </div>
      {actions ? <div className="flex items-center gap-0.5">{actions}</div> : null}
    </div>
  )
}

export function ModuleFooter({
  source,
  fixedText,
}: {
  source: Datasource | undefined
  fixedText?: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/50 px-4 py-2 text-caption text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Database className="size-3.5" aria-hidden="true" />
        {source?.name ?? "未绑定来源"}
      </span>
      <span>
        {fixedText ??
          (source?.status === "connected"
            ? `模拟更新时间 ${source.updatedAt}`
            : "尚未获取数据")}
      </span>
    </div>
  )
}

export function ModuleFailure({
  access,
  onRestoreSource,
  restoringSourceId,
}: {
  access: ModuleAccess
  onRestoreSource?: (sourceId: string) => void
  restoringSourceId?: string | null
}) {
  const Icon =
    access.kind === "denied"
      ? Lock
      : access.kind === "offline"
        ? RefreshCw
        : Database
  const sourceId =
    access.kind === "offline" ? access.source?.id : undefined
  const restoring = Boolean(sourceId && restoringSourceId === sourceId)

  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-5 py-8 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <p className="text-label font-medium text-foreground">
        {access.title ?? "模块暂不可用"}
      </p>
      <p className="max-w-sm text-caption leading-relaxed text-muted-foreground">
        {access.description}
      </p>
      {sourceId && onRestoreSource ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1"
          disabled={restoring}
          onClick={() => onRestoreSource(sourceId)}
        >
          <RefreshCw
            className={cn(restoring && "animate-spin motion-reduce:animate-none")}
            aria-hidden="true"
          />
          {restoring ? "正在恢复…" : "恢复模拟连接"}
        </Button>
      ) : null}
    </div>
  )
}
