import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react"
import type { ChatModelAdapter, ThreadMessageLike } from "@assistant-ui/react"
import { Loader2, Lock, Send, Sparkles, Square, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Datasource, Workspace } from "@/services"
import { applyMockDraftEdit } from "@/services/mock/assistant"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text"

const QUICK_PROMPTS = [
  "隐藏手机号列",
  "显示成本列",
  "增加使用趋势图表",
  "日期范围改为最近 7 天",
] as const

const INITIAL_MESSAGES: readonly ThreadMessageLike[] = [
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "工作台结构已生成。现在可以告诉我需要调整什么，例如隐藏字段、启用成本、增加趋势模块或修改默认日期范围。\n\n我只调整工作台结构，不会生成、查询或展示业务数据。",
      },
    ],
  },
]

type DraftChatProps = {
  draft: Workspace
  datasources: readonly Datasource[]
  onDraftChange: (draft: Workspace) => void
  onOpenBindings: () => void
  title?: string
  initialMessages?: readonly ThreadMessageLike[]
  quickPrompts?: readonly string[]
  contextNote?: string
  composerPlaceholder?: string
  onClose?: () => void
  readOnly?: boolean
  readOnlyMessage?: string
  onRunningChange?: (running: boolean) => void
}

export function DraftChat({
  draft,
  datasources,
  onDraftChange,
  onOpenBindings,
  title = "AI 工作台助手",
  initialMessages = INITIAL_MESSAGES,
  quickPrompts = QUICK_PROMPTS,
  contextNote,
  composerPlaceholder = "描述要调整的工作台结构…",
  onClose,
  readOnly = false,
  readOnlyMessage = "当前为只读演示角色，切回数据管理员后可修改工作台。",
  onRunningChange,
}: DraftChatProps) {
  const draftRef = useRef(draft)
  const datasourcesRef = useRef(datasources)
  const onDraftChangeRef = useRef(onDraftChange)

  useEffect(() => {
    draftRef.current = draft
    datasourcesRef.current = datasources
    onDraftChangeRef.current = onDraftChange
  }, [draft, datasources, onDraftChange])

  const [adapter] = useState<ChatModelAdapter>(() => ({
    async run({ messages, abortSignal }) {
      const last = messages.at(-1)
      const text =
        last?.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text"
          )
          .map((part) => part.text)
          .join("\n") ?? ""

      await new Promise<void>((resolve, reject) => {
        if (abortSignal.aborted) {
          reject(new DOMException("Aborted", "AbortError"))
          return
        }

        const timer = window.setTimeout(resolve, 520)
        abortSignal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timer)
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true }
        )
      })

      const result = applyMockDraftEdit(
        text,
        draftRef.current,
        datasourcesRef.current
      )

      if (result.draft) onDraftChangeRef.current(result.draft)

      return { content: [{ type: "text", text: result.reply }] }
    },
  }))

  const runtime = useLocalRuntime(adapter, { initialMessages })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <RunningReporter onRunningChange={onRunningChange} />
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Sparkles className="size-3.5" aria-hidden="true" />
            </span>
            <strong className="truncate text-label font-medium text-foreground">
              {title}
            </strong>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onOpenBindings}
            >
              数据与模块
            </Button>
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="关闭 AI 修改面板"
                onClick={onClose}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </header>

        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 px-3 py-3">
            <ThreadPrimitive.Messages>
              {() => <DraftMessage />}
            </ThreadPrimitive.Messages>

            <RunningIndicator />
          </div>
        </ThreadPrimitive.Viewport>

        <div className="border-t border-border px-3 pt-2.5 pb-3">
          {readOnly ? (
            <p className="rounded-md bg-muted px-3 py-2 text-label text-muted-foreground">{readOnlyMessage}</p>
          ) : (
            <><QuickPrompts prompts={quickPrompts} /><Composer placeholder={composerPlaceholder} /></>
          )}
          <p className="workspace-ai-note mt-2 flex items-start gap-1.5 text-caption leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {contextNote ??
              "本地 Mock 对话：只调整结构，不执行 SQL，也不代表真实权限验证。"}
          </p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

function RunningReporter({ onRunningChange }: { onRunningChange?: (running: boolean) => void }) {
  const running = useAuiState((state) => state.thread.isRunning)
  useEffect(() => { onRunningChange?.(running) }, [running, onRunningChange])
  return null
}

function DraftMessage() {
  const role = useAuiState((state) => state.message.role)

  if (role === "user") {
    return (
      <MessagePrimitive.Root className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-label text-foreground">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => (
              <p className="whitespace-pre-wrap break-words">{text}</p>
            ),
          }}
        />
      </MessagePrimitive.Root>
    )
  }

  return (
    <MessagePrimitive.Root className="flex items-start gap-2">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
        <Sparkles className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 text-label leading-relaxed text-foreground [&_.aui-md]:text-label [&_.aui-md_li]:my-0.5 [&_.aui-md_li]:leading-relaxed [&_.aui-md_ol]:my-2 [&_.aui-md_ol]:ms-4 [&_.aui-md_p]:my-2 [&_.aui-md_ul]:my-2 [&_.aui-md_ul]:ms-4">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  )
}

function RunningIndicator() {
  const isRunning = useAuiState((state) => state.thread.isRunning)

  if (!isRunning) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-1 text-caption text-muted-foreground"
    >
      <Loader2
        className="size-3.5 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      正在调整工作台结构…
    </div>
  )
}

function QuickPrompts({ prompts }: { prompts: readonly string[] }) {
  const isRunning = useAuiState((state) => state.thread.isRunning)

  return (
    <div
      className="workspace-ai-prompts mb-2 flex flex-wrap gap-1.5"
      aria-label="快捷修改建议"
    >
      {prompts.map((prompt) => (
        <ThreadPrimitive.Suggestion
          key={prompt}
          prompt={prompt}
          send
          disabled={isRunning}
          className={cn(
            "rounded-md border border-border bg-card px-2 py-1 text-caption text-muted-foreground transition-colors",
            "hover:border-primary/20 hover:bg-accent hover:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          {prompt}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  )
}

function Composer({ placeholder }: { placeholder: string }) {
  const isRunning = useAuiState((state) => state.thread.isRunning)

  return (
    <ComposerPrimitive.Root className="flex items-end gap-2 rounded-lg border border-input bg-card px-2 py-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
      <ComposerPrimitive.Input
        rows={2}
        placeholder={placeholder}
        aria-label="描述工作台修改需求"
        enterKeyHint="send"
        className="max-h-32 min-h-12 w-full resize-none bg-transparent px-1 py-1 text-label leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      {isRunning ? (
        <ComposerPrimitive.Cancel
          render={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="shrink-0"
              aria-label="停止生成"
            />
          }
        >
          <Square className="size-3.5 fill-current" aria-hidden="true" />
        </ComposerPrimitive.Cancel>
      ) : (
        <ComposerPrimitive.Send
          render={
            <Button
              type="button"
              size="icon-sm"
              className="shrink-0"
              aria-label="发送"
            />
          }
        >
          <Send className="size-3.5" aria-hidden="true" />
        </ComposerPrimitive.Send>
      )}
    </ComposerPrimitive.Root>
  )
}
