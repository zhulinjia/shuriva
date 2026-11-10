import type { DatasourceEngine } from "@/services"
import { cn } from "@/lib/utils"

export type EngineMarkEngine = DatasourceEngine | "SQLite"

const ENGINE_CLASSES: Record<EngineMarkEngine, string> = {
  PostgreSQL: "bg-primary/10 text-primary",
  MySQL: "bg-info-soft text-info",
  ClickHouse: "bg-warning-soft text-warning",
  SQLite: "bg-info-soft text-info",
}

const ENGINE_LETTERS: Record<EngineMarkEngine, string> = {
  PostgreSQL: "P",
  MySQL: "M",
  ClickHouse: "C",
  SQLite: "S",
}

type EngineMarkProps = {
  engine: EngineMarkEngine
  size?: "sm" | "md" | "lg"
  className?: string
}

export function EngineMark({
  engine,
  size = "md",
  className,
}: EngineMarkProps) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-md font-semibold",
        size === "sm" && "size-5 text-[10px]",
        size === "md" && "size-7 text-[11px]",
        size === "lg" && "size-9 text-sm",
        ENGINE_CLASSES[engine],
        className
      )}
      aria-hidden="true"
    >
      {ENGINE_LETTERS[engine]}
    </span>
  )
}
