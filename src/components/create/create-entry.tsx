import {
  ArrowRight,
  ChartColumn,
  Database,
  LayoutGrid,
  Lock,
  Sparkles,
  Table2,
  TriangleAlert,
  Users,
} from "lucide-react"
import type { ReactNode, RefObject } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { EngineMark } from "@/components/datasources/engine-mark"
import type { EngineMarkEngine } from "@/components/datasources/engine-mark"

export type CreateFeedback = {
  message: string
  action: "prompt" | "sources" | "add" | null
}

type ExampleScenario = {
  title: string
  description: string
  prompt: string
  icon: typeof Table2
}

const EXAMPLES: readonly ExampleScenario[] = [
  {
    title: "订单管理",
    description: "订单查询、异常排查、销售统计",
    prompt:
      "创建一个订单管理工作台，支持订单搜索、异常订单筛选和销售金额统计。",
    icon: Table2,
  },
  {
    title: "客户管理",
    description: "客户资料、消费记录、客户分析",
    prompt:
      "创建一个客户管理工作台，可以搜索客户、查看客户资料和消费记录。",
    icon: Users,
  },
  {
    title: "订阅分析",
    description: "订阅状态、到期提醒、续费分析",
    prompt:
      "创建一个订阅分析工作台，查看会员订阅状态、到期时间和续费情况。",
    icon: ChartColumn,
  },
]

type CreateEntrySource = { id: string; engine: EngineMarkEngine }

type CreateEntryProps = {
  prompt: string
  onPromptChange: (value: string) => void
  promptRef: RefObject<HTMLTextAreaElement | null>
  selectedSources: readonly CreateEntrySource[]
  allSources: readonly CreateEntrySource[]
  feedback: CreateFeedback | null
  onOpenSources: () => void
  onAddSource: () => void
  onSubmit: () => void
  onExample: (prompt: string) => void
  contextNote?: string
  generating?: boolean
  modelControl?: ReactNode
}

export function CreateEntry({
  prompt,
  onPromptChange,
  promptRef,
  selectedSources,
  allSources,
  feedback,
  onOpenSources,
  onAddSource,
  onSubmit,
  onExample,
  contextNote = "当前为前端 Mock：AI 生成、查询和权限判断均为本地模拟，不连接真实数据库。",
  generating = false,
  modelControl,
}: CreateEntryProps) {
  const engines = [...new Set(selectedSources.map((source) => source.engine))]
  const descriptionId =
    feedback?.action === "prompt" ? "create-prompt-feedback" : undefined

  return (
    <div className="mx-auto w-full max-w-(--spacing-page) px-6 pt-6 pb-10 max-[980px]:px-5 max-[700px]:px-4">
      <section className="grid grid-cols-[minmax(0,1fr)] items-center gap-6 border-b border-border pb-8 min-[981px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <p className="text-caption font-medium tracking-[0.12em] text-muted-foreground uppercase">
            AI BUSINESS WORKSPACE
          </p>
          <h1 className="mt-2 max-w-2xl text-display font-semibold text-foreground">
            让数据变成
            <br />
            <span className="text-muted-foreground">
              你真正需要的工作台。
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-body leading-relaxed text-muted-foreground">
            告诉 Shuriva 你想完成什么业务任务。连接现有数据，AI
            帮你生成可以直接使用和继续调整的工作台。
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 shadow-raised">
          <p className="text-label font-medium text-foreground">
            从数据到业务工具
          </p>
          <div className="mt-3 flex items-center gap-2">
            <FlowNode icon={Database} title="数据源" caption="Database" />
            <ArrowRight
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <FlowNode icon={Sparkles} title="AI 理解" caption="Structure" />
            <ArrowRight
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <FlowNode icon={LayoutGrid} title="工作台" caption="Workspace" />
          </div>
          <p className="mt-3 border-t border-border pt-2.5 text-caption leading-relaxed text-muted-foreground">
            生成的是工作台结构。真实数据只在查询执行后出现，不会预先编造。
          </p>
        </div>
      </section>

      <section
        className="mt-6 rounded-xl border border-border bg-card p-4 shadow-raised focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 sm:p-5"
        aria-labelledby="create-prompt-label"
      >
        <label
          id="create-prompt-label"
          htmlFor="create-prompt"
          className="text-label font-medium text-foreground"
        >
          描述你想完成的业务任务
        </label>
        <textarea
          id="create-prompt"
          ref={promptRef}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === "Enter"
            ) {
              event.preventDefault()
              onSubmit()
            }
          }}
          rows={4}
          placeholder="例如：创建一个订单管理工作台，可以查询订单、筛选异常订单，并统计每日销售金额……"
          aria-invalid={feedback?.action === "prompt"}
          aria-describedby={descriptionId}
          className="mt-2 min-h-28 w-full resize-y rounded-lg border border-transparent bg-transparent px-0 py-1 text-body leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />

        {modelControl && <div className="mb-4 max-w-full sm:max-w-md">{modelControl}</div>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-w-full bg-card"
            onClick={onOpenSources}
            disabled={generating}
          >
            <Database aria-hidden="true" />
            <span className="truncate">
              {selectedSources.length > 0
                ? `已选择 ${selectedSources.length} 个数据源`
                : allSources.length > 0
                  ? "选择数据源"
                  : "添加数据源"}
            </span>
            {engines.length > 0 ? (
              <span className="ml-1 flex items-center gap-0.5">
                {engines.map((engine) => (
                  <EngineMark key={engine} engine={engine} size="sm" />
                ))}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {selectedSources.length > 0 ? "· 管理" : ""}
            </span>
          </Button>

          <Button type="button" onClick={onSubmit} disabled={generating}>
            {generating ? "正在生成工作台…" : "开始构建工作台"}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>

        {feedback ? (
          <div
            id="create-prompt-feedback"
            role="status"
            aria-live="polite"
            className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-label text-warning"
          >
            <TriangleAlert
              className="size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 leading-relaxed">
              {feedback.message}
            </span>
            {feedback.action === "sources" ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="bg-card"
                onClick={onOpenSources}
              >
                选择数据源
              </Button>
            ) : null}
            {feedback.action === "add" ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="bg-card"
                onClick={onAddSource}
              >
                添加数据源
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-2.5 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          {contextNote}
        </p>
      </section>

      <section className="mt-8" aria-labelledby="create-examples-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2
              id="create-examples-heading"
              className="text-section-title font-semibold text-foreground"
            >
              从一个业务场景开始
            </h2>
            <p className="mt-1 text-caption text-muted-foreground">
              选择示例，自动填入需求后再按需调整
            </p>
          </div>
          <span className="text-caption text-muted-foreground">
            示例不会替你执行查询
          </span>
        </div>

        <div className="mt-3 grid gap-3 min-[700px]:grid-cols-3">
          {EXAMPLES.map((example) => {
            const Icon = example.icon

            return (
              <button
                key={example.title}
                type="button"
                onClick={() => onExample(example.prompt)}
                className={cn(
                  "rounded-lg border border-border bg-card p-4 text-left transition-colors",
                  "hover:border-primary/20 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                )}
              >
                <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <strong className="mt-3 block text-card-title font-medium text-foreground">
                  {example.title}
                </strong>
                <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
                  {example.description}
                </p>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function FlowNode({
  icon: Icon,
  title,
  caption,
}: {
  icon: typeof Database
  title: string
  caption: string
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border bg-muted/30 p-2.5">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <strong className="mt-1.5 block truncate text-label font-medium text-foreground">
        {title}
      </strong>
      <small className="block truncate text-caption text-muted-foreground">
        {caption}
      </small>
    </div>
  )
}
