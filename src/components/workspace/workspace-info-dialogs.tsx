import {
  ChartColumn,
  Database,
  Link2,
  Settings2,
  Table2,
  Users,
} from "lucide-react"
import type {
  BindingKey,
  Datasource,
  PermissionPolicy,
  Workspace,
} from "@/services"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Notice } from "@/components/common/notice"

const BINDING_LABELS: Record<BindingKey, string> = {
  orders: "订单明细",
  profile: "客户资料",
  activity: "使用趋势",
}

const BINDING_ICONS = {
  orders: Table2,
  profile: Users,
  activity: ChartColumn,
} as const

const SQL_SNIPPETS: Record<BindingKey, string> = {
  orders: `SELECT permitted_columns FROM orders
WHERE (:customer_id IS NULL OR customer_id = :customer_id)
  AND /* trusted row-scope predicate */ TRUE
ORDER BY created_at DESC
LIMIT :limit;`,
  profile: `SELECT permitted_columns FROM customers
WHERE /* trusted row-scope predicate */ TRUE;`,
  activity: `SELECT date_bucket, COUNT(*) FROM user_events
WHERE user_id = :customer_id
GROUP BY date_bucket;`,
}

type BindingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  datasources: readonly Datasource[]
  moduleKey?: BindingKey | null
  onEdit?: () => void
}

export function BindingsDialog({
  open,
  onOpenChange,
  workspace,
  datasources,
  moduleKey,
  onEdit,
}: BindingsDialogProps) {
  const entries = (
    Object.entries(workspace.bindings) as [BindingKey, string][]
  ).filter(([key]) => !moduleKey || key === moduleKey)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {moduleKey
              ? `${BINDING_LABELS[moduleKey]} · 数据来源`
              : "数据来源与联动关系"}
          </DialogTitle>
          <DialogDescription>
            每个模块独立绑定来源并分别查询，不执行任意跨库 JOIN。
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border rounded-lg border border-border">
          {entries.map(([key, sourceId]) => {
            const source = datasources.find((item) => item.id === sourceId)
            const Icon = BINDING_ICONS[key]

            return (
              <div key={key} className="flex items-center gap-3 px-3 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-label font-medium text-foreground">
                    {BINDING_LABELS[key]}
                  </strong>
                  <small className="mt-0.5 block truncate text-caption text-muted-foreground">
                    <code>q_{key}</code> → {source?.name ?? "尚未绑定"}
                  </small>
                </div>
                <Badge variant="outline" className="font-normal">
                  {source?.engine ?? "未配置"}
                </Badge>
              </div>
            )
          })}
        </div>

        <div className="flex gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
          <Link2
            className="mt-0.5 size-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div className="text-caption leading-relaxed text-muted-foreground">
            <code className="block text-foreground">
              customers.id → orders.customer_id
            </code>
            <code className="block text-foreground">
              customers.id → user_events.user_id
            </code>
          </div>
        </div>

        <p className="text-label leading-relaxed text-muted-foreground">
          示例中的关联映射已确认。选择客户后，把该客户标识分别作为各数据源的查询参数；不会把多个数据库直接拼成一条 SQL。
        </p>

        <Notice>
          修改绑定需要进入草稿编辑，保存前不会影响正在使用的工作台。
        </Notice>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          {onEdit ? <Button type="button" size="sm" onClick={() => { onOpenChange(false); onEdit() }}><Settings2 aria-hidden="true" />修改绑定</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type DataNotesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  datasources: readonly Datasource[]
  policy: PermissionPolicy | null
}

export function DataNotesDialog({
  open,
  onOpenChange,
  workspace,
  datasources,
  policy,
}: DataNotesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>数据说明</DialogTitle>
          <DialogDescription>
            当前所有 SQL 与结果均为示例，不会连接数据库或执行 SQL。
          </DialogDescription>
        </DialogHeader>

        <dl className="grid gap-x-6 gap-y-2.5 rounded-lg border border-border bg-muted/50 px-3 py-3 text-label sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">工作台</dt>
            <dd className="mt-0.5 text-foreground">{workspace.title}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">来源范围</dt>
            <dd className="mt-0.5 text-foreground">
              {workspace.datasourceIds.length} 个连接，各自执行查询
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">统计口径</dt>
            <dd className="mt-0.5 text-foreground">
              订单指标统计全部匹配记录，不仅当前分页
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">权限示例</dt>
            <dd className="mt-0.5 text-foreground">
              {policy ? policy.description : "开源版单用户模拟，无团队策略"}
            </dd>
          </div>
        </dl>

        <div className="grid gap-2">
          {(Object.entries(workspace.bindings) as [BindingKey, string][]).map(
            ([key, sourceId]) => {
              const source = datasources.find((item) => item.id === sourceId)

              return (
                <div
                  key={key}
                  className="overflow-hidden rounded-lg border border-border"
                >
                  <div className="flex items-center justify-between gap-3 bg-muted/50 px-3 py-2 text-caption text-foreground">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Database className="size-3.5" aria-hidden="true" />
                      {BINDING_LABELS[key]}
                    </span>
                    <span className="text-muted-foreground">
                      {source?.name ?? "未绑定"}
                    </span>
                  </div>
                  <pre className="overflow-x-auto px-3 py-2.5 text-caption leading-relaxed text-muted-foreground">
                    <code>{SQL_SNIPPETS[key]}</code>
                  </pre>
                </div>
              )
            }
          )}
        </div>

        <p className="text-caption leading-relaxed text-muted-foreground">
          SQL 中的权限占位只表达设计意图，不是可以直接使用的安全策略实现。正式版本必须在服务端校验数据源、表、字段、行范围和操作权限。
        </p>

        <DialogFooter>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
