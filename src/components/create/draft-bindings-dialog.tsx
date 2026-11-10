import {
  ChartColumn,
  Database,
  Link2,
  Lock,
  Plus,
  Table2,
  TriangleAlert,
  Users,
} from "lucide-react"
import type { BindingKey, Datasource, Workspace } from "@/services"
import { getBindingTable, isBindingCompatible } from "@/services"
import { cn } from "@/lib/utils"
import { BINDING_LABELS, requiredBindings } from "@/lib/workspace-draft"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EngineMark } from "@/components/datasources/engine-mark"

const BINDING_ICONS = {
  orders: Table2,
  profile: Users,
  activity: ChartColumn,
} as const

type DraftBindingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: Workspace
  datasources: readonly Datasource[]
  onBindingChange: (key: BindingKey, sourceId: string) => void
  onOpenSourcePicker: () => void
  onAddSource: () => void
}

export function DraftBindingsDialog({
  open,
  onOpenChange,
  draft,
  datasources,
  onBindingChange,
  onOpenSourcePicker,
  onAddSource,
}: DraftBindingsDialogProps) {
  const modules = requiredBindings(draft)
  const allowedSources = draft.datasourceIds
    .map((id) => datasources.find((source) => source.id === id))
    .filter((source): source is Datasource => Boolean(source))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>数据与模块绑定</DialogTitle>
          <DialogDescription>
            每个模块明确绑定一个数据源并独立执行只读查询，不进行隐式跨库 JOIN。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          {modules.map((key) => {
            const Icon = BINDING_ICONS[key]
            const compatible = allowedSources.filter((source) =>
              isBindingCompatible(key, source)
            )
            const currentId = draft.bindings[key]
            const current = datasources.find((source) => source.id === currentId)
            const currentCompatible = current
              ? isBindingCompatible(key, current)
              : false

            return (
              <div
                key={key}
                className="rounded-lg border border-border px-3 py-3"
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-label font-medium text-foreground">
                        {BINDING_LABELS[key]}
                      </strong>
                      <Badge
                        variant="outline"
                        className="font-normal text-muted-foreground"
                      >
                        只读
                      </Badge>
                      {currentCompatible ? (
                        <Badge
                          variant="outline"
                          className="border-success-border bg-success-soft font-normal text-success"
                        >
                          已就绪
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-destructive/30 bg-destructive/10 font-normal text-destructive"
                        >
                          待绑定
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      需要表{" "}
                      <code className="text-foreground">
                        {getBindingTable(key)}
                      </code>
                      ，参数化查询，执行前由服务端校验权限。
                    </p>
                  </div>
                </div>

                {compatible.length > 0 ? (
                  <div className="mt-2.5 flex items-center gap-2">
                    <Select
                      items={compatible.map((source) => ({
                        value: source.id,
                        label: `${source.name} · ${source.engine}`,
                      }))}
                      value={currentCompatible ? currentId : ""}
                      onValueChange={(value) =>
                        onBindingChange(key, String(value))
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        className="min-w-0 flex-1 bg-card"
                        aria-label={`${BINDING_LABELS[key]}的数据源`}
                        aria-invalid={!currentCompatible}
                      >
                        <SelectValue placeholder="选择一个兼容的数据源" />
                      </SelectTrigger>
                      <SelectContent>
                        {compatible.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.name} · {source.engine}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {current ? (
                      <>
                        <EngineMark engine={current.engine} />
                        <span
                          className={cn(
                            "text-caption",
                            current.status === "connected"
                              ? "text-muted-foreground"
                              : "text-destructive"
                          )}
                        >
                          {current.status === "connected" ? "可用" : "离线"}
                        </span>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-warning-border bg-warning-soft px-2.5 py-2">
                    <TriangleAlert
                      className="size-3.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1 text-caption leading-relaxed text-warning">
                      所选数据源中没有包含{" "}
                      <code>{getBindingTable(key)}</code> 表的连接。
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="bg-card"
                      onClick={onOpenSourcePicker}
                    >
                      更改数据源
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="bg-card"
                      onClick={onAddSource}
                    >
                      <Plus aria-hidden="true" />
                      添加
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
          <Link2
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-caption leading-relaxed text-muted-foreground">
            客户联动使用已确认的映射键（如 <code>customer_id</code>
            ）分别查询各数据源，不把多个数据库拼成一条 SQL。
          </p>
        </div>

        <div className="flex items-start gap-2 text-caption text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 leading-relaxed">
            这里的绑定只作用于当前草稿，保存前不会影响已保存的工作台。正式权限由可信服务端执行。
          </p>
        </div>

        <DialogFooter className="items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto"
            onClick={onOpenSourcePicker}
          >
            <Database aria-hidden="true" />
            更改工作台数据源
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
