import { Notice } from "@/components/common/notice"
import type { AiConnectionResult } from "@/shared/ai-settings"

export function AiTestFeedback({
    id,
    anchorId,
    pending = false,
    result,
    error,
}: {
    id?: string
    anchorId?: string
    pending?: boolean
    result?: AiConnectionResult
    error?: string
}) {
    const feedbackRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!anchorId || (!pending && !result && !error)) return
        const anchor = document.getElementById(anchorId)
        if (!anchor) return
        const rect = anchor.getBoundingClientRect()
        // Keep feedback beside the visible action; do not pull users back after they scroll away.
        if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
            feedbackRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" })
        }
    }, [anchorId, pending, result, error])
    if (!pending && !result && !error) return null
    const elapsed = result ? (result.elapsedMs >= 1000 ? `${(result.elapsedMs / 1000).toFixed(1)} 秒` : `${result.elapsedMs} 毫秒`) : ""
    return (
        <div ref={feedbackRef} id={id} role={error ? "alert" : "status"} aria-atomic="true">
            <Notice tone={error ? "danger" : pending ? "info" : "success"} icon={error ? "warning" : pending ? "server" : "check"}>
                <strong className="block text-sm font-medium">{error ? "连接测试失败" : pending ? "正在测试连接…" : "连接成功"}</strong>
                <p className="mt-0.5 break-words text-xs leading-5">
                    {error ?? (pending ? "正在等待模型响应，最多等待 15 秒。" : `${result?.model} 已响应 · 耗时 ${elapsed}`)}
                </p>
            </Notice>
        </div>
    )
}
import { useEffect, useRef } from "react"
