import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  BOSSBAR_LIMITS,
  isDisplayRegion,
  type BossbarDocument,
  type BossbarPaint,
  type BossbarUv,
} from '../protocol'
import { base64ToBytes, encodeBase64, pngInfo } from '../png'
import { Button, Empty, NumberField, Row, Section, TextField } from './BossbarEditorUi'

/**
 * 图集面板：唯一 PNG 的上传/替换、放大、UV 框选与精确像素输入。
 *
 * 文档只有一张图，所以这里也是全部 UV 的唯一来源；替换图集是一次文档编辑，
 * 图片数据和全部 UV 一起构成一个草稿版本。
 */

export type BossbarUvTarget = { componentId: string; slot: 'paint' | 'fill' | 'trail'; frameIndex?: number }

const ATLAS_ZOOM_MIN = 0.1
const ATLAS_ZOOM_MAX = 32

function clampAtlasZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(ATLAS_ZOOM_MIN, Math.min(ATLAS_ZOOM_MAX, value))
}

function formatAtlasZoom(value: number): string {
  if (value >= 10) return Math.round(value) + '×'
  const rounded = Math.round(value * 10) / 10
  if (rounded >= 1) return rounded + '×'
  return (Math.round(value * 100) / 100) + '×'
}

function paintAt(document: BossbarDocument, target: BossbarUvTarget): BossbarPaint | null {
  const component = document.components.find((entry) => entry.id === target.componentId)
  if (!component || isDisplayRegion(component)) return null
  if (target.slot === 'paint') return component.type === 'background' ? component.paint : null
  if (component.type !== 'bar') return null
  if (target.slot === 'fill') return component.fill
  return component.trail?.paint ?? null
}

export function BossbarAtlasPanel({
  document,
  textureImage,
  textureSize,
  target,
  readOnly,
  onTextureChange,
  onUvChange,
  onClearTarget,
  onProblems,
}: {
  document: BossbarDocument
  textureImage: CanvasImageSource | null
  textureSize: { width: number; height: number }
  target: BossbarUvTarget | null
  readOnly: boolean
  onTextureChange: (base64: string) => void
  onUvChange: (uv: BossbarUv) => void
  onClearTarget: () => void
  onProblems: (problems: string[]) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null)
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const spaceHeldRef = useRef(false)
  const loadVersionRef = useRef(0)
  const zoomRef = useRef(8)
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)
  const [zoom, setZoom] = useState(8)
  const [draft, setDraft] = useState<BossbarUv | null>(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const [stageHeight, setStageHeight] = useState(220)
  const [stageResizing, setStageResizing] = useState(false)
  const stageDragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)
  zoomRef.current = zoom
  spaceHeldRef.current = spaceHeld
  const viewWidth = Math.max(16, textureSize.width * zoom)
  const viewHeight = Math.max(16, textureSize.height * zoom)

  const paint = target ? paintAt(document, target) : null
  const currentUv = paint && paint.kind === 'texture'
    ? target?.frameIndex === undefined ? paint.uv : paint.animation?.frames[target.frameIndex]?.uv ?? null
    : null

  useEffect(() => () => { loadVersionRef.current += 1 }, [document])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = viewWidth
    const height = viewHeight
    // 放大只改变查看尺寸；图集本身最多4096边，不能随32倍缩放分配同等大小的位图。
    const ratio = Math.min(window.devicePixelRatio || 1, 4096 / width, 4096 / height)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    canvas.style.width = width + 'px'
    canvas.style.height = height + 'px'
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#101418'
    ctx.fillRect(0, 0, width, height)
    if (textureImage) {
      ctx.imageSmoothingEnabled = zoom >= 4 ? false : true
      ctx.drawImage(textureImage, 0, 0, width, height)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    for (let x = 0; x <= textureSize.width; x += 1) {
      if (zoom < 6 && x % 4 !== 0) continue
      ctx.beginPath()
      ctx.moveTo(Math.round(x * zoom) + 0.5, 0)
      ctx.lineTo(Math.round(x * zoom) + 0.5, height)
      ctx.stroke()
    }
    for (let y = 0; y <= textureSize.height; y += 1) {
      if (zoom < 6 && y % 4 !== 0) continue
      ctx.beginPath()
      ctx.moveTo(0, Math.round(y * zoom) + 0.5)
      ctx.lineTo(width, Math.round(y * zoom) + 0.5)
      ctx.stroke()
    }
    const box = draft ?? currentUv
    if (box) {
      ctx.save()
      ctx.fillStyle = 'rgba(120,180,255,0.22)'
      ctx.strokeStyle = 'rgba(150,200,255,0.95)'
      ctx.lineWidth = 2
      ctx.fillRect(box.x * zoom, box.y * zoom, box.width * zoom, box.height * zoom)
      ctx.strokeRect(box.x * zoom + 1, box.y * zoom + 1, box.width * zoom - 2, box.height * zoom - 2)
      ctx.restore()
    }
  }, [currentUv, draft, textureImage, textureSize.height, textureSize.width, viewHeight, viewWidth, zoom])

  useEffect(() => {
    draw()
  }, [draw])

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current
    const wrap = wrapRef.current
    if (!pending || !wrap) return
    wrap.scrollLeft = pending.left
    wrap.scrollTop = pending.top
    pendingScrollRef.current = null
  }, [viewHeight, viewWidth, zoom])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = zoomRef.current
      const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25
      const next = clampAtlasZoom(current * factor)
      if (next === current) return
      const rect = wrap.getBoundingClientRect()
      const localX = event.clientX - rect.left + wrap.scrollLeft
      const localY = event.clientY - rect.top + wrap.scrollTop
      pendingScrollRef.current = {
        left: (localX / current) * next - (event.clientX - rect.left),
        top: (localY / current) * next - (event.clientY - rect.top),
      }
      setZoom(next)
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      event.preventDefault()
      if (event.repeat) return
      spaceHeldRef.current = true
      setSpaceHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceHeldRef.current = false
      setSpaceHeld(false)
    }
    const onBlur = () => {
      spaceHeldRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown, { passive: false })
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: Math.floor((event.clientX - rect.left) / zoom),
      y: Math.floor((event.clientY - rect.top) / zoom),
    }
  }

  const overCanvas = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return false
    const rect = canvas.getBoundingClientRect()
    return (
      event.clientX >= rect.left &&
      event.clientX < rect.right &&
      event.clientY >= rect.top &&
      event.clientY < rect.bottom
    )
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return false
    panRef.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    return true
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    const wantPan = event.button === 1 || (event.button === 0 && spaceHeldRef.current)
    if (wantPan) {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      panRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
      setPanning(true)
      return
    }
    if (readOnly || !target || event.button !== 0 || !overCanvas(event)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOf(event)
    dragRef.current = { start: point, current: point }
    setDraft({ x: point.x, y: point.y, width: 1, height: 1 })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan && pan.pointerId === event.pointerId) {
      const wrap = wrapRef.current
      if (wrap) {
        wrap.scrollLeft -= event.clientX - pan.lastX
        wrap.scrollTop -= event.clientY - pan.lastY
      }
      pan.lastX = event.clientX
      pan.lastY = event.clientY
      return
    }
    const drag = dragRef.current
    if (!drag) return
    drag.current = pointOf(event)
    const x = Math.min(drag.start.x, drag.current.x)
    const y = Math.min(drag.start.y, drag.current.y)
    const width = Math.max(1, Math.abs(drag.current.x - drag.start.x))
    const height = Math.max(1, Math.abs(drag.current.y - drag.start.y))
    setDraft({
      x: clamp(x, 0, textureSize.width - 1),
      y: clamp(y, 0, textureSize.height - 1),
      width: Math.min(width, textureSize.width - clamp(x, 0, textureSize.width - 1)),
      height: Math.min(height, textureSize.height - clamp(y, 0, textureSize.height - 1)),
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (endPan(event)) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const drag = dragRef.current
    dragRef.current = null
    setDraft(null)
    if (!drag) return
    const end = pointOf(event)
    const x = clamp(Math.min(drag.start.x, end.x), 0, textureSize.width - 1)
    const y = clamp(Math.min(drag.start.y, end.y), 0, textureSize.height - 1)
    const width = Math.min(Math.max(1, Math.abs(end.x - drag.start.x)), textureSize.width - x)
    const height = Math.min(Math.max(1, Math.abs(end.y - drag.start.y)), textureSize.height - y)
    if (width > 0 && height > 0) onUvChange({ x, y, width, height })
  }

  const loadFile = async (file: File) => {
    const version = ++loadVersionRef.current
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (loadVersionRef.current !== version) return
    if (bytes.length > BOSSBAR_LIMITS.texture.maxBytes) {
      onProblems(['PNG ' + bytes.length + ' 字节，超过上限 ' + BOSSBAR_LIMITS.texture.maxBytes])
      return
    }
    const info = pngInfo(bytes)
    if (!info) {
      onProblems(['这不是有效的 PNG'])
      return
    }
    if (info.apng) {
      onProblems(['不接受 APNG：动画必须来自显式 UV 序列'])
      return
    }
    if (info.width > BOSSBAR_LIMITS.texture.maxSide || info.height > BOSSBAR_LIMITS.texture.maxSide) {
      onProblems(['PNG 尺寸超过 4096'])
      return
    }
    onTextureChange(encodeBase64(bytes))
  }

  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')

  return (
    <div className="bb-atlas">
      <Section
        className="bb-atlas-view"
        title="图集"
        extra={
          <span className="bb-tag">
            {textureSize.width}×{textureSize.height}
          </span>
        }
      >
        <div
          className="bb-atlas-canvas-wrap"
          ref={wrapRef}
          style={{ height: stageHeight }}
          data-panning={panning ? 'true' : undefined}
          data-space={spaceHeld && !panning ? 'pan' : undefined}
          data-uv={target && !readOnly && !spaceHeld && !panning ? 'true' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
        >
          <canvas
            ref={canvasRef}
            className="bb-atlas-canvas"
            style={{
              width: viewWidth,
              height: viewHeight,
            }}
          />
        </div>
        <Row label="放大">
          <input
            type="range"
            min={ATLAS_ZOOM_MIN}
            max={ATLAS_ZOOM_MAX}
            step={0.1}
            value={zoom}
            onChange={(event) => setZoom(clampAtlasZoom(Number(event.target.value)))}
          />
          <span className="bb-tag">{formatAtlasZoom(zoom)}</span>
        </Row>
        {target ? (
          <div className="bb-atlas-target">
            <span>
              正在框选：<code>{target.componentId}</code> 的{' '}
              {target.slot === 'paint' ? '背景纹理' : target.slot === 'fill' ? '填充' : '尾条'}
              {target.frameIndex !== undefined && ' · 第 ' + (target.frameIndex + 1) + ' 帧'}
            </span>
            <Button variant="ghost" onClick={onClearTarget}>
              结束框选
            </Button>
          </div>
        ) : null}
        {draft && (
          <p className="bb-hint">
            框选：{draft.x},{draft.y} {draft.width}×{draft.height}
          </p>
        )}
        <div
          className="bb-atlas-view-sash"
          data-active={stageResizing ? "true" : undefined}
          title="拖动调整图集高度"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            stageDragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startH: stageHeight,
            }
            setStageResizing(true)
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* capture is optional */
            }
          }}
          onPointerMove={(event) => {
            const drag = stageDragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const next = drag.startH + (event.clientY - drag.startY)
            setStageHeight(Math.max(120, Math.min(960, Math.round(next))))
          }}
          onPointerUp={(event) => {
            if (stageDragRef.current?.pointerId !== event.pointerId) return
            stageDragRef.current = null
            setStageResizing(false)
          }}
          onPointerCancel={(event) => {
            if (stageDragRef.current?.pointerId !== event.pointerId) return
            stageDragRef.current = null
            setStageResizing(false)
          }}
        />
      </Section>

      <Section title="替换图集">
        <input
          type="file"
          accept="image/png"
          disabled={readOnly}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.target.value = ''
          }}
        />
        <p className="bb-hint">
          PNG ≤4MiB、≤4096×4096。替换保留现有 UV。
        </p>
        <Row label="粘贴 Base64">
          <TextField
            mono
            value={paste}
            placeholder="data:image/png;base64,… 或纯 Base64"
            disabled={readOnly}
            onCommit={(text) => setPaste(text)}
          />
        </Row>
        <Button
          disabled={readOnly || !paste.trim()}
          onClick={() => {
            setPasteError('')
            const bytes = base64ToBytes(paste)
            const info = bytes ? pngInfo(bytes) : null
            if (!bytes || !info) {
              setPasteError('粘贴内容不是有效的 Base64 PNG')
              return
            }
            onTextureChange(encodeBase64(bytes))
            setPaste('')
          }}
        >
          应用粘贴的图集
        </Button>
        {pasteError && <p className="bb-warn">{pasteError}</p>}
      </Section>

      <Section title="当前 UV">
        {!target && <Empty>请先选择纹理画笔</Empty>}
        {target && paint && paint.kind !== 'texture' && (
          <Empty>切换为图集纹理后可设置 UV。</Empty>
        )}
        {target && paint && paint.kind === 'texture' && currentUv && (
          <UvFields uv={currentUv} texture={textureSize} readOnly={readOnly} onChange={onUvChange} />
        )}
      </Section>
    </div>
  )
}

function UvFields({
  uv,
  texture,
  readOnly,
  onChange,
}: {
  uv: BossbarUv
  texture: { width: number; height: number }
  readOnly: boolean
  onChange: (uv: BossbarUv) => void
}) {
  return (
    <div className="bb-uv-grid">
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <Row key={key} label={key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? '宽' : '高'}>
          <NumberField
            value={uv[key]}
            min={key === 'width' || key === 'height' ? 1 : 0}
            disabled={readOnly}
            onCommit={(value) => onChange({ ...uv, [key]: Math.round(value) })}
          />
        </Row>
      ))}
      <p className="bb-hint">
        UV 须在 {texture.width}×{texture.height} 内。
      </p>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
