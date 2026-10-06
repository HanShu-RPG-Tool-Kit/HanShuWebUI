import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { FlowSplitDirection } from './storage'

/** 主区二分：分割线只占 1px，两侧各有 3px 拖拽热区。 */
export function EditorSplit({ direction, ratio, disabled, primary, secondary, onRatio }: {
  direction: FlowSplitDirection
  ratio: number
  disabled?: boolean
  primary: ReactNode
  secondary: ReactNode
  onRatio: (ratio: number) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; ratio: number } | null>(null)
  const [live, setLive] = useState<number | null>(null)
  const horizontal = direction === 'horizontal'
  const shown = live ?? ratio

  useEffect(() => {
    if (!disabled) return
    drag.current = null
    setLive(null)
  }, [disabled])

  function ratioAt(event: PointerEvent) {
    const rect = root.current!.getBoundingClientRect()
    const value = horizontal ? (event.clientX - rect.left) / Math.max(1, rect.width) : (event.clientY - rect.top) / Math.max(1, rect.height)
    return Math.min(0.8, Math.max(0.2, value))
  }

  function finish(commit: boolean) {
    const current = drag.current
    drag.current = null
    setLive(null)
    if (commit && current) onRatio(current.ratio)
  }

  return <div ref={root} className={`flow-split is-${direction}${live !== null ? ' is-resizing' : ''}`}>
    <div className="flow-split-pane" style={{ flexGrow: shown }}>{primary}</div>
    <div
      className="flow-split-sash"
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(shown * 100)}
      aria-label={horizontal ? '调整左右分割' : '调整上下分割'}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointer: event.pointerId, ratio }
        setLive(ratio)
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return
        drag.current.ratio = ratioAt(event)
        setLive(drag.current.ratio)
      }}
      onPointerUp={(event) => { if (drag.current?.pointer === event.pointerId) finish(true) }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => { if (drag.current) finish(true) }}
      onDoubleClick={() => { if (!disabled) onRatio(0.5) }}
    />
    <div className="flow-split-pane" style={{ flexGrow: 1 - shown }}>{secondary}</div>
  </div>
}
