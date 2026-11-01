import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import {
  isDisplayRegion,
  isPaintable,
  type BossbarBox,
  type BossbarDocument,
  type BossbarValueMap,
} from '../protocol'
import { buildScene, type BossbarBarView } from '../render/scene'
import { drawBossbarScene } from '../render/canvas'
import {
  BOSSBAR_HANDLES,
  boxesIntersect,
  collectSnapLines,
  handleCursor,
  handlePoint,
  normalizeBox,
  movableSelection,
  moveBoxes,
  moveRegionBox,
  pointInBox,
  resizeBox,
  snapResize,
  type BossbarHandle,
  type ViewTransform,
} from './editorGeometry'
import { clampBoxToRegion } from '../document'
import { createTextMeasurer } from './useBossbarImages'

/**
 * 无限画布设计区。
 *
 * 设计坐标系没有边界；显示区域用虚线框标出，是唯一的输出 AABB。
 * 场景绘制走与游戏共享的 buildScene；选框、手柄、参考线用 DOM 覆盖层。
 */

type DragState =
  | {
      mode: 'move'
      start: { x: number; y: number }
      origin: Map<string, BossbarBox>
    }
  | {
      mode: 'resize'
      handle: BossbarHandle
      id: string
      start: { x: number; y: number }
      origin: BossbarBox
    }
  | {
      mode: 'region-move'
      start: { x: number; y: number }
      origin: BossbarBox
    }
  | {
      mode: 'region-resize'
      handle: BossbarHandle
      start: { x: number; y: number }
      origin: BossbarBox
    }
  | {
      mode: 'marquee'
      start: { x: number; y: number }
      current: { x: number; y: number }
      additive: boolean
    }
  | {
      mode: 'pan'
      startClient: { x: number; y: number }
      origin: ViewTransform
    }

export function BossbarCanvasStage({
  document,
  values,
  bars,
  timeMs,
  texture,
  textureWidth,
  textureHeight,
  view,
  fitRequest,
  grid,
  showGrid,
  showRulers,
  locked,
  hidden,
  selection,
  reference,
  onSelectionChange,
  onBoxesChange,
  onViewChange,
}: {
  document: BossbarDocument
  values: BossbarValueMap
  bars: Record<string, BossbarBarView>
  timeMs: number
  texture: CanvasImageSource | null
  textureWidth: number
  textureHeight: number
  view: ViewTransform
  fitRequest: number
  grid: number
  showGrid: boolean
  showRulers: boolean
  locked: readonly string[]
  hidden: readonly string[]
  selection: readonly string[]
  reference?: { image: CanvasImageSource | null; opacity: number }
  onSelectionChange: (ids: string[]) => void
  onBoxesChange: (changes: Record<string, BossbarBox>, done: boolean) => void
  onViewChange: (view: ViewTransform) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const lastFitRequestRef = useRef<number | null>(null)
  const [marquee, setMarquee] = useState<BossbarBox | null>(null)
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const measure = useMemo(() => createTextMeasurer(), [])

  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  const lockedSet = useMemo(() => new Set(locked), [locked])
  const region = document.components.find(isDisplayRegion) ?? null
  const paintables = useMemo(() => document.components.filter(isPaintable), [document.components])

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!region || size.width <= 0 || size.height <= 0) return
    const initial = lastFitRequestRef.current === null
    const requested = !initial && lastFitRequestRef.current !== fitRequest
    lastFitRequestRef.current = fitRequest
    if (!requested && !(initial && view.zoom === 1 && view.panX === 0 && view.panY === 0)) return
    const zoom = Math.max(0.1, Math.min(8,
      Math.max(1, size.width - 64) / region.box.width,
      Math.max(1, size.height - 64) / region.box.height,
    ))
    onViewChange({
      zoom,
      panX: size.width / 2 - (region.box.x + region.box.width / 2) * zoom,
      panY: size.height / 2 - (region.box.y + region.box.height / 2) * zoom,
    })
  }, [fitRequest, onViewChange, region, size.height, size.width, view.panX, view.panY, view.zoom])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const effectiveDocument = useMemo(() => {
    if (!hiddenSet.size) return document
    return {
      ...document,
      components: document.components.map((component) =>
        hiddenSet.has(component.id) && isPaintable(component) ? { ...component, opacity: 0 } : component,
      ),
    }
  }, [document, hiddenSet])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.width * ratio))
    canvas.height = Math.max(1, Math.round(size.height * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    if (reference?.image) {
      ctx.save()
      ctx.globalAlpha = reference.opacity
      ctx.imageSmoothingEnabled = true
      const image = reference.image
      const width = image instanceof HTMLImageElement ? image.naturalWidth : 1024
      const height = image instanceof HTMLImageElement ? image.naturalHeight : 256
      ctx.drawImage(image, view.panX, view.panY, width * view.zoom, height * view.zoom)
      ctx.restore()
    }

    if (showGrid) {
      const step = grid * view.zoom
      if (step >= 4) {
        const startX = Math.floor(-view.panX / step) * step + view.panX
        const startY = Math.floor(-view.panY / step) * step + view.panY
        ctx.save()
        ctx.strokeStyle = 'rgba(255,255,255,0.055)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let x = startX; x < size.width; x += step) {
          ctx.moveTo(Math.round(x) + 0.5, 0)
          ctx.lineTo(Math.round(x) + 0.5, size.height)
        }
        for (let y = startY; y < size.height; y += step) {
          ctx.moveTo(0, Math.round(y) + 0.5)
          ctx.lineTo(size.width, Math.round(y) + 0.5)
        }
        ctx.stroke()
        ctx.restore()
      }
    }

    ctx.save()
    ctx.strokeStyle = 'rgba(120,180,255,0.5)'
    ctx.lineWidth = 1
    ctx.beginPath()
    const originX = Math.round(view.panX) + 0.5
    const originY = Math.round(view.panY) + 0.5
    ctx.moveTo(originX - 8, originY)
    ctx.lineTo(originX + 8, originY)
    ctx.moveTo(originX, originY - 8)
    ctx.lineTo(originX, originY + 8)
    ctx.stroke()
    ctx.restore()

    const scene = buildScene({
      document: effectiveDocument,
      values,
      timeMs,
      texture: { width: textureWidth, height: textureHeight },
      bars,
      scale: view.zoom,
      origin: { x: view.panX, y: view.panY },
    })
    drawBossbarScene(ctx, scene, { texture, measure })
  }, [
    bars,
    effectiveDocument,
    grid,
    measure,
    reference,
    showGrid,
    size.height,
    size.width,
    texture,
    textureHeight,
    textureWidth,
    timeMs,
    values,
    view.panX,
    view.panY,
    view.zoom,
  ])

  const toDesign = useCallback(
    (clientX: number, clientY: number) => {
      const element = wrapRef.current
      if (!element) return { x: 0, y: 0 }
      const rect = element.getBoundingClientRect()
      return {
        x: (clientX - rect.left - view.panX) / view.zoom,
        y: (clientY - rect.top - view.panY) / view.zoom,
      }
    },
    [view.panX, view.panY, view.zoom],
  )

  const hitTest = useCallback(
    (point: { x: number; y: number }) => {
      for (let index = paintables.length - 1; index >= 0; index -= 1) {
        const component = paintables[index]
        if (hiddenSet.has(component.id) || lockedSet.has(component.id)) continue
        if (pointInBox(component.box, point)) return component.id
      }
      return null
    },
    [hiddenSet, lockedSet, paintables],
  )

  const handleAt = useCallback(
    (clientX: number, clientY: number): { id: string; handle: BossbarHandle; region: boolean } | null => {
      if (selection.length !== 1) return null
      const element = wrapRef.current
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const targets: { id: string; box: BossbarBox; region: boolean }[] = []
      const selected = document.components.find((component) => component.id === selection[0])
      if (selected) {
        const isRegion = isDisplayRegion(selected)
        if (!isRegion && lockedSet.has(selected.id)) return null
        targets.push({ id: selected.id, box: selected.box, region: isRegion })
      }
      for (const target of targets) {
        for (const handle of BOSSBAR_HANDLES) {
          const point = handlePoint(target.box, handle)
          const screenX = rect.left + view.panX + point.x * view.zoom
          const screenY = rect.top + view.panY + point.y * view.zoom
          if (Math.abs(clientX - screenX) <= 7 && Math.abs(clientY - screenY) <= 7) {
            return { id: target.id, handle, region: target.region }
          }
        }
      }
      return null
    },
    [document.components, lockedSet, selection, view.panX, view.panY, view.zoom],
  )

  const boundsOf = useCallback(
    (ids: readonly string[]) =>
      ids
        .map((id) => document.components.find((component) => component.id === id)?.box)
        .filter((box): box is BossbarBox => Boolean(box)),
    [document.components],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button === 1 || (event.button === 0 && spaceHeld)) {
        dragRef.current = { mode: 'pan', startClient: { x: event.clientX, y: event.clientY }, origin: view }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      if (event.button !== 0) return
      const point = toDesign(event.clientX, event.clientY)
      const handle = handleAt(event.clientX, event.clientY)
      if (handle) {
        if (handle.region) {
          const component = document.components.find((entry) => entry.id === handle.id)
          if (component) {
            dragRef.current = { mode: 'region-resize', handle: handle.handle, start: point, origin: { ...component.box } }
            event.currentTarget.setPointerCapture(event.pointerId)
            return
          }
        }
        const component = document.components.find((entry) => entry.id === handle.id)
        if (component) {
          dragRef.current = {
            mode: 'resize',
            handle: handle.handle,
            id: handle.id,
            start: point,
            origin: { ...component.box },
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          return
        }
      }
      const hit = hitTest(point)
      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      if (hit) {
        let nextSelection: string[] = [...selection]
        if (additive) {
          nextSelection = selection.includes(hit) ? selection.filter((id) => id !== hit) : [...selection, hit]
        } else if (!selection.includes(hit)) {
          nextSelection = [hit]
        }
        if (nextSelection !== selection) onSelectionChange(nextSelection)
        const origin = new Map<string, BossbarBox>()
        for (const component of movableSelection(document.components, nextSelection, locked)) {
          origin.set(component.id, { ...component.box })
        }
        if (origin.size) {
          dragRef.current = { mode: 'move', start: point, origin }
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        return
      }
      if (region && selection.length === 1 && selection[0] === region.id && !additive && pointInBox(region.box, point)) {
        dragRef.current = { mode: 'region-move', start: point, origin: { ...region.box } }
        event.currentTarget.setPointerCapture(event.pointerId)
        return
      }
      if (!additive) onSelectionChange([])
      dragRef.current = { mode: 'marquee', start: point, current: point, additive }
      setMarquee({ x: point.x, y: point.y, width: 0, height: 0 })
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [document.components, handleAt, hitTest, locked, onSelectionChange, region, selection, spaceHeld, toDesign, view],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.mode === 'pan') {
        onViewChange({
          ...drag.origin,
          panX: drag.origin.panX + (event.clientX - drag.startClient.x),
          panY: drag.origin.panY + (event.clientY - drag.startClient.y),
        })
        return
      }
      const point = toDesign(event.clientX, event.clientY)
      if (drag.mode === 'marquee') {
        drag.current = point
        setMarquee(
          normalizeBox({
            x: drag.start.x,
            y: drag.start.y,
            width: point.x - drag.start.x,
            height: point.y - drag.start.y,
          }),
        )
        return
      }
      const threshold = 6 / view.zoom
      const excludedIds = drag.mode === 'move'
        ? new Set(selection)
        : new Set(drag.mode === 'resize' ? [drag.id] : [region?.id ?? ''])
      const snapTargets = document.components
        .filter((component) => !excludedIds.has(component.id) && !hiddenSet.has(component.id))
        .map((component) => component.box)
      const lines = collectSnapLines(
        snapTargets,
        region ? region.box : { x: -10000, y: -10000, width: 20000, height: 20000 },
        grid,
        showGrid,
      )
      const skipSnap = event.altKey

      if (drag.mode === 'move') {
        const originals = [...drag.origin.values()]
        const moved = moveBoxes(originals,
          { x: round(point.x - drag.start.x), y: round(point.y - drag.start.y) },
          region?.box ?? null,
          skipSnap ? undefined : { lines, threshold },
        )
        const changes: Record<string, BossbarBox> = {}
        let index = 0
        for (const id of drag.origin.keys()) {
          changes[id] = moved.boxes[index++]
        }
        setGuides(moved.guides)
        onBoxesChange(changes, false)
        return
      }

      if (drag.mode === 'resize') {
        const raw = resizeBox(drag.origin, drag.handle, { x: point.x - drag.start.x, y: point.y - drag.start.y })
        const snapped = skipSnap
          ? { box: raw, guides: { x: [], y: [] } }
          : snapResize(raw, drag.handle, lines, threshold)
        let box = normalizeBox(snapped.box)
        if (region) box = clampBoxToRegion(region.box, box)
        setGuides(snapped.guides)
        onBoxesChange({ [drag.id]: roundBox(box) }, false)
        return
      }

      if (drag.mode === 'region-move') {
        const box = moveRegionBox(drag.origin,
          { x: round(point.x - drag.start.x), y: round(point.y - drag.start.y) },
          boundsOf(paintables.map((component) => component.id)),
        )
        const regionId = findRegionId(document)
        if (regionId) onBoxesChange({ [regionId]: box }, false)
        return
      }

      if (drag.mode === 'region-resize') {
        let box = normalizeBox(resizeBox(drag.origin, drag.handle, { x: point.x - drag.start.x, y: point.y - drag.start.y }))
        const others = boundsOf(paintables.map((component) => component.id))
        if (others.length) {
          const minLeft = Math.min(...others.map((entry) => entry.x))
          const maxRight = Math.max(...others.map((entry) => entry.x + entry.width))
          const minTop = Math.min(...others.map((entry) => entry.y))
          const maxBottom = Math.max(...others.map((entry) => entry.y + entry.height))
          const left = Math.min(box.x, minLeft)
          const top = Math.min(box.y, minTop)
          const right = Math.max(box.x + box.width, maxRight)
          const bottom = Math.max(box.y + box.height, maxBottom)
          box = { x: left, y: top, width: right - left, height: bottom - top }
        }
        const regionId = findRegionId(document)
        if (regionId) onBoxesChange({ [regionId]: roundBox(box) }, false)
      }
    },
    [
      boundsOf,
      document,
      grid,
      hiddenSet,
      onBoxesChange,
      onViewChange,
      paintables,
      region,
      selection,
      showGrid,
      toDesign,
      view.zoom,
    ],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      dragRef.current = null
      setGuides({ x: [], y: [] })
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (!drag) return
      if (drag.mode === 'marquee') {
        const box = normalizeBox({
          x: drag.start.x,
          y: drag.start.y,
          width: drag.current.x - drag.start.x,
          height: drag.current.y - drag.start.y,
        })
        const hits = paintables
          .filter((component) => !hiddenSet.has(component.id) && !lockedSet.has(component.id) && boxesIntersect(component.box, box))
          .map((component) => component.id)
        onSelectionChange(drag.additive ? [...new Set([...selection, ...hits])] : hits)
        setMarquee(null)
        return
      }
      if (drag.mode === 'move' || drag.mode === 'resize' || drag.mode === 'region-move' || drag.mode === 'region-resize') {
        onBoxesChange({}, true)
      }
    },
    [hiddenSet, lockedSet, onBoxesChange, onSelectionChange, paintables, selection],
  )

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const element = wrapRef.current
        if (!element) return
        const rect = element.getBoundingClientRect()
        const localX = event.clientX - rect.left
        const localY = event.clientY - rect.top
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
        const zoom = Math.max(0.05, Math.min(16, view.zoom * factor))
        const designX = (localX - view.panX) / view.zoom
        const designY = (localY - view.panY) / view.zoom
        onViewChange({ zoom, panX: localX - designX * zoom, panY: localY - designY * zoom })
        return
      }
      event.preventDefault()
      onViewChange({ ...view, panX: view.panX - event.deltaX, panY: view.panY - event.deltaY })
    },
    [onViewChange, view],
  )

  return (
    <div className="bb-stage" role="region" aria-label="BossBar 编辑视口" ref={wrapRef} data-space={spaceHeld ? 'pan' : undefined}>
      <canvas ref={canvasRef} className="bb-stage-canvas" style={{ width: size.width, height: size.height }} />
      <div
        className="bb-stage-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ cursor: spaceHeld ? 'grab' : 'default' }}
      >
        {region && (
          <>
            <div
              className="bb-region-outline"
              data-selected={selection.includes(region.id) ? 'true' : undefined}
              style={{
                left: region.box.x * view.zoom + view.panX,
                top: region.box.y * view.zoom + view.panY,
                width: region.box.width * view.zoom,
                height: region.box.height * view.zoom,
              }}
            />
            <button
              type="button"
              className="bb-region-chip"
              style={{
                left: region.box.x * view.zoom + view.panX,
                top: region.box.y * view.zoom + view.panY - 22,
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || spaceHeld) return
                event.stopPropagation()
                onSelectionChange([region.id])
                dragRef.current = {
                  mode: 'region-move',
                  start: toDesign(event.clientX, event.clientY),
                  origin: { ...region.box },
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onClick={() => onSelectionChange([region.id])}
            >
              显示区域
            </button>
          </>
        )}
        {selection.length === 1 &&
          (() => {
            const component = document.components.find((entry) => entry.id === selection[0])
            if (!component) return null
            const isRegion = isDisplayRegion(component)
            return (
              <div
                className="bb-selection"
                data-region={isRegion ? 'true' : undefined}
                style={{
                  left: component.box.x * view.zoom + view.panX,
                  top: component.box.y * view.zoom + view.panY,
                  width: component.box.width * view.zoom,
                  height: component.box.height * view.zoom,
                }}
              >
                {BOSSBAR_HANDLES.map((handle) => {
                  const point = handlePoint(component.box, handle)
                  return (
                    <span
                      key={handle}
                      className="bb-handle"
                      data-handle={handle}
                      style={{
                        left: (point.x - component.box.x) * view.zoom,
                        top: (point.y - component.box.y) * view.zoom,
                        cursor: handleCursor(handle),
                      }}
                    />
                  )
                })}
              </div>
            )
          })()}
        {selection.length > 1 &&
          document.components
            .filter((component) => selection.includes(component.id))
            .map((component) => (
              <div
                key={component.id}
                className="bb-selection bb-selection-multi"
                style={{
                  left: component.box.x * view.zoom + view.panX,
                  top: component.box.y * view.zoom + view.panY,
                  width: component.box.width * view.zoom,
                  height: component.box.height * view.zoom,
                }}
              />
            ))}
        {marquee && (
          <div
            className="bb-marquee"
            style={{
              left: marquee.x * view.zoom + view.panX,
              top: marquee.y * view.zoom + view.panY,
              width: marquee.width * view.zoom,
              height: marquee.height * view.zoom,
            }}
          />
        )}
        {guides.x.map((value) => (
          <div key={'gx' + value} className="bb-guide bb-guide-v" style={{ left: value * view.zoom + view.panX }} />
        ))}
        {guides.y.map((value) => (
          <div key={'gy' + value} className="bb-guide bb-guide-h" style={{ top: value * view.zoom + view.panY }} />
        ))}
      </div>
      {showRulers && (
        <div className="bb-stage-status">
          <span>
            {Math.round(region?.box.width ?? 0)}×{Math.round(region?.box.height ?? 0)}
          </span>
        </div>
      )}
    </div>
  )
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundBox(box: BossbarBox): BossbarBox {
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

function findRegionId(document: BossbarDocument): string {
  return document.components.find(isDisplayRegion)?.id ?? ''
}
