import { ArrowRight, Database, Lock, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import type { Datasource, Workspace } from "@/services"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EngineMark } from "./engine-mark"
import { DatasourceStatusBadge } from "./datasource-status-badge"

const SCHEMA_HINTS: Record<string, string> = {
  orders: "id · customer_id · amount · cost · status · store_id",
  payments: "id · order_id · channel · pay_status",
  customers: "id · name · phone · email · store_id",
  subscriptions: "id · customer_id · plan · expires_at",
  user_events: "id · user_id · event_name · occurred_at",
}

type DatasourceDetailDialogProps = {
  datasource: Datasource | null
  workspaces: readonly Workspace[]
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: "overview" | "schema" | "usage"
  onEdit?: (datasource: Datasource) => void
  onToggleStatus?: (datasource: Datasource) => void
  onDelete?: (datasource: Datasource) => void
  pending?: boolean
}

export function DatasourceDetailDialog({
  datasource,
  workspaces,
  open,
  onOpenChange,
  initialTab = "overview",
  onEdit,
  onToggleStatus,
  onDelete,
  pending = false,
}: DatasourceDetailDialogProps) {
  const [tab, setTab] = useState(initialTab)
  const [wasOpen, setWasOpen] = useState(open)

  if (open && !wasOpen) {
    setWasOpen(true)
    setTab(initialTab)
  } else if (!open && wasOpen) {
    setWasOpen(false)
  }

  if (!datasource) return null

  const usages = workspaces.filter((workspace) =>
    workspace.datasourceIds.includes(datasource.id)
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex flex-wrap items-start gap-3 pr-8">
            <EngineMark engine={datasource.engine} size="lg" />
            <div className="min-w-0 flex-1">
              <DialogTitle>{datasource.name}</DialogTitle>
              <DialogDescription>
                {datasource.engine} · {datasource.database}
              </DialogDescription>
            </div>
            <DatasourceStatusBadge status={datasource.status} />
          </div>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) =>
            setTab(value as "overview" | "schema" | "usage")
          }
        >
          <TabsList variant="line" className="w-full justify-start border-b">
            <TabsTrigger value="overview">连接配置</TabsTrigger>
            <TabsTrigger value="schema">可用表结构</TabsTrigger>
            <TabsTrigger value="usage">
              使用情况 ({usages.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pt-3">
            <dl className="grid gap-x-6 gap-y-3 text-label sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">连接方式</dt>
                <dd className="mt-0.5 text-foreground">应用后端直连</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">数据库类型</dt>
                <dd className="mt-0.5 text-foreground">
                  {datasource.engine}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">主机</dt>
                <dd className="mt-0.5 font-mono text-foreground">
                  {datasource.host}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">端口 / 数据库</dt>
                <dd className="mt-0.5 font-mono text-foreground">
                  {datasource.port} / {datasource.database}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">环境</dt>
                <dd className="mt-0.5 text-foreground">
                  {datasource.environment}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">访问模式</dt>
                <dd className="mt-0.5">
                  <Badge
                    variant="outline"
                    className="gap-1 border-success-border bg-success-soft font-normal text-success"
                  >
                    <Lock aria-hidden="true" />
                    只读
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">TLS</dt>
                <dd className="mt-0.5 text-foreground">
                  {datasource.ssl ? "启用（配置示例）" : "未启用（配置示例）"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">模拟状态更新时间</dt>
                <dd className="mt-0.5 text-foreground">
                  {datasource.updatedAt}
                </dd>
              </div>
            </dl>
            <div className="mt-4 flex gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-label text-muted-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>
                没有保存任何真实连接凭证。连接状态、表结构和查询结果全部为模拟。
              </p>
            </div>
          </TabsContent>

          <TabsContent value="schema" className="pt-3">
            <p className="text-label text-muted-foreground">
              演示结构，不来自真实数据库扫描。当前允许 {datasource.tables.length}{" "}
              张表。
            </p>
            <div className="mt-2 grid gap-2">
              {datasource.tables.map((table) => (
                <div
                  key={table}
                  className="rounded-lg border border-border bg-card px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Database
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <code className="text-label font-medium text-foreground">
                      {table}
                    </code>
                    <Badge
                      variant="secondary"
                      className="ml-auto h-5 px-1.5 text-caption font-normal"
                    >
                      示例
                    </Badge>
                  </div>
                  <code className="mt-1 block text-caption leading-relaxed text-muted-foreground">
                    {SCHEMA_HINTS[table] ?? "id · created_at"}
                  </code>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="usage" className="pt-3">
            {usages.length > 0 ? (
              <div className="grid gap-2">
                {usages.map((workspace) => (
                  <Link
                    key={workspace.id}
                    to={`/workspaces/${workspace.id}`}
                    onClick={() => onOpenChange(false)}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
                      <Database className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-label font-medium text-foreground">
                        {workspace.title}
                      </strong>
                      <small className="block truncate text-caption text-muted-foreground">
                        {Object.entries(workspace.bindings)
                          .filter(([, sourceId]) => sourceId === datasource.id)
                          .map(([key]) =>
                            key === "orders"
                              ? "订单明细"
                              : key === "profile"
                                ? "客户资料"
                                : "使用趋势"
                          )
                          .join("、") || "数据源范围"}
                      </small>
                    </span>
                    <ArrowRight
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-label text-muted-foreground">
                暂未被工作台使用。可以在创建工作台时选择这个数据源。
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="items-center">
          {onDelete ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending || usages.length > 0}
              title={
                usages.length > 0
                  ? "已被工作台引用，需先解除绑定"
                  : undefined
              }
              onClick={() => onDelete(datasource)}
            >
              <Trash2 aria-hidden="true" />
              删除
            </Button>
          ) : null}
          <span className="flex-1" />
          {onEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onEdit(datasource)}
            >
              编辑连接
            </Button>
          ) : null}
          {onToggleStatus ? (
            <Button
              type="button"
              size="sm"
              variant={
                datasource.status === "connected" ? "outline" : "default"
              }
              disabled={pending}
              onClick={() => onToggleStatus(datasource)}
            >
              <RefreshCw aria-hidden="true" />
              {datasource.status === "connected"
                ? "模拟断开"
                : "恢复模拟连接"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
