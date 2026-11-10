import type { DatasourceStatus } from "@/services"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"

type DatasourceStatusBadgeProps = {
  status: DatasourceStatus
  className?: string
}

export function DatasourceStatusBadge({
  status,
  className,
}: DatasourceStatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal",
        status === "connected"
          ? "border-success-border bg-success-soft text-success"
          : "border-destructive-border bg-destructive-soft text-destructive",
        className
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "connected" ? "bg-success" : "bg-destructive"
        )}
        aria-hidden="true"
      />
      {status === "connected" ? "连接可用" : "连接离线"}
    </Badge>
  )
}
