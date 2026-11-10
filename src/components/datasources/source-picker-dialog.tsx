import { Database, Plus, Search } from "lucide-react"
import { useState } from "react"
import type { Datasource, DatasourceEnvironment } from "@/services"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { EngineMark } from "./engine-mark"

const ENVIRONMENT_FILTERS: readonly ("all" | DatasourceEnvironment)[] = [
  "all",
  "生产",
  "测试",
  "分析",
]

type SourcePickerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasources: readonly Datasource[]
  selectedIds: readonly string[]
  onConfirm: (ids: string[]) => void
  title?: string
  description?: string
  note?: string
  /** Opens the add-datasource flow. The list itself stays read-only. */
  onAdd?: () => void
  /** Allows confirming an empty selection, e.g. before showing guidance. */
  allowEmpty?: boolean
}

export function SourcePickerDialog({
  open,
  onOpenChange,
  datasources,
  selectedIds,
  onConfirm,
  title = "选择工作台数据源",
  description = "可选择多个来源。每个模块独立查询；不执行任意跨库 JOIN。",
  note,
  onAdd,
  allowEmpty = false,
}: SourcePickerDialogProps) {
  const [selected, setSelected] = useState<string[]>([...selectedIds])
  const [search, setSearch] = useState("")
  const [environment, setEnvironment] = useState<"all" | DatasourceEnvironment>(
    "all"
  )
  const [wasOpen, setWasOpen] = useState(open)

  if (open && !wasOpen) {
    setWasOpen(true)
    setSelected([...selectedIds])
    setSearch("")
    setEnvironment("all")
  } else if (!open && wasOpen) {
    setWasOpen(false)
  }

  const query = search.trim().toLowerCase()
  const filtered = datasources.filter((datasource) => {
    const matchesEnvironment =
      environment === "all" || datasource.environment === environment
    const matchesQuery =
      !query ||
      [datasource.name, datasource.engine, datasource.database, datasource.host]
        .join(" ")
        .toLowerCase()
        .includes(query)
    return matchesEnvironment && matchesQuery
  })

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) =>
      checked ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索名称、数据库类型或库名…"
                aria-label="搜索数据源"
                className="bg-card pl-8"
              />
            </div>
            {onAdd ? (
              <Button type="button" variant="outline" className="shrink-0 bg-card" onClick={onAdd}>
                <Plus aria-hidden="true" />
                添加数据源
              </Button>
            ) : null}
          </div>

          <div
            className="flex flex-wrap items-center gap-1"
            aria-label="按环境筛选数据源"
          >
            {ENVIRONMENT_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={environment === value}
                onClick={() => setEnvironment(value)}
                className={cn(
                  "rounded-md px-2 py-1 text-caption font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  environment === value
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {value === "all" ? "全部环境" : value}
              </button>
            ))}
            <span className="ml-auto text-caption text-muted-foreground tabular-nums">
              {filtered.length} / {datasources.length}
            </span>
          </div>
        </div>

        <div className="grid max-h-[46svh] gap-1.5 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <Database
                className="mx-auto size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-2 text-label font-medium text-foreground">
                {datasources.length === 0
                  ? "还没有数据源"
                  : "没有找到匹配的数据源"}
              </p>
              <p className="mt-1 text-caption text-muted-foreground">
                {datasources.length === 0
                  ? "添加数据库连接后即可用于创建工作台。"
                  : "调整搜索词或环境筛选后再试。"}
              </p>
              <div className="mt-2 flex justify-center gap-2">
                {datasources.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setSearch("")
                      setEnvironment("all")
                    }}
                  >
                    清除筛选
                  </Button>
                ) : null}
                {onAdd ? (
                  <Button type="button" size="xs" onClick={onAdd}>
                    <Plus aria-hidden="true" />
                    添加数据源
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {filtered.map((datasource) => {
            const checked = selected.includes(datasource.id)

            return (
              <label
                key={datasource.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  checked
                    ? "border-primary/30 bg-primary/10"
                    : "border-border bg-card hover:bg-accent"
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) =>
                    toggle(datasource.id, value === true)
                  }
                  aria-label={`选择 ${datasource.name}`}
                />
                <EngineMark engine={datasource.engine} />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-label font-medium text-foreground">
                    {datasource.name}
                  </strong>
                  <small className="block truncate text-caption text-muted-foreground">
                    {datasource.engine} · {datasource.environment} ·{" "}
                    {datasource.database}
                  </small>
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 font-normal",
                    datasource.status === "connected"
                      ? "border-success-border bg-success-soft text-success"
                      : "border-destructive/30/25 bg-destructive/10 text-destructive"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      datasource.status === "connected"
                        ? "bg-success"
                        : "bg-destructive"
                    )}
                    aria-hidden="true"
                  />
                  {datasource.status === "connected" ? "可用" : "离线"}
                </Badge>
              </label>
            )
          })}
        </div>

        {note ? (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-label text-muted-foreground">
            {note}
          </p>
        ) : null}

        <DialogFooter className="items-center">
          <span className="text-label text-muted-foreground">
            已选 {selected.length} 个
          </span>
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!allowEmpty && selected.length === 0}
            onClick={() => {
              onConfirm(selected)
              onOpenChange(false)
            }}
          >
            确认选择
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
