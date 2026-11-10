import { Check, Loader2, Sparkles, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const STEPS = [
  { title: "理解业务需求", description: "提取业务目标与需要查看的关键信息" },
  {
    title: "分析数据源与字段结构",
    description: "核对所选数据源，确认每个模块的查询来源",
  },
  {
    title: "生成工作台组件与布局",
    description: "编排指标、筛选、数据列表与模块绑定",
  },
] as const

const STEP_DELAYS = [500, 550, 600] as const
const COMPLETE_DELAY = 560

type GenerationProgressProps = {
  prompt: string
  sourceCount: number
  onComplete: () => void
  onCancel: () => void
}

export function GenerationProgress({
  prompt,
  sourceCount,
  onComplete,
  onCancel,
}: GenerationProgressProps) {
  const [completed, setCompleted] = useState(0)
  const completeRef = useRef(onComplete)

  useEffect(() => {
    completeRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const timers: number[] = []
    let elapsed = 0

    STEP_DELAYS.forEach((delay, index) => {
      elapsed += delay
      timers.push(
        window.setTimeout(() => {
          setCompleted(index + 1)
        }, elapsed)
      )
    })

    timers.push(
      window.setTimeout(() => {
        completeRef.current()
      }, elapsed + COMPLETE_DELAY)
    )

    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [])

  const activeStep = Math.min(completed, STEPS.length - 1)

  return (
    <div className="mx-auto flex w-full max-w-(--spacing-page) flex-col items-center px-6 pt-12 pb-16 max-[700px]:px-4">
      <section
        className="w-full max-w-xl rounded-xl border border-border bg-card p-6 shadow-raised sm:p-8"
        aria-busy="true"
        aria-live="polite"
      >
        <div className="flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="size-5" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-page-title font-semibold text-foreground">
            正在为你创建工作台
          </h1>
          <p className="mt-1.5 max-w-md text-body leading-relaxed text-muted-foreground">
            正在理解需求、分析数据结构并规划工作台。当前为本地模拟生成，不会访问真实数据库。
          </p>
        </div>

        <div className="mt-6 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <p className="text-caption font-medium tracking-[0.08em] text-muted-foreground uppercase">
            本次需求
          </p>
          <p className="mt-1 line-clamp-2 text-label leading-relaxed text-foreground">
            {prompt}
          </p>
          <p className="mt-1 text-caption text-muted-foreground">
            已选择 {sourceCount} 个数据源
          </p>
        </div>

        <ol className="mt-5 grid gap-2" aria-label="生成进度">
          {STEPS.map((step, index) => {
            const done = index < completed
            const active = index === activeStep && !done && completed < STEPS.length
            const pending = !done && !active

            return (
              <li
                key={step.title}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                  done
                    ? "border-success-border bg-success-soft"
                    : active
                      ? "border-primary/20 bg-primary/5"
                      : "border-border bg-card"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
                    done
                      ? "border-success-border bg-card text-success"
                      : active
                        ? "border-primary/30 bg-card text-primary"
                        : "border-border text-muted-foreground"
                  )}
                >
                  {done ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : active ? (
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0">
                  <strong
                    className={cn(
                      "block text-label font-medium",
                      pending ? "text-muted-foreground" : "text-foreground"
                    )}
                  >
                    {step.title}
                  </strong>
                  <small className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
                    {step.description}
                  </small>
                </span>
                <span className="sr-only">
                  {done ? "已完成" : active ? "进行中" : "等待中"}
                </span>
              </li>
            )
          })}
        </ol>

        <div className="mt-5 flex items-center justify-between gap-2">
          <span className="text-caption text-muted-foreground">
            {completed >= STEPS.length
              ? "正在完成结构校验…"
              : `步骤 ${activeStep + 1} / ${STEPS.length}`}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X aria-hidden="true" />
            取消生成
          </Button>
        </div>
      </section>
    </div>
  )
}
