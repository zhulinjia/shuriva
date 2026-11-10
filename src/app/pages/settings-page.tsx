import {
  ArrowRight,
  Check,
  Cloud,
  Database,
  Grid2x2,
  RefreshCw,
  Server,
  Users,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import {
  useDatasourceActions,
  useDatasources,
  useResetDemoData,
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
import { Skeleton } from "@/components/ui/skeleton"

const DRAFT_KEY_PREFIX = "shuriva-editor-draft-v1:"

function clearEditorDrafts() {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(DRAFT_KEY_PREFIX)) {
      sessionStorage.removeItem(key)
    }
  }
}

export function SettingsPage() {
  const navigate = useNavigate()
  const edition = useDemoStore((state) => state.edition)
  const setEdition = useDemoStore((state) => state.setEdition)
  const resetUi = useDemoStore((state) => state.resetUi)
  const datasources = useDatasources()
  const workspaces = useWorkspaces()
  const datasourceActions = useDatasourceActions()
  const resetDemoData = useResetDemoData()
  const [resetOpen, setResetOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const sources = datasources.data ?? []
  const targetWorkspace =
    workspaces.data?.find((workspace) => workspace.id === "customer-360") ??
    workspaces.data?.[0]

  const switchSource = (id: string, nextStatus: "connected" | "offline") => {
    setStatus(null)
    datasourceActions.setStatus.mutate(
      { id, status: nextStatus },
      {
        onSuccess: (source) =>
          setStatus(
            source.status === "offline"
              ? `已模拟断开「${source.name}」；其他来源和工作台模块不受影响。`
              : `「${source.name}」的模拟连接已恢复。`
          ),
        onError: () => setStatus("状态切换失败，请重试。"),
      }
    )
  }

  const confirmReset = () => {
    resetDemoData.mutate(undefined, {
      onSuccess: () => {
        clearEditorDrafts()
        resetUi()
        setResetOpen(false)
        setStatus("演示数据已重置为初始状态。")
        navigate("/", { replace: true })
      },
      onError: () => {
        setResetOpen(false)
        setStatus("重置失败，请重试。")
      },
    })
  }

  return (
    <PageContainer
      eyebrow="SETTINGS"
      title="设置与演示"
      description="区分产品部署模式与当前的设计预览。"
    >
      <p role="status" className="sr-only">
        {status}
      </p>
      {status ? (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-success-border bg-success-soft px-3 py-2 text-label text-success">
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

      <div className="grid items-start gap-3 min-[981px]:grid-cols-2">
        <section
          className="rounded-lg border border-border bg-card p-4"
          aria-labelledby="edition-heading"
        >
          <div className="mb-3">
            <h2
              id="edition-heading"
              className="text-card-title font-medium text-foreground"
            >
              产品模式
            </h2>
            <p className="mt-0.5 text-caption text-muted-foreground">
              切换原型中的导航与可用设计界面
            </p>
          </div>

          <div className="grid gap-2">
            <EditionOption
              selected={edition === "community"}
              icon={Server}
              title="Community 开源版"
              badge="当前开发重点"
              badgeTone="success"
              description="单用户 · 自部署后端直连 · 多数据库、多数据源"
              onClick={() => {
                setEdition("community")
                setStatus("已回到单用户开源版原型。")
              }}
            />
            <EditionOption
              selected={edition === "team"}
              icon={Users}
              title="团队版设计预览"
              badge="未接入"
              description="预览成员、字段与记录权限；云端连接方案待定"
              onClick={() => {
                setEdition("team")
                setStatus(
                  "已进入团队版设计预览，云端连接方案仍待定。"
                )
              }}
            />
          </div>

          <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
            Community 不显示团队权限导航；切到团队版后，「成员与数据权限」入口才会出现。
          </p>
        </section>

        <section
          className="rounded-lg border border-border bg-card p-4"
          aria-labelledby="architecture-heading"
        >
          <h2
            id="architecture-heading"
            className="text-card-title font-medium text-foreground"
          >
            开源版的访问路径
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-label">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1.5">
              <Grid2x2 className="size-4" aria-hidden="true" />
              浏览器
            </span>
            <ArrowRight
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2 py-1.5 font-medium text-primary">
              <Server className="size-4" aria-hidden="true" />
              你的 Shuriva 后端
            </span>
            <ArrowRight
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1.5">
              <Database className="size-4" aria-hidden="true" />
              多个数据库
            </span>
          </div>
          <p className="mt-2.5 text-label leading-relaxed text-muted-foreground">
            正式产品由同一后端保存连接与工作台。其他设备访问这套服务即可使用，数据库不与浏览器直接通信。
          </p>
          <div className="mt-3">
            <Notice>
              本轮是纯前端 Mock。配置只保存在当前浏览器，没有跨设备同步，也不验证数据库网络连通性。
            </Notice>
          </div>
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-caption leading-relaxed text-muted-foreground">
            <Cloud className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            团队版的数据连接方案（云端托管、独立连接节点或其他形式）尚未确定，此处不做预设。
          </div>
        </section>

        <section
          className="rounded-lg border border-border bg-card p-4"
          aria-labelledby="failure-heading"
        >
          <h2
            id="failure-heading"
            className="text-card-title font-medium text-foreground"
          >
            局部失败演示
          </h2>
          <p className="mt-0.5 text-caption text-muted-foreground">
            只断开一个来源，检查多源工作台的其他模块是否仍可用。
          </p>

          {datasources.isPending ? (
            <div className="mt-3 grid gap-1.5" aria-busy="true">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-11 w-full" />
              ))}
            </div>
          ) : datasources.isError ? (
            <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-label text-destructive">
              数据源加载失败。{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void datasources.refetch()}
              >
                重试
              </button>
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="flex items-center gap-2 px-2.5 py-2"
                >
                  <EngineMark engine={source.engine} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-label text-foreground">
                    {source.name}
                  </span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      source.status === "connected" ? "bg-success" : "bg-destructive"
                    )}
                    aria-hidden="true"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    disabled={datasourceActions.setStatus.isPending}
                    onClick={() =>
                      switchSource(
                        source.id,
                        source.status === "connected" ? "offline" : "connected"
                      )
                    }
                  >
                    {source.status === "connected" ? "模拟断开" : "恢复连接"}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2.5">
            {targetWorkspace ? (
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to={`/workspaces/${targetWorkspace.id}`} />}
              >
                打开{targetWorkspace.title}
                <ArrowRight aria-hidden="true" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to="/workspaces" />}
              >
                打开工作台目录
                <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </section>

        <section
          className="rounded-lg border border-border bg-card p-4"
          aria-labelledby="data-heading"
        >
          <h2
            id="data-heading"
            className="text-card-title font-medium text-foreground"
          >
            本地演示数据
          </h2>
          <p className="mt-0.5 text-caption text-muted-foreground">
            工作台、数据源配置与权限策略保存在当前浏览器，不写入真实数据库。
          </p>

          <ul className="mt-3 grid gap-1.5 text-label text-foreground">
            {[
              "没有真实数据库或 AI 请求",
              "连接密码不写入本地存储",
              "权限仅供交互验证，不是生产鉴权",
            ].map((item) => (
              <li key={item} className="flex items-start gap-1.5">
                <Check
                  className="mt-0.5 size-3.5 shrink-0 text-success"
                  aria-hidden="true"
                />
                {item}
              </li>
            ))}
          </ul>

          <div className="mt-3">
            <Button
              type="button"
              variant="destructive"
              onClick={() => setResetOpen(true)}
              disabled={resetDemoData.isPending}
            >
              <RefreshCw
                className={resetDemoData.isPending ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              重置演示数据
            </Button>
          </div>
          <p className="mt-2 text-caption leading-relaxed text-muted-foreground">
            会清除在当前浏览器创建的工作台、数据源和策略，不影响真实数据库。
          </p>
        </section>
      </div>

      <div className="mt-3">
        <Notice tone="warning">
          本页面的「连接成功」「权限预览」均为设计演示，不代表已经建立真实数据库连接或完成服务端鉴权。
        </Notice>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!resetDemoData.isPending) setResetOpen(open)
        }}
        title="重置这版演示数据？"
        description="会清除当前浏览器创建的工作台、数据源和权限策略，并恢复初始示例。不会影响任何真实数据库。"
        confirmLabel="确认重置"
        pending={resetDemoData.isPending}
        onConfirm={confirmReset}
      />
    </PageContainer>
  )
}

function EditionOption({
  selected,
  icon: Icon,
  title,
  badge,
  badgeTone,
  description,
  onClick,
}: {
  selected: boolean
  icon: typeof Server
  title: string
  badge?: string
  badgeTone?: "success"
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected
          ? "border-primary/30 bg-primary/10"
          : "border-border bg-card hover:bg-accent"
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg",
          selected
            ? "bg-primary/10 text-primary"
            : "bg-muted/50 text-muted-foreground"
        )}
      >
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <strong className="text-label font-medium text-foreground">
            {title}
          </strong>
          {badge ? (
            <Badge
              variant="outline"
              className={cn(
                "h-5 px-1.5 font-normal",
                badgeTone === "success"
                  ? "border-success-border bg-success-soft text-success"
                  : "border-border bg-muted/50 text-muted-foreground"
              )}
            >
              {badge}
            </Badge>
          ) : null}
        </span>
        <small className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
          {description}
        </small>
      </span>
      {selected ? (
        <Check className="size-5 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
    </button>
  )
}
