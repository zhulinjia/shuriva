import type { LucideIcon } from "lucide-react"
import { useId } from "react"

type PagePlaceholderProps = {
  icon: LucideIcon
  title: string
  description: string
  route: string
}

/**
 * Scaffolding for the first-round infrastructure only. It deliberately states
 * that the business page has not been implemented yet.
 */
export function PagePlaceholder({
  icon: Icon,
  title,
  description,
  route,
}: PagePlaceholderProps) {
  const titleId = useId()

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-dashed border-input bg-card px-6 py-10 max-[700px]:px-4"
    >
      <span className="grid size-11 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <h2
        id={titleId}
        className="mt-4 text-section-title font-medium text-foreground"
      >
        {title}
      </h2>
      <p className="mt-1.5 max-w-xl text-body text-muted-foreground">
        {description}
      </p>

      <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 font-mono text-label text-muted-foreground">
        <span className="shrink-0 text-caption">当前路由</span>
        <code className="truncate">{route}</code>
      </div>

      <p className="mt-5 border-t border-border pt-4 text-label text-muted-foreground">
        当前阶段已完成应用外壳、设计 Token、路由和 Mock 服务基础。业务页面将在下一阶段迁移。
      </p>
    </section>
  )
}
