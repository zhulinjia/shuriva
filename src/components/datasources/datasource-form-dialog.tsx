import { Check, Loader2, RefreshCw, Server } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type {
  Datasource,
  DatasourceDomain,
  DatasourceEngine,
  DatasourceEnvironment,
  DatasourceInput,
} from "@/services"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EngineMark } from "./engine-mark"

const ENGINES: {
  name: DatasourceEngine
  description: string
  port: string
}[] = [
  { name: "PostgreSQL", description: "关系型数据库", port: "5432" },
  { name: "MySQL", description: "关系型数据库", port: "3306" },
  { name: "ClickHouse", description: "分析型数据库", port: "8443" },
]

const DOMAIN_TABLES: Record<DatasourceDomain, string[]> = {
  orders: ["orders", "payments"],
  members: ["customers", "subscriptions"],
  events: ["user_events"],
}

type FormState = {
  name: string
  engine: DatasourceEngine
  environment: DatasourceEnvironment
  host: string
  port: string
  database: string
  username: string
  password: string
  ssl: boolean
  domain: DatasourceDomain
  tables: string[]
  fail: boolean
}

function initialForm(datasource?: Datasource | null): FormState {
  if (datasource) {
    return {
      name: datasource.name,
      engine: datasource.engine,
      environment: datasource.environment,
      host: datasource.host,
      port: datasource.port,
      database: datasource.database,
      username: "demo_readonly",
      password: "",
      ssl: datasource.ssl,
      domain: datasource.domain,
      tables: [...datasource.tables],
      fail: false,
    }
  }

  return {
    name: "",
    engine: "PostgreSQL",
    environment: "生产",
    host: "",
    port: "5432",
    database: "",
    username: "demo_readonly",
    password: "",
    ssl: true,
    domain: "orders",
    tables: ["orders", "payments"],
    fail: false,
  }
}

type DatasourceFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  datasource?: Datasource | null
  pending?: boolean
  submitError?: string | null
  onSubmit: (input: DatasourceInput) => void
}

export function DatasourceFormDialog({
  open,
  onOpenChange,
  datasource,
  pending = false,
  submitError,
  onSubmit,
}: DatasourceFormDialogProps) {
  const [wasOpen, setWasOpen] = useState(open)
  const [form, setForm] = useState<FormState>(() => initialForm(datasource))
  const [step, setStep] = useState(datasource ? 2 : 1)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const testToken = useRef(0)

  useEffect(() => {
    testToken.current += 1
  }, [open, datasource])

  if (open && !wasOpen) {
    setWasOpen(true)
    setForm(initialForm(datasource))
    setStep(datasource ? 2 : 1)
    setTesting(false)
    setTestResult(null)
    setFormError(null)
  } else if (!open && wasOpen) {
    setWasOpen(false)
  }

  const update = <K extends keyof FormState>(
    key: K,
    value: FormState[K]
  ) => {
    setForm((current) => ({ ...current, [key]: value }))
    setTestResult(null)
    setTesting(false)
    setFormError(null)
    testToken.current += 1
  }

  const chooseEngine = (engine: DatasourceEngine) => {
    const option = ENGINES.find((item) => item.name === engine)
    const domain: DatasourceDomain =
      engine === "MySQL" ? "members" : engine === "ClickHouse" ? "events" : "orders"
    setForm((current) => ({
      ...current,
      engine,
      port: option?.port ?? current.port,
      domain,
      tables: [...DOMAIN_TABLES[domain]],
    }))
    setTestResult(null)
    setFormError(null)
  }

  const testConnection = async () => {
    if (
      !form.name.trim() ||
      !form.host.trim() ||
      !form.database.trim() ||
      !form.username.trim() ||
      !Number.isInteger(Number(form.port)) ||
      Number(form.port) < 1 ||
      Number(form.port) > 65535
    ) {
      setFormError("请填写名称、主机、数据库、模拟账号和有效端口。")
      return
    }

    setFormError(null)
    setTesting(true)
    setTestResult(null)
    const token = testToken.current + 1
    testToken.current = token

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 650)
    })

    if (token !== testToken.current) return
    setTesting(false)
    setTestResult(
      form.fail || form.host.includes("fail") ? "error" : "success"
    )
  }

  const next = () => {
    if (step === 1) {
      setStep(2)
      return
    }
    if (step === 2 && testResult === "success") setStep(3)
  }

  const save = () => {
    if (testResult !== "success" || form.tables.length === 0) return
    onSubmit({
      name: form.name.trim(),
      engine: form.engine,
      environment: form.environment,
      host: form.host.trim(),
      port: form.port,
      database: form.database.trim(),
      domain: form.domain,
      tables: [...form.tables],
      ssl: form.ssl,
    })
  }

  const tables = DOMAIN_TABLES[form.domain]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {datasource ? "编辑数据库连接" : "添加数据源"}
          </DialogTitle>
          <DialogDescription>
            当前为模拟流程。不会建立真实连接，也不会保存密码。
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex items-center gap-1 text-caption"
          aria-label="添加数据源步骤"
        >
          {["选择类型", "连接配置", "访问范围"].map((label, index) => {
            const number = index + 1
            return (
              <div
                key={label}
                className={cn(
                  "flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5",
                  step === number
                    ? "bg-primary/10 text-primary"
                    : step > number
                      ? "text-success"
                      : "text-muted-foreground"
                )}
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                    step === number
                      ? "border-primary/30 bg-card"
                      : step > number
                        ? "border-success-border bg-success-soft"
                        : "border-border"
                  )}
                >
                  {step > number ? (
                    <Check className="size-3" aria-hidden="true" />
                  ) : (
                    number
                  )}
                </span>
                <span className="whitespace-nowrap">{label}</span>
              </div>
            )
          })}
        </div>

        <div className="max-h-[56svh] overflow-y-auto pr-1">
          {step === 1 ? (
            <div>
              <h3 className="text-label font-medium text-foreground">
                选择数据库类型
              </h3>
              <p className="mt-1 text-label text-muted-foreground">
                同一种数据库可以创建多个连接，分别管理生产和测试环境。
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {ENGINES.map((engine) => {
                  const selected = form.engine === engine.name
                  return (
                    <button
                      key={engine.name}
                      type="button"
                      onClick={() => chooseEngine(engine.name)}
                      className={cn(
                        "flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        selected
                          ? "border-primary/30 bg-primary/10"
                          : "border-border bg-card hover:bg-accent"
                      )}
                      aria-pressed={selected}
                    >
                      <EngineMark engine={engine.name} size="lg" />
                      <span>
                        <strong className="block text-label font-medium text-foreground">
                          {engine.name}
                        </strong>
                        <small className="block text-caption text-muted-foreground">
                          {engine.description}
                        </small>
                      </span>
                      {selected ? (
                        <Badge
                          variant="outline"
                          className="border-primary/20 bg-card font-normal text-primary"
                        >
                          已选择
                        </Badge>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              <p className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-label text-muted-foreground">
                当前支持三种类型的模拟流程，不代表已接入真实驱动。
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="连接名称" htmlFor="ds-name">
                  <Input
                    id="ds-name"
                    value={form.name}
                    onChange={(event) => update("name", event.target.value)}
                    placeholder="例如：订单生产库"
                    autoComplete="off"
                  />
                </Field>
                <Field label="环境" htmlFor="ds-environment">
                  <Select
                    items={{ 生产: "生产", 测试: "测试", 分析: "分析" }}
                    value={form.environment}
                    onValueChange={(value) =>
                      update("environment", value as DatasourceEnvironment)
                    }
                  >
                    <SelectTrigger id="ds-environment" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="生产">生产</SelectItem>
                      <SelectItem value="测试">测试</SelectItem>
                      <SelectItem value="分析">分析</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="主机地址" htmlFor="ds-host">
                  <Input
                    id="ds-host"
                    value={form.host}
                    onChange={(event) => update("host", event.target.value)}
                    placeholder="db.internal.example"
                    autoComplete="off"
                  />
                </Field>
                <Field label="端口" htmlFor="ds-port">
                  <Input
                    id="ds-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(event) => update("port", event.target.value)}
                  />
                </Field>
                <Field label="数据库名" htmlFor="ds-database">
                  <Input
                    id="ds-database"
                    value={form.database}
                    onChange={(event) =>
                      update("database", event.target.value)
                    }
                    placeholder="commerce"
                    autoComplete="off"
                  />
                </Field>
                <Field label="模拟账号" htmlFor="ds-username">
                  <Input
                    id="ds-username"
                    value={form.username}
                    onChange={(event) =>
                      update("username", event.target.value)
                    }
                    placeholder="demo_readonly"
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="密码（仅演示）"
                  htmlFor="ds-password"
                  hint="仅保留在当前弹窗，不写入本地存储。"
                >
                  <Input
                    id="ds-password"
                    type="password"
                    value={form.password}
                    onChange={(event) =>
                      update("password", event.target.value)
                    }
                    placeholder="不要填写真实密码"
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="示例业务数据" htmlFor="ds-domain">
                  <Select
                    items={{
                      orders: "订单与支付",
                      members: "会员与订阅",
                      events: "用户行为",
                    }}
                    value={form.domain}
                    onValueChange={(value) => {
                      const domain = value as DatasourceDomain
                      setForm((current) => ({
                        ...current,
                        domain,
                        tables: [...DOMAIN_TABLES[domain]],
                      }))
                      setTestResult(null)
                    }}
                  >
                    <SelectTrigger id="ds-domain" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="orders">订单与支付</SelectItem>
                      <SelectItem value="members">会员与订阅</SelectItem>
                      <SelectItem value="events">用户行为</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <label className="mt-3 flex items-center gap-2 text-label text-foreground">
                <Checkbox
                  checked={form.ssl}
                  onCheckedChange={(checked) =>
                    update("ssl", checked === true)
                  }
                />
                启用 TLS / SSL（配置示例）
              </label>

              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/50 p-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testing}
                  onClick={() => void testConnection()}
                >
                  {testing ? (
                    <Loader2
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                  {testing ? "正在模拟测试…" : "测试连接"}
                </Button>
                <label className="flex items-center gap-2 text-label text-muted-foreground">
                  <Checkbox
                    checked={form.fail}
                    onCheckedChange={(checked) =>
                      update("fail", checked === true)
                    }
                  />
                  模拟连接失败
                </label>
              </div>

              {testResult === "success" ? (
                <p className="mt-3 rounded-md border border-success-border bg-success-soft px-3 py-2 text-label text-success">
                  模拟连接成功。下一步选择可用表；不会实际连接数据库。
                </p>
              ) : null}
              {testResult === "error" ? (
                <p className="mt-3 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive">
                  模拟连接失败：主机不可达。关闭“模拟连接失败”后可重试。
                </p>
              ) : null}
              {formError ? (
                <p
                  className="mt-3 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive"
                  role="alert"
                >
                  {formError}
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <div className="flex items-center gap-3 rounded-lg border border-success-border bg-success-soft p-3">
                <span className="grid size-9 place-items-center rounded-full bg-card text-success">
                  <Check className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-label font-medium text-foreground">
                    连接测试已通过（模拟）
                  </strong>
                  <small className="block truncate text-caption text-muted-foreground">
                    {form.name} · {form.engine} · {form.database}
                  </small>
                </div>
                <Badge
                  variant="outline"
                  className="border-success-border bg-card font-normal text-success"
                >
                  只读
                </Badge>
              </div>

              <h3 className="mt-4 text-label font-medium text-foreground">
                允许工作台使用的表
              </h3>
              <p className="mt-1 text-label text-muted-foreground">
                限定可用范围。正式版本需要在后端查询层执行这些限制。
              </p>
              <div className="mt-2 grid gap-1.5">
                {tables.map((table) => {
                  const checked = form.tables.includes(table)
                  return (
                    <label
                      key={table}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) =>
                          update(
                            "tables",
                            value === true
                              ? [...new Set([...form.tables, table])]
                              : form.tables.filter((item) => item !== table)
                          )
                        }
                      />
                      <Server
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <code className="text-label text-foreground">{table}</code>
                      <small className="ml-auto text-caption text-muted-foreground">
                        示例结构
                      </small>
                    </label>
                  )
                })}
              </div>
              <p className="mt-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-label text-muted-foreground">
                正式开源版由你部署的 Shuriva 后端保存凭证、建立连接。其他设备访问同一服务，不需要重新添加连接。
              </p>
            </div>
          ) : null}

          {submitError ? (
            <p
              className="mt-3 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (step === 1) onOpenChange(false)
              else setStep((current) => Math.max(1, current - 1))
            }}
          >
            {step === 1 ? "取消" : "上一步"}
          </Button>
          <span className="flex-1" />
          {step === 3 ? (
            <Button
              type="button"
              size="sm"
              disabled={pending || form.tables.length === 0}
              onClick={save}
            >
              {pending ? (
                <Loader2
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Check aria-hidden="true" />
              )}
              {pending ? "保存中…" : "保存数据源"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={step === 2 && testResult !== "success"}
              onClick={next}
            >
              下一步
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? (
        <p className="text-caption text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
