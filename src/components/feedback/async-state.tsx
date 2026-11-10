import type { LucideIcon } from "lucide-react"
import { Inbox, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type StatePanelProps = {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  tone?: "neutral" | "danger"
  role?: "alert" | "status"
  className?: string
}

function StatePanel({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
  role,
  className,
}: StatePanelProps) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-10 text-center",
        className
      )}
    >
      <span
        className={cn(
          "grid size-10 place-items-center rounded-lg",
          tone === "danger"
            ? "bg-destructive/10 text-destructive"
            : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h2 className="mt-3 text-section-title font-medium text-foreground">
        {title}
      </h2>
      {description ? (
        <p className="mt-1.5 max-w-md text-body text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

type LoadingStateProps = {
  label?: string
  className?: string
}

export function LoadingState({
  label = "正在加载…",
  className,
}: LoadingStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 text-body text-muted-foreground",
        className
      )}
    >
      <Loader2
        className="size-4 animate-spin text-primary motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  )
}

type EmptyStateProps = {
  title: string
  description?: string
  icon?: LucideIcon
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  icon = Inbox,
  action,
  className,
}: EmptyStateProps) {
  return (
    <StatePanel
      icon={icon}
      title={title}
      description={description}
      action={action}
      className={className}
    />
  )
}

type ErrorStateProps = {
  title?: string
  description?: string
  retryLabel?: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({
  title = "加载失败",
  description,
  retryLabel = "重试",
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <StatePanel
      icon={TriangleAlert}
      title={title}
      description={description}
      tone="danger"
      role="alert"
      className={className}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {retryLabel}
          </Button>
        ) : undefined
      }
    />
  )
}
