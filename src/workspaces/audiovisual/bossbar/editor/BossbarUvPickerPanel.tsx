import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { BossbarDocument, BossbarUv } from '../protocol'
import { useBlockBrowserMouseGestures } from '../../../../ui/blockBrowserMouseGestures'
import { Button } from './BossbarEditorUi'
import { paintAt, textureSrc, type BossbarUvTarget } from './BossbarAtlasPanel'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 64
const RULER = 22
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type UvHandle = (typeof HANDLES)[number] | 'move'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return clamp(value, ZOOM_MIN, ZOOM_MAX)
}

function clampUv(uv: BossbarUv, texture: { width: number; height: number }): BossbarUv {
  const width = Math.max(1, Math.min(texture.width, Math.round(uv.width)))
  const height = Math.max(1, Math.min(texture.height, Math.round(uv.height)))
  const x = clamp(Math.round(uv.x), 0, Math.max(0, texture.width - width))
  const y = clamp(Math.round(uv.y), 0, Math.max(0, texture.height - height))
  return { x, y, width, height }
}

function uvEqual(a: BossbarUv, b: BossbarUv): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function uvFromDocument(
  document: BossbarDocument,
  target: BossbarUvTarget,
  texture: { width: number; height: number },
): BossbarUv {
  const paint = paintAt(document, target)
  const raw = paint && paint.kind === 'texture'
    ? target.frameIndex === undefined
      ? paint.uv
      : paint.animation?.frames[target.frameIndex]?.uv ?? null
    : null
  return clampUv(raw ?? { x: 0, y: 0, width: 1, height: 1 }, texture)
}

function slotLabel(slot: BossbarUvTarget['slot']): string {
  if (slot === 'paint') return '背景纹理'
  if (slot === 'fill') return '填充'
  return '尾条'
}

function resizeUv(
  origin: BossbarUv,
  handle: UvHandle,
  point: { x: number; y: number },
  texture: { width: number; height: number },
): BossbarUv {
  let x1 = origin.x
  let y1 = origin.y
  let x2 = origin.x + origin.width
  let y2 = origin.y + origin.height
  const px = clamp(Math.floor(point.x), 0, texture.width - 1)
  const py = clamp(Math.floor(point.y), 0, texture.height - 1)
  if (handle === 'nw' || handle === 'w' || handle === 'sw') x1 = px
  if (handle === 'ne' || handle === 'e' || handle === 'se') x2 = px + 1
  if (handle === 'nw' || handle === 'n' || handle === 'ne') y1 = py
  if (handle === 'sw' || handle === 's' || handle === 'se') y2 = py + 1
  if (x2 <= x1) {
    const mid = x1
    x1 = Math.max(0, x2 - 1)
    x2 = mid + (x2 === mid ? 1 : 0)
    if (x2 <= x1) x2 = x1 + 1
  }
  if (y2 <= y1) {
    const mid = y1
    y1 = Math.max(0, y2 - 1)
    y2 = mid + (y2 === mid ? 1 : 0)
    if (y2 <= y1) y2 = y1 + 1
  }
  return clampUv({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, texture)
}

function rulerStep(zoom: number): number {
  if (zoom >= 12) return 1
  if (zoom >= 6) return 2
  if (zoom >= 3) return 5
  if (zoom >= 1) return 10
  return 20
}

function boxStyle(uv: BossbarUv, zoom: number) {
  return {
    left: uv.x * zoom,
    top: uv.y * zoom,
    width: Math.max(1, uv.width * zoom),
    height: Math.max(1, uv.height * zoom),
  }
}

export function BossbarUvPickerPanel({
  document,
  textureSize,
  target,
  readOnly,
  onPreview,
  onClose,
}: {
  document: BossbarDocument
  textureSize: { width: number; height: number }
  target: BossbarUvTarget
  readOnly: boolean
  onPreview: (uv: BossbarUv) => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const worldRef = useRef<HTMLDivElement | null>(null)
  useBlockBrowserMouseGestures(stageRef)
  const windowDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const originalRef = useRef<BossbarUv>({ x: 0, y: 0, width: 1, height: 1 })
  const draftRef = useRef<BossbarUv>({ x: 0, y: 0, width: 1, height: 1 })
  const historyRef = useRef<BossbarUv[]>([])
  const indexRef = useRef(0)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const onPreviewRef = useRef(onPreview)
  const onCloseRef = useRef(onClose)
  const dragRef = useRef<
    | { mode: 'pan'; pointerId: number; lastX: number; lastY: number }
    | {
        mode: 'edit'
        pointerId: number
        handle: UvHandle
        origin: BossbarUv
        start: { x: number; y: number }
      }
    | null
  >(null)
  const [draft, setDraft] = useState<BossbarUv>({ x: 0, y: 0, width: 1, height: 1 })
  const [origin, setOrigin] = useState<BossbarUv>({ x: 0, y: 0, width: 1, height: 1 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [showGrid, setShowGrid] = useState(true)
  const [panning, setPanning] = useState(false)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [windowOffset, setWindowOffset] = useState<{ x: number; y: number } | null>(null)
  const documentRef = useRef(document)
  const textureSizeRef = useRef(textureSize)
  const targetRef = useRef(target)
  const fittedRef = useRef(false)
  documentRef.current = document
  textureSizeRef.current = textureSize
  targetRef.current = target
  onPreviewRef.current = onPreview
  onCloseRef.current = onClose
  draftRef.current = draft
  viewRef.current = { zoom, panX: pan.x, panY: pan.y }

  const syncHistoryButtons = () => {
    setCanUndo(indexRef.current > 0)
    setCanRedo(indexRef.current < historyRef.current.length - 1)
  }

  const loadTarget = useCallback(() => {
    const next = uvFromDocument(documentRef.current, targetRef.current, textureSizeRef.current)
    originalRef.current = next
    historyRef.current = [{ ...next }]
    indexRef.current = 0
    draftRef.current = next
    setOrigin(next)
    setDraft(next)
    onPreviewRef.current(next)
    syncHistoryButtons()
  }, [target.componentId, target.slot, target.frameIndex, textureSize.height, textureSize.width])

  useEffect(() => {
    loadTarget()
  }, [loadTarget])

  useEffect(() => {
    fittedRef.current = false
    const stage = stageRef.current
    if (!stage) return
    const fit = () => {
      if (fittedRef.current) return
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const availW = Math.max(40, rect.width - RULER)
      const availH = Math.max(40, rect.height - RULER)
      const nextZoom = clampZoom(Math.min(availW / textureSize.width, availH / textureSize.height))
      const panX = RULER + (availW - textureSize.width * nextZoom) / 2
      const panY = RULER + (availH - textureSize.height * nextZoom) / 2
      setZoom(nextZoom)
      setPan({ x: panX, y: panY })
      fittedRef.current = true
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [target.componentId, target.slot, target.frameIndex, textureSize.height, textureSize.width])

  const texOf = (clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }
    const rect = stage.getBoundingClientRect()
    const current = viewRef.current
    return {
      x: Math.floor((clientX - rect.left - current.panX) / current.zoom),
      y: Math.floor((clientY - rect.top - current.panY) / current.zoom),
    }
  }

  const pushHistory = (next: BossbarUv) => {
    const current = historyRef.current[indexRef.current]
    if (current && uvEqual(current, next)) return
    historyRef.current = historyRef.current.slice(0, indexRef.current + 1).concat({ ...next })
    indexRef.current = historyRef.current.length - 1
    syncHistoryButtons()
  }

  const applyDraft = (next: BossbarUv) => {
    const clamped = clampUv(next, textureSize)
    draftRef.current = clamped
    setDraft(clamped)
    onPreviewRef.current(clamped)
    return clamped
  }

  const undo = () => {
    if (indexRef.current <= 0) return
    indexRef.current -= 1
    applyDraft(historyRef.current[indexRef.current])
    syncHistoryButtons()
  }

  const redo = () => {
    if (indexRef.current >= historyRef.current.length - 1) return
    indexRef.current += 1
    applyDraft(historyRef.current[indexRef.current])
    syncHistoryButtons()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const meta = event.metaKey || event.ctrlKey
      if (!meta) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (key === 'y' || (key === 'z' && event.shiftKey)) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [textureSize.height, textureSize.width])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewRef.current
      const rect = stage.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
      const nextZoom = clampZoom(current.zoom * factor)
      if (nextZoom === current.zoom) return
      const texX = (localX - current.panX) / current.zoom
      const texY = (localY - current.panY) / current.zoom
      setZoom(nextZoom)
      setPan({ x: localX - texX * nextZoom, y: localY - texY * nextZoom })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.mode === 'pan') {
      setPanning(false)
      return
    }
    pushHistory(draftRef.current)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { mode: 'pan', pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
      setPanning(true)
      return
    }
    if (readOnly || event.button !== 0) return
    const handle = (event.target as HTMLElement | null)?.dataset.handle as UvHandle | undefined
    if (!handle) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      mode: 'edit',
      pointerId: event.pointerId,
      handle,
      origin: { ...draftRef.current },
      start: texOf(event.clientX, event.clientY),
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = texOf(event.clientX, event.clientY)
    setHover(point)
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.mode === 'pan') {
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      setPan((previous) => ({ x: previous.x + dx, y: previous.y + dy }))
      return
    }
    if (drag.handle === 'move') {
      applyDraft({
        ...drag.origin,
        x: drag.origin.x + (point.x - drag.start.x),
        y: drag.origin.y + (point.y - drag.start.y),
      })
      return
    }
    applyDraft(resizeUv(drag.origin, drag.handle, point, textureSize))
  }

  const src = textureSrc(document.texture)
  const step = rulerStep(zoom)
  const gridStep = zoom >= 8 ? 1 : zoom >= 4 ? 2 : 8
  const ticksX: number[] = []
  const ticksY: number[] = []
  for (let x = 0; x <= textureSize.width; x += step) ticksX.push(x)
  for (let y = 0; y <= textureSize.height; y += step) ticksY.push(y)
  const frameText = target.frameIndex === undefined ? '' : ' · 第 ' + (target.frameIndex + 1) + ' 帧'

  const clampWindow = (x: number, y: number) => {
    const card = cardRef.current
    const parent = card?.offsetParent as HTMLElement | null
    if (!card || !parent) return { x, y }
    const keepX = 80
    const keepY = 28
    return {
      x: clamp(x, keepX - card.offsetWidth, parent.clientWidth - keepX),
      y: clamp(y, 0, parent.clientHeight - keepY),
    }
  }

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement | null)?.closest('button')) return
    const card = cardRef.current
    const parent = card?.offsetParent as HTMLElement | null
    if (!card || !parent) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const cardBox = card.getBoundingClientRect()
    const parentBox = parent.getBoundingClientRect()
    const originX = cardBox.left - parentBox.left
    const originY = cardBox.top - parentBox.top
    windowDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX,
      originY,
    }
    setWindowOffset(clampWindow(originX, originY))
  }

  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = windowDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setWindowOffset(
      clampWindow(
        drag.originX + (event.clientX - drag.startX),
        drag.originY + (event.clientY - drag.startY),
      ),
    )
  }

  const endHeaderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (windowDragRef.current?.pointerId !== event.pointerId) return
    windowDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <aside
      ref={cardRef}
      className={'bb-uv-picker' + (windowOffset ? ' is-moved' : '')}
      role="dialog"
      aria-modal="true"
      aria-label="UV 框选"
      style={windowOffset ? { left: windowOffset.x, top: windowOffset.y } : undefined}
    >
      <div
        className="bb-uv-picker-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
      >
        <strong>UV 框选</strong>
        <Button onClick={onClose}>关闭</Button>
      </div>
      <div className="bb-uv-picker-toolbar">
        <span className="bb-uv-picker-target">
          {target.componentId} / {slotLabel(target.slot)}{frameText}
        </span>
        <label className="bb-toggle">
          <input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />
          <span>网格</span>
        </label>
        <Button disabled={!canUndo} onClick={undo}>撤销</Button>
        <Button disabled={!canRedo} onClick={redo}>重做</Button>
        <span className="bb-tag">
          {draft.x},{draft.y} {draft.width}×{draft.height}
        </span>
      </div>
      <div
        className="bb-uv-picker-stage"
        ref={stageRef}
        data-panning={panning ? 'true' : undefined}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      >
        <div className="bb-uv-ruler bb-uv-ruler-x">
          {ticksX.map((value) => (
            <span key={'x' + value} className="bb-uv-tick" style={{ left: RULER + value * zoom + pan.x }}>
              {value}
            </span>
          ))}
        </div>
        <div className="bb-uv-ruler bb-uv-ruler-y">
          {ticksY.map((value) => (
            <span key={'y' + value} className="bb-uv-tick" style={{ top: RULER + value * zoom + pan.y }}>
              {value}
            </span>
          ))}
        </div>
        <div
          className="bb-uv-world"
          ref={worldRef}
          style={{
            left: pan.x,
            top: pan.y,
            width: textureSize.width * zoom,
            height: textureSize.height * zoom,
          }}
        >
          {src && (
            <img className="bb-uv-texture" alt="" draggable={false} src={src} />
          )}
          {showGrid && (
            <div
              className="bb-uv-grid-overlay"
              style={{
                backgroundSize: gridStep * zoom + 'px ' + gridStep * zoom + 'px',
              }}
            />
          )}
          <div className="bb-uv-rect is-original" style={boxStyle(origin, zoom)} />
          <div
            className="bb-uv-rect is-current"
            data-handle={readOnly ? undefined : 'move'}
            style={boxStyle(draft, zoom)}
          >
            {!readOnly && HANDLES.map((handle) => (
              <i key={handle} className="bb-uv-handle" data-handle={handle} />
            ))}
          </div>
        </div>
        <div className="bb-uv-hud">
          像素 {hover ? hover.x + ', ' + hover.y : '—'}
        </div>
      </div>
    </aside>
  )
}
