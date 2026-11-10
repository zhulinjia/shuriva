import {
  CircleCheck,
  Info,
  Lock,
  Server,
  TriangleAlert,
} from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

type NoticeTone = "subtle" | "info" | "success" | "warning" | "danger"

type NoticeProps = {
  children: ReactNode
  tone?: NoticeTone
  icon?: "info" | "lock" | "server" | "warning" | "check"
  className?: string
}

const TONE_CLASSES: Record<NoticeTone, string> = {
  subtle: "border-border bg-muted/50 text-muted-foreground",
  info: "border-border bg-muted/30 text-foreground",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-destructive-border bg-destructive-soft text-destructive",
}

const ICONS = {
  info: Info,
  lock: Lock,
  server: Server,
  warning: TriangleAlert,
  check: CircleCheck,
}

export function Notice({
  children,
  tone = "subtle",
  icon = "info",
  className,
}: NoticeProps) {
  const Icon = ICONS[icon]

  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2.5 text-label leading-relaxed",
        TONE_CLASSES[tone],
        className
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
