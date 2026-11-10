import { LayoutGrid, Table2, Users } from "lucide-react"
import type { WorkspaceKind } from "@/services"
import { cn } from "@/lib/utils"

const ICONS = {
  customer: LayoutGrid,
  orders: Table2,
  members: Users,
} as const

type WorkspaceGlyphProps = {
  kind: WorkspaceKind
  className?: string
  size?: "sm" | "md" | "lg"
}

export function WorkspaceGlyph({
  kind,
  className,
  size = "md",
}: WorkspaceGlyphProps) {
  const Icon = ICONS[kind]

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary",
        size === "sm" && "size-8",
        size === "md" && "size-9",
        size === "lg" && "size-10",
        className
      )}
      aria-hidden="true"
    >
      <Icon
        className={cn(
          size === "sm" && "size-4",
          size === "md" && "size-[18px]",
          size === "lg" && "size-5"
        )}
      />
    </span>
  )
}
