import type { DatasourceEngine } from "@/services"
import { cn } from "@/lib/utils"
import { EngineMark } from "./engine-mark"

type EngineStackProps = {
  engines: readonly DatasourceEngine[]
  className?: string
}

export function EngineStack({ engines, className }: EngineStackProps) {
  const unique = [...new Set(engines)]

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      aria-label={`数据库类型：${unique.join("、")}`}
    >
      {unique.map((engine) => (
        <EngineMark key={engine} engine={engine} size="sm" />
      ))}
    </span>
  )
}
