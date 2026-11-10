import { BarChart3, Link2, Table2, Users } from "lucide-react"
import type { Workspace } from "@/services"
import { Badge } from "@/components/ui/badge"

/** Data-free content for the same canvas used by the saved workspace. */
export type StructuralBlockType = "linkage" | "orders" | "directory" | "profile" | "activity"

export function WorkspaceStructuralBlock({ type, workspace }: { type: StructuralBlockType; workspace: Workspace }) {
  if (type === "linkage") {
    return <div className="flex min-h-10 items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 text-label"><Link2 className="size-4 text-primary" aria-hidden="true" />客户联动<span className="text-caption text-muted-foreground">接入查询后可选择客户</span></div>
  }

  const title = type === "orders" ? "订单明细" : type === "directory" ? "客户列表" : type === "profile" ? "客户资料" : "使用趋势"
  const Icon = type === "activity" ? BarChart3 : type === "profile" ? Users : Table2
  const columns = type === "directory"
    ? ["客户", "客户编号", ...(workspace.config.showPhone ? ["手机号"] : []), "方案", "门店", "注册时间"]
    : ["订单号", "客户", "金额", ...(workspace.config.showCost ? ["成本"] : []), "渠道", "状态", "创建时间"]

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h3 className="text-card-title font-medium">{title}</h3><Badge variant="secondary" className="font-normal">--</Badge>
      </div>
      {type === "orders" || type === "directory" ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left"><thead><tr className="border-b border-border bg-muted/40 text-caption text-muted-foreground">{columns.map((column) => <th key={column} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{column}</th>)}</tr></thead></table>
        </div>
      ) : null}
      <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-5 py-7 text-center text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
        <p className="text-label font-medium text-foreground">工作台结构已生成</p>
        <p className="text-caption">尚未执行查询，接入数据后在此展示结果。</p>
      </div>
    </section>
  )
}
