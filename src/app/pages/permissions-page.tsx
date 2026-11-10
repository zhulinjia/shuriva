import {
  ArrowRight,
  Check,
  Code2,
  Eye,
  Lock,
  Save,
  ShieldCheck,
  Users,
} from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"
import type {
  FieldAccess,
  PermissionPolicy,
  RoleId,
  RowScope,
} from "@/services"
import {
  useDatasources,
  usePermissionPolicies,
  usePolicyActions,
  useWorkspaces,
} from "@/hooks/use-workspaces"
import { useDemoStore } from "@/stores/demo-store"
import { cn } from "@/lib/utils"
import { PageContainer } from "@/components/layout/page-container"
import { EngineMark } from "@/components/datasources/engine-mark"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Notice } from "@/components/common/notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

const FIELD_ROWS: {
  key: keyof PermissionPolicy["fields"]
  label: string
  column: string
  sample: string
}[] = [
  {
    key: "phone",
    label: "客户手机号",
    column: "customers.phone",
    sample: "13820105678",
  },
  {
    key: "email",
    label: "客户邮箱",
    column: "customers.email",
    sample: "demo@example.com",
  },
  { key: "cost", label: "订单成本", column: "orders.cost", sample: "420.00" },
]

const FIELD_ACCESS_ITEMS: { value: FieldAccess; label: string }[] = [
  { value: "raw", label: "原文可见" },
  { value: "masked", label: "脱敏可见" },
  { value: "hidden", label: "不可访问" },
]

const ROW_SCOPES: { value: RowScope; label: string; rule: string }[] = [
  {
    value: "all",
    label: "全部已授权记录",
    rule: "在已授权数据源和数据集中读取",
  },
  {
    value: "assigned",
    label: "仅本人负责的记录",
    rule: "orders.assignee_id = current_user.id",
  },
  {
    value: "store",
    label: "仅所属门店的记录",
    rule: "orders.store_id IN current_user.store_ids",
  },
]

function maskSample(value: string, key: string) {
  if (key === "phone") {
    return value.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")
  }
  if (key === "email") {
    return value.replace(/^(.).+(@.+)$/, "$1***$2")
  }
  return "••••"
}

export function PermissionsPage() {
  const edition = useDemoStore((state) => state.edition)
  const setEdition = useDemoStore((state) => state.setEdition)
  const setPreviewRole = useDemoStore((state) => state.setPreviewRole)
  const policies = usePermissionPolicies()
  const datasources = useDatasources()
  const workspaces = useWorkspaces()
  const policyActions = usePolicyActions()
  const navigate = useNavigate()

  const [roleId, setRoleId] = useState<RoleId>("support")
  const [draft, setDraft] = useState<PermissionPolicy | null>(null)
  const [tab, setTab] = useState<"fields" | "sources" | "members">("fields")
  const [switchTarget, setSwitchTarget] = useState<RoleId | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (edition !== "team") {
    return (
      <PageContainer
        eyebrow="TEAM DESIGN"
        title="成员与数据权限"
        description="开源版保持单用户。这一页是独立的团队权限设计预览。"
      >
        <div className="mx-auto flex max-w-xl flex-col items-center rounded-xl border border-border bg-card px-6 py-10 text-center">
          <span className="grid size-14 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
            <ShieldCheck className="size-7" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-section-title font-semibold text-foreground">
            不同成员，看到不同的数据
          </h2>
          <p className="mt-2 max-w-md text-label leading-relaxed text-muted-foreground">
            团队版将提供用户组、字段权限、记录范围和导出控制。它不会改变开源版的直连流程，也不预设云版连接架构。
          </p>
          <Button
            type="button"
            className="mt-4"
            onClick={() => {
              setEdition("team")
              setStatus(null)
            }}
          >
            进入团队权限预览
            <ArrowRight aria-hidden="true" />
          </Button>
          <small className="mt-2 text-caption text-muted-foreground">
            仅切换原型视图，不创建组织、不邀请成员。
          </small>
        </div>
        <div className="mt-4">
          <Notice tone="warning">
            团队权限页面不是生产鉴权。Community 是单用户产品，不会向普通使用界面展示团队权限导航。
          </Notice>
        </div>
      </PageContainer>
    )
  }

  if (policies.isPending) {
    return (
      <PageContainer title="成员与数据权限" description="读取本地模拟策略。">
        <div aria-busy="true" className="grid gap-3 min-[981px]:grid-cols-[260px_minmax(0,1fr)]">
          <Skeleton className="h-72 w-full rounded-lg" />
          <Skeleton className="h-[480px] w-full rounded-lg" />
        </div>
      </PageContainer>
    )
  }

  if (policies.isError) {
    return (
      <PageContainer title="策略加载失败" description="本地模拟服务没有返回权限策略。">
        <Button type="button" onClick={() => void policies.refetch()}>
          重试
        </Button>
      </PageContainer>
    )
  }

  const savedPolicy = policies.data[roleId]
  const policy = draft ?? savedPolicy
  const changed = Boolean(
    draft && JSON.stringify(draft) !== JSON.stringify(savedPolicy)
  )
  const roleIds = Object.keys(policies.data) as RoleId[]
  const rowScope = ROW_SCOPES.find((item) => item.value === policy.rowScope)
  const targetWorkspace =
    workspaces.data?.find((workspace) => workspace.id === "customer-360") ??
    workspaces.data?.[0]
  const memberId =
    roleId === "support"
      ? "support-01"
      : roleId === "operator"
        ? "store-operator-01"
        : "finance-01"
  const memberScope = roleId === "operator" ? "杭州门店" : "示例组织"

  const update = (updater: (current: PermissionPolicy) => PermissionPolicy) => {
    setDraft((current) => updater(structuredClone(current ?? savedPolicy)))
    setActionError(null)
  }

  const selectRole = (next: RoleId) => {
    if (next === roleId) return
    if (changed) {
      setSwitchTarget(next)
      return
    }
    setRoleId(next)
    setDraft(null)
    setTab("fields")
  }

  const savePolicy = () => {
    if (!changed) return
    setActionError(null)
    policyActions.save.mutate(
      { role: roleId, policy },
      {
        onSuccess: (saved) => {
          setDraft(saved[roleId])
          setStatus(
            `已保存「${policy.label}」的模拟策略。正式版本必须由可信服务端执行。`
          )
        },
        onError: () => setActionError("保存失败，请重试。"),
      }
    )
  }

  const previewRole = () => {
    if (changed) return
    setPreviewRole(roleId)
    if (targetWorkspace) {
      navigate(`/workspaces/${targetWorkspace.id}`)
    } else {
      navigate("/workspaces")
    }
  }

  return (
    <PageContainer
      eyebrow="TEAM · DESIGN PREVIEW"
      title="成员与数据权限"
      description="同一个工作台，按成员身份返回允许访问的数据。"
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={previewRole}
            disabled={changed}
            title={changed ? "请先保存策略草稿" : undefined}
          >
            <Eye aria-hidden="true" />
            预览成员视角
          </Button>
          <Button
            type="button"
            onClick={savePolicy}
            disabled={!changed || policyActions.save.isPending}
          >
            <Save aria-hidden="true" />
            {policyActions.save.isPending ? "保存中…" : "保存策略"}
          </Button>
        </>
      }
    >
      <Notice>
        这是团队版的权限交互演示，不是生产鉴权。数据库连接方案仍待确定；正式规则必须由可信后端执行。
      </Notice>

      <p role="status" className="sr-only">
        {status ?? actionError}
      </p>
      {status ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-success-border bg-success-soft px-3 py-2 text-label text-success">
          <span className="flex-1">{status}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setStatus(null)}
          >
            关闭
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30/25 bg-destructive/10 px-3 py-2 text-label text-destructive">
          <span className="flex-1">{actionError}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => setActionError(null)}
          >
            关闭
          </button>
        </div>
      ) : null}

      <div className="mt-3 grid items-start gap-3 min-[981px]:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-border bg-card p-2">
          <div className="px-2 py-1.5 text-caption font-medium tracking-wide text-muted-foreground">
            业务角色 / 用户组
          </div>
          <div className="grid gap-1">
            {roleIds.map((id) => {
              const item = policies.data[id]
              const selected = id === roleId

              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => selectRole(id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border px-2 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    selected
                      ? "border-primary/30 bg-primary/10"
                      : "border-transparent hover:bg-accent"
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-label font-semibold text-primary">
                    {item.label[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-label font-medium text-foreground">
                      {item.label}
                    </strong>
                    <small className="block text-caption leading-snug text-muted-foreground">
                      {item.description}
                    </small>
                  </span>
                  {selected ? (
                    <Check
                      className="size-3.5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              )
            })}
          </div>

          <div className="mt-2 border-t border-border px-2 pt-2.5">
            <span className="flex items-center gap-1.5 text-caption text-foreground">
              <Users className="size-4 text-muted-foreground" aria-hidden="true" />
              3 个演示角色
            </span>
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              成员管理与数据读取权限分开。组织管理员不默认获得全部原始数据。
            </p>
          </div>
        </aside>

        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5">
            <div>
              <h2 className="text-card-title font-medium text-foreground">
                {policy.label}
              </h2>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {policy.description}
              </p>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "font-normal",
                changed
                  ? "border-warning-border bg-warning-soft text-warning"
                  : "border-success-border bg-success-soft text-success"
              )}
            >
              {changed ? "有未保存修改" : "已保存示例策略"}
            </Badge>
          </div>

          <div
            role="tablist"
            aria-label="权限配置"
            className="mt-3 flex gap-1 border-b border-border px-4"
          >
            {(
              [
                ["fields", "字段与记录"],
                ["sources", "数据源与操作"],
                ["members", "关联成员"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "min-h-9 border-b-2 px-2 text-label font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                  tab === value
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="p-4">
            {tab === "fields" ? (
              <div className="grid gap-5">
                <section>
                  <h3 className="text-label font-medium text-foreground">
                    字段访问
                  </h3>
                  <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                    隐藏不只是取消勾选列；详情、复制、导出与 AI 也必须遵守。
                  </p>

                  <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[520px] text-left text-label">
                      <caption className="sr-only">
                        {policy.label}的字段访问策略
                      </caption>
                      <thead className="bg-muted/50 text-caption text-muted-foreground">
                        <tr>
                          <th scope="col" className="px-3 py-2 font-medium">
                            字段
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            访问方式
                          </th>
                          <th scope="col" className="px-3 py-2 font-medium">
                            示例结果
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <tr>
                          <td className="px-3 py-2">
                            <strong className="block font-medium text-foreground">
                              订单编号 / 状态
                            </strong>
                            <small className="block text-caption text-muted-foreground">
                              orders.id / orders.status
                            </small>
                          </td>
                          <td className="px-3 py-2">
                            <Badge
                              variant="outline"
                              className="border-success-border bg-success-soft font-normal text-success"
                            >
                              原文可见
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            <code className="text-caption text-muted-foreground">
                              ORD-261108-1048
                            </code>
                          </td>
                        </tr>
                        {FIELD_ROWS.map((field) => {
                          const access = policy.fields[field.key]

                          return (
                            <tr key={field.key}>
                              <td className="px-3 py-2">
                                <strong className="block font-medium text-foreground">
                                  {field.label}
                                </strong>
                                <small className="block text-caption text-muted-foreground">
                                  {field.column}
                                </small>
                              </td>
                              <td className="px-3 py-2">
                                <label
                                  htmlFor={`policy-field-${field.key}`}
                                  className="sr-only"
                                >
                                  {field.label}访问方式
                                </label>
                                <Select
                                  items={FIELD_ACCESS_ITEMS}
                                  value={access}
                                  onValueChange={(value) =>
                                    update((current) => ({
                                      ...current,
                                      fields: {
                                        ...current.fields,
                                        [field.key]: value as FieldAccess,
                                      },
                                    }))
                                  }
                                >
                                  <SelectTrigger
                                    id={`policy-field-${field.key}`}
                                    size="sm"
                                    className="w-32 bg-card"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent align="start">
                                    <SelectItem value="raw">
                                      原文可见
                                    </SelectItem>
                                    <SelectItem value="masked">
                                      脱敏可见
                                    </SelectItem>
                                    <SelectItem value="hidden">
                                      不可访问
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={cn(
                                    "text-caption",
                                    access === "hidden"
                                      ? "text-muted-foreground italic"
                                      : "text-foreground tabular-nums"
                                  )}
                                >
                                  {access === "hidden"
                                    ? "不返回字段"
                                    : access === "masked"
                                      ? maskSample(field.sample, field.key)
                                      : field.sample}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section>
                  <h3 className="text-label font-medium text-foreground">
                    记录范围
                  </h3>
                  <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                    同一限制用于列表、详情、指标和导出，不能通过筛选放宽。
                  </p>
                  <div className="mt-2">
                    <label htmlFor="policy-row-scope" className="sr-only">
                      记录范围
                    </label>
                    <Select
                      items={ROW_SCOPES}
                      value={policy.rowScope}
                      onValueChange={(value) =>
                        update((current) => ({
                          ...current,
                          rowScope: value as RowScope,
                        }))
                      }
                    >
                      <SelectTrigger
                        id="policy-row-scope"
                        className="w-full bg-card sm:w-64"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start">
                        {ROW_SCOPES.map((scope) => (
                          <SelectItem key={scope.value} value={scope.value}>
                            {scope.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
                    <Code2
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <code className="text-caption leading-relaxed text-foreground">
                      {rowScope?.rule}
                    </code>
                  </div>
                  <small className="mt-1 block text-caption text-muted-foreground">
                    当前示例：客服 support-01，门店运营属于杭州门店。正式身份属性由后端确认。
                  </small>
                </section>
              </div>
            ) : tab === "sources" ? (
              <div className="grid gap-5">
                <section>
                  <h3 className="text-label font-medium text-foreground">
                    允许使用的数据源
                  </h3>
                  <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                    工作台被分享，不意味着数据源读取权同时被授予。
                  </p>
                  <div className="mt-2 grid gap-1.5">
                    {(datasources.data ?? []).map((source) => {
                      const checked = policy.allowedSources.includes(source.id)

                      return (
                        <div
                          key={source.id}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md border px-2.5 py-2",
                            checked
                              ? "border-primary/20 bg-primary/10"
                              : "border-border bg-card"
                          )}
                        >
                          <Checkbox
                            id={`policy-source-${source.id}`}
                            checked={checked}
                            onCheckedChange={(value) =>
                              update((current) => ({
                                ...current,
                                allowedSources:
                                  value === true
                                    ? [...new Set([...current.allowedSources, source.id])]
                                    : current.allowedSources.filter(
                                        (id) => id !== source.id
                                      ),
                              }))
                            }
                          />
                          <label
                            htmlFor={`policy-source-${source.id}`}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
                          >
                            <EngineMark engine={source.engine} size="sm" />
                            <span className="min-w-0">
                              <strong className="block truncate text-label font-medium text-foreground">
                                {source.name}
                              </strong>
                              <small className="block text-caption text-muted-foreground">
                                {source.engine}
                              </small>
                            </span>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                </section>

                <section>
                  <h3 className="text-label font-medium text-foreground">
                    额外操作
                  </h3>
                  <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <label
                        htmlFor="policy-export"
                        className="min-w-0 flex-1 cursor-pointer"
                      >
                        <strong className="block text-label font-medium text-foreground">
                          允许导出
                        </strong>
                        <small className="block text-caption text-muted-foreground">
                          仍按字段与记录规则返回结果
                        </small>
                      </label>
                      <Checkbox
                        id="policy-export"
                        checked={policy.export}
                        onCheckedChange={(value) =>
                          update((current) => ({
                            ...current,
                            export: value === true,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <label
                        htmlFor="policy-ai"
                        className="min-w-0 flex-1 cursor-pointer"
                      >
                        <strong className="block text-label font-medium text-foreground">
                          敏感字段允许交给 AI
                        </strong>
                        <small className="block text-caption text-muted-foreground">
                          独立授权，不因用户可见而默认允许
                        </small>
                      </label>
                      <Checkbox
                        id="policy-ai"
                        checked={policy.aiSensitive}
                        onCheckedChange={(value) =>
                          update((current) => ({
                            ...current,
                            aiSensitive: value === true,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-2">
                    <Notice>
                      本原型没有发送任何数据给模型。AI 数据授权开关只演示配置，不代表已完成数据安全机制。
                    </Notice>
                  </div>
                </section>
              </div>
            ) : (
              <section>
                <h3 className="text-label font-medium text-foreground">
                  关联成员
                </h3>
                <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">
                  用于检查角色与记录范围的样例身份，不是真实账号。
                </p>
                <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-label font-semibold text-primary">
                    {policy.label[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-label font-medium text-foreground">
                      {policy.label}演示成员
                    </strong>
                    <small className="block text-caption text-muted-foreground">
                      {memberId} · {memberScope}
                    </small>
                  </span>
                  <Badge variant="outline" className="font-normal">
                    模拟成员
                  </Badge>
                </div>

                <div className="mt-2">
                  <Notice>
                    成员邀请、登录认证、撤权和审计需要在真实后端接入时实现。此页不创建组织或账号。
                  </Notice>
                </div>

                <div className="mt-4 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-caption leading-relaxed text-muted-foreground">
                  预览成员视角会切换到工作台使用页，并按此策略返回模拟数据。
                  工作台标题、数据源名称和成员身份均为虚构示例。
                </div>
              </section>
            )}

            <div className="mt-5 flex items-start gap-1.5 border-t border-border pt-3 text-caption text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              默认拒绝 · 显式禁止优先 · 前端不是安全边界
            </div>
          </div>
        </section>
      </div>

      <div className="mt-3">
        <Notice tone="warning" icon="server">
          团队版数据库连接架构尚未确定。本页不假设云端托管凭证、独立 Connector 或浏览器直连中的任何一种方案。
        </Notice>
      </div>

      <ConfirmDialog
        open={Boolean(switchTarget)}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null)
        }}
        title="切换角色并放弃未保存修改？"
        description="当前策略修改尚未保存，不会生效。"
        confirmLabel="放弃并切换"
        onConfirm={() => {
          if (switchTarget) {
            setRoleId(switchTarget)
            setDraft(null)
            setTab("fields")
          }
          setSwitchTarget(null)
        }}
      />
    </PageContainer>
  )
}
