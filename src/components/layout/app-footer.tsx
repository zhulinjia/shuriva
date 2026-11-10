import { cn } from "@/lib/utils"

export function AppFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("mx-auto w-full max-w-(--spacing-page) px-6 pb-6 text-caption text-muted-foreground max-[980px]:px-5 max-[700px]:px-4", className)}>
      交互设计预览 · 全部使用虚构数据 · 不连接真实数据库
    </footer>
  )
}
