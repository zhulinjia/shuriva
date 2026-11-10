import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

type PageContainerProps = {
  eyebrow?: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /**
   * Docked side panel shown beside the page content on wide screens. The page
   * header stays in the left column so the panel can span the full viewport
   * height without being pushed below the fold.
   */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

export function PageContainer({
  eyebrow,
  title,
  description,
  actions,
  aside,
  children,
  className,
}: PageContainerProps) {
  const header = (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1.5 text-caption font-medium tracking-[0.12em] text-muted-foreground uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-page-title font-semibold text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-body text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  )

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-(--spacing-page) px-6 pt-6 pb-10 max-[980px]:px-5 max-[700px]:px-4",
        className
      )}
    >
      {aside ? (
        <div className="grid gap-4 min-[1250px]:grid-cols-[minmax(0,1fr)_400px] min-[1250px]:items-start">
          <div className="min-w-0">
            {header}
            <div className="min-w-0">{children}</div>
          </div>
          <div className="hidden min-[1250px]:sticky min-[1250px]:top-[calc(var(--spacing-topbar)+16px)] min-[1250px]:block min-[1250px]:h-[calc(100svh-var(--spacing-topbar)-40px)] min-[1250px]:min-w-0">
            {aside}
          </div>
        </div>
      ) : (
        <>
          {header}
          <div className="min-w-0">{children}</div>
        </>
      )}
    </div>
  )
}
