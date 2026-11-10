import { Search } from "lucide-react"
import { Link } from "react-router"
import { EmptyState } from "@/components/feedback/async-state"
import { PageContainer } from "@/components/layout/page-container"
import { buttonVariants } from "@/components/ui/button"

export function NotFoundPage() {
  return (
    <PageContainer
      title="页面不存在"
      description="你访问的页面尚未配置或已经移动。"
    >
      <EmptyState
        icon={Search}
        title="没有找到这个页面"
        description="请从左侧导航选择一个可用页面，或返回工作台目录继续浏览。"
        action={
          <Link to="/workspaces" className={buttonVariants({ size: "sm" })}>
            返回我的工作台
          </Link>
        }
      />
    </PageContainer>
  )
}
