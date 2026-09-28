/**
 * 展开图大图查看器(方案 §10.3):
 *   - 默认"适合窗口"(取能放下的最大整数倍率);100% = 1 纹理像素 = 1 CSS 像素
 *   - 滚轮缩放(以指针为锚点)、拖拽平移、居中重置、Esc 关闭并归还焦点
 *   - nearest/pixelated 显示;棋盘格透明背景;大倍率显示像素网格
 *   - 状态区:纹理尺寸、模型、当前倍率、光标像素坐标
 *   - 弹窗锁定打开时的 entryId/skinId,外部悬浮不切换内容
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryEntry } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

const ZOOM_STEPS = [1, 2, 4, 8, 16, 32] as const
const GRID_MIN_ZOOM = 8

export interface TextureViewerDialogProps {
  entry: LibraryEntry
  previewUrl: string
  onClose: () => void
}

export function TextureViewerDialog({ entry, previewUrl, onClose }: TextureViewerDialogProps) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  )

  // Focus return: remember the opener, focus the dialog, restore on close.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null
    return () => {
      openerRef.current?.focus?.()
    }
  }, [])

  const fitToWindow = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const fit = Math.max(
      1,
      Math.floor(Math.min(stage.clientWidth / 64, stage.clientHeight / 64)),
    )
    const step = [...ZOOM_STEPS].reverse().find((z) => z <= fit) ?? 1
    setZoom(step)
    setOffset({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    fitToWindow()
  }, [fitToWindow])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === '0') {
      fitToWindow()
    } else if (e.key === '+' || e.key === '=') {
      zoomIn()
    } else if (e.key === '-') {
      zoomOut()
    }
  }

  const zoomIn = () => {
    const next = ZOOM_STEPS.find((z) => z > zoom)
    if (next) setZoom(next)
  }
  const zoomOut = () => {
    const next = [...ZOOM_STEPS].reverse().find((z) => z < zoom)
    if (next) setZoom(next)
  }

  // Wheel zoom anchored at the pointer position.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const px = e.clientX - rect.left - rect.width / 2 - offset.x
    const py = e.clientY - rect.top - rect.height / 2 - offset.y
    const factor = e.deltaY < 0 ? 2 : 0.5
    const next = Math.min(32, Math.max(1, Math.round(zoom * factor)))
    if (next === zoom) return
    // Keep the pixel under the cursor stationary.
    setOffset((o) => ({
      x: o.x + (px * (zoom - next)) / zoom,
      y: o.y + (py * (zoom - next)) / zoom,
    }))
    setZoom(next)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const stage = stageRef.current
    if (stage) {
      const rect = stage.getBoundingClientRect()
      const cx = (e.clientX - rect.left - rect.width / 2 - offset.x) / zoom
      const cy = (e.clientY - rect.top - rect.height / 2 - offset.y) / zoom
      if (cx >= 0 && cx < 64 && cy >= 0 && cy < 64) setCursor({ x: cx, y: cy })
      else setCursor(null)
    }
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) })
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  const zoomLabel = zoom === 1 ? '100%' : `${zoom * 100}%`

  return (
    <div
      className={styles.textureBackdrop}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-label={`展开图查看:${entry.name}`}
    >
      <div className={styles.textureToolbar}>
        <strong>{entry.name} — 展开图</strong>
        <span className={styles.textureStats}>
          64×64 · {entry.model} · {zoomLabel}
          {cursor && ` · (${cursor.x}, ${cursor.y})`}
        </span>
        <span className={styles.spacer} />
        <button onClick={zoomOut} disabled={zoom <= 1} title="缩小 (-)">
          −
        </button>
        <button onClick={fitToWindow} title="适合窗口 (0)">
          适合窗口
        </button>
        <button onClick={zoomIn} disabled={zoom >= 32} title="放大 (+)">
          ＋
        </button>
        <button onClick={onClose} title="关闭 (Esc)">
          ✕
        </button>
      </div>
      <div
        ref={stageRef}
        className={styles.textureStage}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
      >
        <div
          className={styles.textureCanvas}
          style={{
            width: 64 * zoom,
            height: 64 * zoom,
            transform: `translate(${offset.x}px, ${offset.y}px)`,
          }}
        >
          <img src={previewUrl} alt={`${entry.name} 展开图`} draggable={false} />
          {zoom >= GRID_MIN_ZOOM && (
            <div
              className={styles.textureGrid}
              style={{
                backgroundSize: `${zoom}px ${zoom}px`,
                backgroundPosition: `${offset.x}px ${offset.y}px`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
