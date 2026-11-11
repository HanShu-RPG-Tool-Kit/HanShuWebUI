import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { BossbarUv } from '../protocol'
import { useBlockBrowserMouseGestures } from '../../../../ui/blockBrowserMouseGestures'
import { Button } from './BossbarEditorUi'
import { textureSrc } from './BossbarAtlasPanel'
import type { AtlasDetectSlice, AtlasSliceKind } from './atlasDetect'

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

function boxStyle(uv: BossbarUv, zoom: number) {
  return {
    left: uv.x * zoom,
    top: uv.y * zoom,
    width: Math.max(1, uv.width * zoom),
    height: Math.max(1, uv.height * zoom),
  }
}

function nextSliceId(slices: AtlasDetectSlice[]): string {
  let index = slices.length + 1
  const taken = new Set(slices.map((slice) => slice.id))
  while (taken.has('slice' + index)) index += 1
  return 'slice' + index
}

export function BossbarAtlasDetectPanel({
  textureBase64,
  textureSize,
  initialSlices,
  readOnly,
  onConfirm,
  onClose,
}: {
  textureBase64: string
  textureSize: { width: number; height: number }
  initialSlices: AtlasDetectSlice[]
  readOnly: boolean
  onConfirm: (slices: AtlasDetectSlice[]) => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  useBlockBrowserMouseGestures(stageRef)
  const [slices, setSlices] = useState<AtlasDetectSlice[]>(() =>
    initialSlices.map((slice) => ({ ...slice, uv: { ...slice.uv } })),
  )
  const [selectedId, setSelectedId] = useState<string | null>(initialSlices[0]?.id ?? null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [windowOffset, setWindowOffset] = useState<{ x: number; y: number } | null>(null)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const slicesRef = useRef(slices)
  const selectedRef = useRef(selectedId)
  const fittedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const windowDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const dragRef = useRef<
    | { mode: 'pan'; pointerId: number; lastX: number; lastY: number }
    | {
        mode: 'edit'
        pointerId: number
        handle: UvHandle
        sliceId: string
        origin: BossbarUv
        start: { x: number; y: number }
      }
    | null
  >(null)

  slicesRef.current = slices
  selectedRef.current = selectedId
  viewRef.current = { zoom, panX: pan.x, panY: pan.y }
  onCloseRef.current = onClose

  const selected = slices.find((slice) => slice.id === selectedId) ?? null

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
      setZoom(nextZoom)
      setPan({
        x: RULER + (availW - textureSize.width * nextZoom) / 2,
        y: RULER + (availH - textureSize.height * nextZoom) / 2,
      })
      fittedRef.current = true
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [textureSize.height, textureSize.width])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (readOnly) return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const id = selectedRef.current
      if (!id) return
      event.preventDefault()
      setSlices((previous) => {
        const next = previous.filter((slice) => slice.id !== id)
        setSelectedId(next[0]?.id ?? null)
        return next
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [readOnly])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewRef.current
      const rect = stage.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const nextZoom = clampZoom(current.zoom * (event.deltaY < 0 ? 1.25 : 1 / 1.25))
      if (nextZoom === current.zoom) return
      const texX = (localX - current.panX) / current.zoom
      const texY = (localY - current.panY) / current.zoom
      setZoom(nextZoom)
      setPan({ x: localX - texX * nextZoom, y: localY - texY * nextZoom })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

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

  const patchSelectedUv = (uv: BossbarUv) => {
    const id = selectedRef.current
    if (!id) return
    const clamped = clampUv(uv, textureSize)
    setSlices((previous) =>
      previous.map((slice) => (slice.id === id ? { ...slice, uv: clamped } : slice)),
    )
  }

  const setKind = (id: string, kind: AtlasSliceKind) => {
    setSlices((previous) =>
      previous.map((slice) => (slice.id === id ? { ...slice, kind } : slice)),
    )
  }

  const removeSlice = (id: string) => {
    setSlices((previous) => {
      const next = previous.filter((slice) => slice.id !== id)
      if (selectedRef.current === id) setSelectedId(next[0]?.id ?? null)
      return next
    })
  }

  const addSlice = () => {
    if (readOnly) return
    const uv = clampUv(
      selected?.uv ?? { x: 0, y: 0, width: Math.min(16, textureSize.width), height: Math.min(16, textureSize.height) },
      textureSize,
    )
    const id = nextSliceId(slicesRef.current)
    setSlices((previous) => [...previous, { id, uv, kind: 'background' }])
    setSelectedId(id)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.mode === 'pan') setPanning(false)
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
    const target = event.target as HTMLElement | null
    const sliceId = target?.dataset.sliceId
    const handle = target?.dataset.handle as UvHandle | undefined
    if (sliceId) setSelectedId(sliceId)
    if (!handle || !sliceId) return
    const slice = slicesRef.current.find((entry) => entry.id === sliceId)
    if (!slice) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      mode: 'edit',
      pointerId: event.pointerId,
      handle,
      sliceId,
      origin: { ...slice.uv },
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
    selectedRef.current = drag.sliceId
    setSelectedId(drag.sliceId)
    if (drag.handle === 'move') {
      patchSelectedUv({
        ...drag.origin,
        x: drag.origin.x + (point.x - drag.start.x),
        y: drag.origin.y + (point.y - drag.start.y),
      })
      return
    }
    patchSelectedUv(resizeUv(drag.origin, drag.handle, point, textureSize))
  }

  const clampWindow = (x: number, y: number) => {
    const card = cardRef.current
    const parent = card?.offsetParent as HTMLElement | null
    if (!card || !parent) return { x, y }
    return {
      x: clamp(x, 80 - card.offsetWidth, parent.clientWidth - 80),
      y: clamp(y, 0, parent.clientHeight - 28),
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

  const src = textureSrc(textureBase64)
  const step = zoom >= 12 ? 1 : zoom >= 6 ? 2 : zoom >= 3 ? 5 : zoom >= 1 ? 10 : 20
  const ticksX: number[] = []
  const ticksY: number[] = []
  for (let x = 0; x <= textureSize.width; x += step) ticksX.push(x)
  for (let y = 0; y <= textureSize.height; y += step) ticksY.push(y)

  return (
    <aside
      ref={cardRef}
      className={'bb-uv-picker bb-detect-picker' + (windowOffset ? ' is-moved' : '')}
      role="dialog"
      aria-modal="true"
      aria-label="自动识别图块"
      style={windowOffset ? { left: windowOffset.x, top: windowOffset.y } : undefined}
    >
      <div
        className="bb-uv-picker-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endHeaderDrag}
        onPointerCancel={endHeaderDrag}
      >
        <strong>自动识别</strong>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="primary"
          disabled={readOnly || slices.length === 0}
          onClick={() => onConfirm(slices.map((slice) => ({ ...slice, uv: { ...slice.uv } })))}
        >
          添加到画布
        </Button>
      </div>
      <div className="bb-detect-body">
        <div className="bb-detect-side">
          <div className="bb-detect-side-head">
            <span>图块 {slices.length}</span>
            <Button disabled={readOnly} onClick={addSlice}>新增</Button>
          </div>
          <div className="bb-detect-list">
            {slices.length === 0 ? (
              <p className="bb-hint">没有可添加的图块。可点「新增」手动框选。</p>
            ) : (
              slices.map((slice, index) => (
                <button
                  key={slice.id}
                  type="button"
                  className={'bb-detect-item' + (slice.id === selectedId ? ' is-active' : '')}
                  data-kind={slice.kind}
                  onClick={() => setSelectedId(slice.id)}
                >
                  <span className="bb-detect-item-title">
                    #{index + 1} {slice.kind === 'bar' ? '数值条' : '背景'}
                  </span>
                  <span className="bb-tag">
                    {slice.uv.x},{slice.uv.y} {slice.uv.width}×{slice.uv.height}
                  </span>
                </button>
              ))
            )}
          </div>
          {selected && (
            <div className="bb-detect-editor">
              <label className="bb-detect-kind">
                <span>类型</span>
                <select
                  value={selected.kind}
                  disabled={readOnly}
                  onChange={(event) => setKind(selected.id, event.target.value as AtlasSliceKind)}
                >
                  <option value="background">背景</option>
                  <option value="bar">数值条</option>
                </select>
              </label>
              <Button disabled={readOnly} onClick={() => removeSlice(selected.id)}>删除</Button>
            </div>
          )}
          <p className="bb-hint">右键拖动画布；拖边调整选中框。过小碎块已自动忽略。</p>
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
            style={{
              left: pan.x,
              top: pan.y,
              width: textureSize.width * zoom,
              height: textureSize.height * zoom,
            }}
          >
            {src && <img className="bb-uv-texture" alt="" draggable={false} src={src} />}
            {slices.map((slice) => {
              const active = slice.id === selectedId
              return (
                <div
                  key={slice.id}
                  className={
                    'bb-uv-rect bb-detect-rect' +
                    (active ? ' is-current' : '') +
                    (slice.kind === 'bar' ? ' is-bar' : ' is-bg')
                  }
                  data-slice-id={slice.id}
                  data-handle={active && !readOnly ? 'move' : undefined}
                  style={boxStyle(slice.uv, zoom)}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    setSelectedId(slice.id)
                  }}
                >
                  {active && !readOnly && HANDLES.map((handle) => (
                    <i
                      key={handle}
                      className="bb-uv-handle"
                      data-handle={handle}
                      data-slice-id={slice.id}
                    />
                  ))}
                </div>
              )
            })}
          </div>
          <div className="bb-uv-hud">
            像素 {hover ? hover.x + ', ' + hover.y : '—'}
          </div>
        </div>
      </div>
    </aside>
  )
}
