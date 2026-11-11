import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
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
import { Button, Empty, Row, Section, TextField } from './BossbarEditorUi'

/**
 * Atlas panel: replace or append into the single PNG and show a fit preview of the current UV.
 * Editing happens in the UV picker dock, not here.
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
  const loadVersionRef = useRef(0)
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 })
  const [stageHeight, setStageHeight] = useState(220)
  const [stageResizing, setStageResizing] = useState(false)
  const stageDragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [atlasBusy, setAtlasBusy] = useState(false)

  const currentUv = target ? uvOfTarget(document, target) : null
  const fitted = containRect(viewSize, textureSize)
  const src = textureSrc(document.texture)

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

  /** 单张直接替换；多张先竖排拼成新图集再替换。 */
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

  return (
    <div className="bb-atlas">
      <Section
        className="bb-atlas-view"
        title="图集预览"
        extra={
          <span className="bb-tag">
            {textureSize.width}×{textureSize.height}
          </span>
        }
      >
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
          multiple
          disabled={readOnly || atlasBusy}
          onChange={(event) => {
            const files = event.target.files
            if (files?.length) void replaceFiles(files)
            event.target.value = ''
          }}
        />
        <p className="bb-hint">
          可多选 PNG（≤4MiB、≤4096）。单张直接替换并尽量保留旧 UV；多张会先竖排拼成新图集再替换。
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
            onTextureChange({ base64: encodeBase64(bytes) })
            setPaste('')
          }}
        >
          应用粘贴的图集
        </Button>
        {pasteError && <p className="bb-warn">{pasteError}</p>}
      </Section>

      <Section title="追加图集">
        <input
          type="file"
          accept="image/png"
          multiple
          disabled={readOnly || atlasBusy}
          onChange={(event) => {
            const files = event.target.files
            if (files?.length) void appendFiles(files)
            event.target.value = ''
          }}
        />
        <p className="bb-hint">
          多选 PNG，按选择顺序竖排拼到现有图集下方（间距 1px）。旧 UV 保留；若已选中纹理目标，会把第一张追加图的 UV 写进去。
        </p>
        {atlasBusy && <p className="bb-hint">正在处理图集…</p>}
      </Section>

      <Section title="自动识别">
        <Button
          disabled={readOnly || atlasBusy || !onOpenDetect || !document.texture}
          onClick={() => {
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
          }}
        >
          识别图块…
        </Button>
        <p className="bb-hint">
          按透明度连通域切 AABB，忽略过小碎块。弹窗里可调整框、指定背景或数值条后再写入画布。
        </p>
      </Section>
    </div>
  )
}
