import type { Datasource } from "@/services"
import { cn } from "@/lib/utils"
import { EngineMark } from "./engine-mark"

type SourceChipProps = {
  datasource: Datasource
  onClick?: () => void
  className?: string
}

export function SourceChip({
  datasource,
  onClick,
  className,
}: SourceChipProps) {
  const content = (
    <>
      <EngineMark engine={datasource.engine} size="sm" />
      <span className="truncate">{datasource.name}</span>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          datasource.status === "offline" ? "bg-destructive" : "bg-success"
        )}
        aria-label={
          datasource.status === "offline" ? "模拟连接离线" : "模拟连接可用"
        }
      />
    </>
  )

  const classes = cn(
    "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-2.5 pl-1 text-label text-foreground",
    onClick &&
      "transition-colors hover:border-primary/20 hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    className
  )

  if (!onClick) {
    return <span className={classes}>{content}</span>
  }

  return (
    <button type="button" className={classes} onClick={onClick}>
      {content}
    </button>
  )
}
