import { Database, Loader2, Send, Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export type AiMessage = { role: "user" | "assistant"; text: string }

export function LiveAiSidebar({
    messages,
    instruction,
    sourceCount,
    pending,
    disabled,
    error,
    modelControl,
    onInstructionChange,
    onChooseSources,
    onSubmit,
}: {
    messages: readonly AiMessage[]
    instruction: string
    sourceCount: number
    pending: boolean
    disabled: boolean
    error: string | null
    modelControl?: ReactNode
    onInstructionChange: (value: string) => void
    onChooseSources: () => void
    onSubmit: () => void
}) {
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                        <Sparkles className="size-3.5" aria-hidden="true" />
                    </span>
                    <strong className="truncate text-label font-medium">AI 工作台助手</strong>
                </div>
                <Button type="button" variant="ghost" size="xs" onClick={onChooseSources} disabled={pending || disabled}>
                    <Database aria-hidden="true" />
                    数据源{sourceCount ? ` · ${sourceCount}` : ""}
                </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
                <div className="flex flex-col gap-3">
                    {messages.map((message, index) => (
                        <div
                            key={index}
                            className={
                                message.role === "user"
                                    ? "ml-8 rounded-lg bg-primary/10 px-3 py-2.5 text-label leading-relaxed"
                                    : "mr-5 rounded-lg bg-muted/50 px-3 py-2.5 text-label leading-relaxed"
                            }
                        >
                            {message.text}
                        </div>
                    ))}
                    {pending && (
                        <p className="flex items-center gap-2 text-caption text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            正在生成修改…
                        </p>
                    )}
                    {error && (
                        <p
                            role="alert"
                            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-label text-destructive"
                        >
                            {error}
                        </p>
                    )}
                </div>
            </div>
            <form
                className="grid gap-2 border-t border-border px-3 pt-2.5 pb-3"
                onSubmit={(event) => {
                    event.preventDefault()
                    onSubmit()
                }}
            >
                {modelControl}
                <Textarea
                    aria-label="描述工作台需求"
                    value={instruction}
                    onChange={(event) => onInstructionChange(event.target.value)}
                    placeholder="描述要修改的工作台结构…"
                    rows={3}
                    disabled={disabled || pending}
                />
                <div className="flex items-center justify-between gap-2">
                    <p className="text-caption text-muted-foreground">修改先预览，保存后生效。</p>
                    <Button type="submit" size="sm" disabled={!instruction.trim() || !sourceCount || pending || disabled}>
                        <Send aria-hidden="true" />
                        生成修改
                    </Button>
                </div>
                <p className="text-caption leading-relaxed text-muted-foreground">
                    会发送你的需求、数据源结构和当前工作台配置；已有筛选值会先遮蔽，当前不发送记录样本。
                </p>
            </form>
        </div>
    )
}
