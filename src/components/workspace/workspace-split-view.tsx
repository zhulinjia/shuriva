import { useEffect, useRef, useState } from "react"
import type { CSSProperties, PointerEvent, ReactNode } from "react"
import { AppFooter } from "@/components/layout/app-footer"

const WIDTH_KEY = "shuriva-ai-sidebar-width"
const MIN_WIDTH = 300
const MAX_WIDTH = 560
const MIN_CANVAS_WIDTH = 360

function initialWidth() {
  try {
    const saved = Number(globalThis.localStorage?.getItem(WIDTH_KEY))
    if (saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved
  } catch { /* The panel remains usable without browser storage. */ }
  return 400
}

/** Shared full-height workspace and AI panel; width is a device preference. */
export function WorkspaceSplitView({ children, sidebar, footer = <AppFooter /> }: { children: ReactNode; sidebar: ReactNode; footer?: ReactNode }) {
  const [preferredWidth, setPreferredWidth] = useState(initialWidth)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [availableHeight, setAvailableHeight] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const frameRef = useRef(0)
  const latestWidthRef = useRef(preferredWidth)
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, containerWidth - MIN_CANVAS_WIDTH))
  const width = Math.min(maxWidth, Math.max(MIN_WIDTH, preferredWidth))

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const updateHeight = () => setAvailableHeight(Math.max(280, window.innerHeight - Math.max(0, element.getBoundingClientRect().top)))
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width)
      updateHeight()
    })
    observer.observe(element)
    window.addEventListener("resize", updateHeight)
    updateHeight()
    return () => { observer.disconnect(); window.removeEventListener("resize", updateHeight); cancelAnimationFrame(frameRef.current) }
  }, [])

  const changeWidth = (value: number) => {
    const next = Math.min(maxWidth, Math.max(MIN_WIDTH, value))
    latestWidthRef.current = next
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => setPreferredWidth(next))
  }
  const rememberWidth = () => {
    try { globalThis.localStorage?.setItem(WIDTH_KEY, String(latestWidthRef.current)) } catch { /* preference only */ }
  }
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, width }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) changeWidth(dragRef.current.width - (event.clientX - dragRef.current.x))
  }
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    rememberWidth()
  }

  return (
    <div ref={containerRef} className="workspace-split" style={{ "--ai-panel-width": `${width}px`, ...(availableHeight ? { height: `${availableHeight}px` } : {}) } as CSSProperties}>
      <div className="workspace-split-canvas">
        {children}
        {footer}
      </div>
      <div role="separator" aria-label="调整 AI 侧栏宽度" aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0}
        className="workspace-split-separator" onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          changeWidth(width + (event.key === "ArrowLeft" ? 16 : -16))
          rememberWidth()
        }}><span /></div>
      <aside id="workspace-ai-panel" aria-label="AI 工作台助手" className="workspace-split-sidebar">{sidebar}</aside>
    </div>
  )
}
