import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  BOSSBAR_LIMITS,
  isDisplayRegion,
  type BossbarDocument,
  type BossbarPaint,
  type BossbarUv,
} from '../protocol'
import { base64ToBytes, decodeBase64, decodePngRgba, encodeBase64, pngInfo, type PngRgba } from '../png'
import { appendAtlasFromRgba, packAtlasImages, type AtlasPackPlacement } from './atlasPack'
import {
  detectAtlasRegions,
  loadAtlasRgba,
  slicesFromRegions,
  type AtlasDetectSlice,
} from './atlasDetect'
import { useBlockBrowserMouseGestures } from '../../../../ui/blockBrowserMouseGestures'
import { Button, Empty, TextField } from './BossbarEditorUi'

/**
 * 图集面板：预览、替换/追加、识别；放大镜打开大图弹窗。
 */

export type BossbarTextureChange = {
  base64: string
  /** 追加写入的 UV；替换图集时为空 */
  appended?: AtlasPackPlacement[]
}

export type BossbarUvTarget = { componentId: string; slot: 'paint' | 'fill' | 'trail'; frameIndex?: number }

export function paintAt(document: BossbarDocument, target: BossbarUvTarget): BossbarPaint | null {
  const component = document.components.find((entry) => entry.id === target.componentId)
  if (!component || isDisplayRegion(component)) return null
  if (target.slot === 'paint') return component.type === 'background' ? component.paint : null
  if (component.type !== 'bar') return null
  if (target.slot === 'fill') return component.fill
  return component.trail?.paint ?? null
}

export function uvOfTarget(document: BossbarDocument, target: BossbarUvTarget): BossbarUv | null {
  const paint = paintAt(document, target)
  if (!paint || paint.kind !== 'texture') return null
  if (target.frameIndex === undefined) return paint.uv
  return paint.animation?.frames[target.frameIndex]?.uv ?? null
}

export function textureSrc(base64: string): string {
  if (!base64) return ''
  return base64.startsWith('data:') ? base64 : 'data:image/png;base64,' + base64
}

function containRect(
  box: { width: number; height: number },
  texture: { width: number; height: number },
) {
  if (box.width <= 0 || box.height <= 0 || texture.width <= 0 || texture.height <= 0) return null
  const scale = Math.min(box.width / texture.width, box.height / texture.height)
  const width = texture.width * scale
  const height = texture.height * scale
  return {
    x: (box.width - width) / 2,
    y: (box.height - height) / 2,
    width,
    height,
    scale,
  }
}

async function decodeAtlasBytes(bytes: Uint8Array): Promise<PngRgba | null> {
  const direct = decodePngRgba(bytes)
  if (direct) return direct
  if (typeof createImageBitmap !== 'function') return null
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
    type: 'image/png',
  })
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
    const ctx = canvas.getContext('2d')
    if (!ctx || !('drawImage' in ctx)) return null
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: new Uint8Array(imageData.data.buffer.slice(0)),
    }
  } finally {
    bitmap.close()
  }
}

function validateAtlasPng(bytes: Uint8Array): string | null {
  if (bytes.length > BOSSBAR_LIMITS.texture.maxBytes) {
    return 'PNG ' + bytes.length + ' 字节，超过上限 ' + BOSSBAR_LIMITS.texture.maxBytes
  }
  const info = pngInfo(bytes)
  if (!info) return '这不是有效的 PNG'
  if (info.apng) return '不接受 APNG：动画必须来自显式 UV 序列'
  if (info.width > BOSSBAR_LIMITS.texture.maxSide || info.height > BOSSBAR_LIMITS.texture.maxSide) {
    return 'PNG 尺寸超过 4096'
  }
  return null
}

function AtlasEnlargeDialog({
  src,
  textureSize,
  currentUv,
  onClose,
}: {
  src: string
  textureSize: { width: number; height: number }
  currentUv: BossbarUv | null
  onClose: () => void
}) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  useBlockBrowserMouseGestures(stageRef)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const fittedRef = useRef(false)
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  viewRef.current = { zoom, panX: pan.x, panY: pan.y }

  useEffect(() => {
    fittedRef.current = false
    const stage = stageRef.current
    if (!stage) return
    const fit = () => {
      if (fittedRef.current) return
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const nextZoom = Math.max(0.1, Math.min(64, Math.min(rect.width / textureSize.width, rect.height / textureSize.height)))
      setZoom(nextZoom)
      setPan({
        x: (rect.width - textureSize.width * nextZoom) / 2,
        y: (rect.height - textureSize.height * nextZoom) / 2,
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
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewRef.current
      const rect = stage.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const nextZoom = Math.max(0.1, Math.min(64, current.zoom * (event.deltaY < 0 ? 1.25 : 1 / 1.25)))
      if (nextZoom === current.zoom) return
      const texX = (localX - current.panX) / current.zoom
      const texY = (localY - current.panY) / current.zoom
      setZoom(nextZoom)
      setPan({ x: localX - texX * nextZoom, y: localY - texY * nextZoom })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      className="bb-atlas-enlarge-backdrop"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <aside className="bb-atlas-enlarge" role="dialog" aria-modal="true" aria-label="图集放大预览">
        <div className="bb-atlas-enlarge-header">
          <strong>图集预览</strong>
          <span className="bb-tag">
            {textureSize.width}×{textureSize.height}
          </span>
          <label className="bb-toggle">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(event) => setShowGrid(event.target.checked)}
            />
            <span>网格</span>
          </label>
          <span className="bb-atlas-enlarge-spacer" />
          <Button onClick={onClose}>关闭</Button>
        </div>
        <div
          className="bb-atlas-enlarge-stage"
          ref={stageRef}
          data-panning={panning ? 'true' : undefined}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 2) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
            setPanning(true)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            const dx = event.clientX - drag.lastX
            const dy = event.clientY - drag.lastY
            drag.lastX = event.clientX
            drag.lastY = event.clientY
            setPan((previous) => ({ x: previous.x + dx, y: previous.y + dy }))
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            setPanning(false)
          }}
          onPointerCancel={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = null
            setPanning(false)
          }}
        >
          <div
            className="bb-atlas-enlarge-world"
            style={{
              left: pan.x,
              top: pan.y,
              width: textureSize.width * zoom,
              height: textureSize.height * zoom,
            }}
          >
            <img className="bb-atlas-enlarge-image" alt="" draggable={false} src={src} />
            {currentUv && (
              <div
                className="bb-atlas-uv"
                style={{
                  left: currentUv.x * zoom,
                  top: currentUv.y * zoom,
                  width: Math.max(1, currentUv.width * zoom),
                  height: Math.max(1, currentUv.height * zoom),
                }}
              />
            )}
            {showGrid && (
              <div
                className="bb-atlas-enlarge-grid"
                style={{ backgroundSize: `${zoom}px ${zoom}px` }}
              />
            )}
          </div>
          <div className="bb-atlas-enlarge-hud">滚轮缩放 · 拖动平移 · Esc 关闭</div>
        </div>
      </aside>
    </div>
  )
}

export function BossbarAtlasPanel({
  document,
  textureSize,
  target,
  readOnly,
  onTextureChange,
  onProblems,
  onOpenDetect,
}: {
  document: BossbarDocument
  textureSize: { width: number; height: number }
  target: BossbarUvTarget | null
  readOnly: boolean
  onTextureChange: (change: BossbarTextureChange) => void
  onProblems: (problems: string[]) => void
  onOpenDetect?: (slices: AtlasDetectSlice[]) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const appendInputRef = useRef<HTMLInputElement | null>(null)
  const loadVersionRef = useRef(0)
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 })
  const [stageHeight, setStageHeight] = useState(180)
  const [stageResizing, setStageResizing] = useState(false)
  const stageDragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [atlasBusy, setAtlasBusy] = useState(false)
  const [enlarged, setEnlarged] = useState(false)

  const currentUv = target ? uvOfTarget(document, target) : null
  const fitted = containRect(viewSize, textureSize)
  const src = textureSrc(document.texture)
  const portalRoot =
    (wrapRef.current?.closest('.bb-design') as HTMLElement | null) ??
    (typeof window !== 'undefined' ? window.document.body : null)

  useEffect(() => () => { loadVersionRef.current += 1 }, [document])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect()
      setViewSize({ width: rect.width, height: rect.height })
    })
    observer.observe(wrap)
    const rect = wrap.getBoundingClientRect()
    setViewSize({ width: rect.width, height: rect.height })
    return () => observer.disconnect()
  }, [stageHeight])

  const decodeFiles = async (files: File[], version: number): Promise<PngRgba[] | null> => {
    const additions: PngRgba[] = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (loadVersionRef.current !== version) return null
      const problem = validateAtlasPng(bytes)
      if (problem) {
        onProblems([problem])
        return null
      }
      const rgba = await decodeAtlasBytes(bytes)
      if (!rgba) {
        onProblems(['无法解码 PNG：' + file.name])
        return null
      }
      additions.push(rgba)
    }
    return additions
  }

  const replaceFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    const version = ++loadVersionRef.current
    if (list.length === 1) {
      const bytes = new Uint8Array(await list[0].arrayBuffer())
      if (loadVersionRef.current !== version) return
      const problem = validateAtlasPng(bytes)
      if (problem) {
        onProblems([problem])
        return
      }
      onProblems([])
      onTextureChange({ base64: encodeBase64(bytes) })
      return
    }
    setAtlasBusy(true)
    try {
      const additions = await decodeFiles(list, version)
      if (!additions || loadVersionRef.current !== version) return
      const packed = packAtlasImages(null, additions)
      if (!packed.ok) {
        onProblems([packed.error])
        return
      }
      onProblems([])
      onTextureChange({ base64: packed.base64, appended: packed.appended })
    } finally {
      if (loadVersionRef.current === version) setAtlasBusy(false)
    }
  }

  const appendFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    const version = ++loadVersionRef.current
    setAtlasBusy(true)
    try {
      const additions = await decodeFiles(list, version)
      if (!additions || loadVersionRef.current !== version) return
      let base: PngRgba | null = null
      const baseBytes = decodeBase64(document.texture)
      if (baseBytes) {
        const problem = validateAtlasPng(baseBytes)
        if (problem) {
          onProblems(['当前图集无效：' + problem])
          return
        }
        base = await decodeAtlasBytes(baseBytes)
        if (!base) {
          onProblems(['当前图集无法解码'])
          return
        }
      }
      if (loadVersionRef.current !== version) return
      const packed = appendAtlasFromRgba(document.texture, base, additions)
      if (!packed.ok) {
        onProblems([packed.error])
        return
      }
      onProblems([])
      onTextureChange({ base64: packed.base64, appended: packed.appended })
    } finally {
      if (loadVersionRef.current === version) setAtlasBusy(false)
    }
  }

  const runDetect = () => {
    void (async () => {
      const version = ++loadVersionRef.current
      setAtlasBusy(true)
      try {
        const image = await loadAtlasRgba(document.texture)
        if (loadVersionRef.current !== version) return
        if (!image) {
          onProblems(['当前图集无法解码，无法自动识别'])
          return
        }
        const regions = detectAtlasRegions(image)
        if (!regions.length) {
          onProblems(['未识别到足够大的不透明图块（宽高≥4、面积≥16）'])
          return
        }
        onProblems([])
        onOpenDetect?.(slicesFromRegions(regions))
      } finally {
        if (loadVersionRef.current === version) setAtlasBusy(false)
      }
    })()
  }

  return (
    <div className="bb-atlas">
      <div className="bb-atlas-view">
        <div className="bb-atlas-view-head">
          <strong>预览</strong>
          <span className="bb-tag">
            {textureSize.width}×{textureSize.height}
          </span>
          <span className="bb-atlas-view-spacer" />
          <button
            type="button"
            className="bb-atlas-zoom-btn"
            title="放大预览"
            aria-label="放大预览"
            disabled={!src}
            onClick={() => setEnlarged(true)}
          >
            🔍
          </button>
        </div>
        <div className="bb-atlas-preview" ref={wrapRef} style={{ height: stageHeight }}>
          {src ? (
            <img
              className="bb-atlas-preview-image"
              alt=""
              draggable={false}
              src={src}
              style={
                fitted
                  ? {
                      left: fitted.x,
                      top: fitted.y,
                      width: fitted.width,
                      height: fitted.height,
                    }
                  : undefined
              }
            />
          ) : (
            <Empty>无图集</Empty>
          )}
          {fitted && currentUv && (
            <div
              className="bb-atlas-uv"
              style={{
                left: fitted.x + currentUv.x * fitted.scale,
                top: fitted.y + currentUv.y * fitted.scale,
                width: Math.max(1, currentUv.width * fitted.scale),
                height: Math.max(1, currentUv.height * fitted.scale),
              }}
            />
          )}
        </div>
        <div
          className="bb-atlas-view-sash"
          data-active={stageResizing ? 'true' : undefined}
          title="拖动调整图集高度"
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
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
            setStageHeight(Math.max(100, Math.min(960, Math.round(next))))
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
      </div>

      <div className="bb-atlas-actions">
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/png"
          multiple
          hidden
          disabled={readOnly || atlasBusy}
          onChange={(event) => {
            const files = event.target.files
            if (files?.length) void replaceFiles(files)
            event.target.value = ''
          }}
        />
        <input
          ref={appendInputRef}
          type="file"
          accept="image/png"
          multiple
          hidden
          disabled={readOnly || atlasBusy}
          onChange={(event) => {
            const files = event.target.files
            if (files?.length) void appendFiles(files)
            event.target.value = ''
          }}
        />
        <Button disabled={readOnly || atlasBusy} onClick={() => replaceInputRef.current?.click()}>
          替换…
        </Button>
        <Button disabled={readOnly || atlasBusy} onClick={() => appendInputRef.current?.click()}>
          追加…
        </Button>
        <Button
          disabled={readOnly || atlasBusy || !onOpenDetect || !document.texture}
          onClick={runDetect}
        >
          识别图块…
        </Button>
      </div>

      <div className="bb-atlas-paste">
        <TextField
          mono
          label="粘贴 Base64"
          value={paste}
          placeholder="Base64 / data URL"
          disabled={readOnly || atlasBusy}
          onCommit={(text) => setPaste(text)}
        />
        <Button
          disabled={readOnly || atlasBusy || !paste.trim()}
          onClick={() => {
            setPasteError('')
            const bytes = base64ToBytes(paste)
            const info = bytes ? pngInfo(bytes) : null
            if (!bytes || !info) {
              setPasteError('粘贴内容不是有效的 Base64 PNG')
              return
            }
            onTextureChange({ base64: encodeBase64(bytes) })
            setPaste('')
          }}
        >
          应用
        </Button>
      </div>
      {pasteError && <p className="bb-warn">{pasteError}</p>}
      {atlasBusy ? (
        <p className="bb-hint">正在处理图集…</p>
      ) : (
        <p className="bb-hint">PNG ≤4MiB / ≤4096；多选竖排拼接；识别忽略过小碎块。</p>
      )}

      {enlarged && src && portalRoot
        ? createPortal(
            <AtlasEnlargeDialog
              src={src}
              textureSize={textureSize}
              currentUv={currentUv}
              onClose={() => setEnlarged(false)}
            />,
            portalRoot,
          )
        : null}
    </div>
  )
}
