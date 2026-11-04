import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  BOSSBAR_LIMITS,
  isDisplayRegion,
  type BossbarDocument,
  type BossbarPaint,
  type BossbarUv,
} from '../protocol'
import { base64ToBytes, encodeBase64, pngInfo } from '../png'
import { Button, Empty, Row, Section, TextField } from './BossbarEditorUi'

/**
 * Atlas panel: replace the single PNG and show a fit preview of the current UV.
 * Editing happens in the UV picker dock, not here.
 */

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

export function BossbarAtlasPanel({
  document,
  textureSize,
  target,
  readOnly,
  onTextureChange,
  onProblems,
}: {
  document: BossbarDocument
  textureSize: { width: number; height: number }
  target: BossbarUvTarget | null
  readOnly: boolean
  onTextureChange: (base64: string) => void
  onProblems: (problems: string[]) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const loadVersionRef = useRef(0)
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 })
  const [stageHeight, setStageHeight] = useState(220)
  const [stageResizing, setStageResizing] = useState(false)
  const stageDragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState('')

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
          disabled={readOnly}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.target.value = ''
          }}
        />
        <p className="bb-hint">PNG ≤4MiB、≤4096×4096。替换保留现有 UV。</p>
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
    </div>
  )
}
