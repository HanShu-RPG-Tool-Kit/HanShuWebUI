import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { ItemTextSegment } from './itemstack'
import type { ItemPresentation } from './itemTooltip'
import './KitEditor.css'

/** 原版文字阴影 = 前景色各通道 ÷ 4 */
function mcShadow(color: string, explicit?: string): string {
  if (explicit && /^#[0-9a-f]{8}$/i.test(explicit)) {
    const alpha = parseInt(explicit.slice(1, 3), 16) / 255
    return `1px 1px 0 rgba(${parseInt(explicit.slice(3, 5), 16)}, ${parseInt(explicit.slice(5, 7), 16)}, ${parseInt(explicit.slice(7, 9), 16)}, ${alpha})`
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (!hex) return '1px 1px 0 #3f3f3f'
  const channel = (offset: number) => Math.floor(parseInt(hex.slice(offset, offset + 2), 16) / 4)
  return `1px 1px 0 rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`
}

const OBFUSCATED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&?@'

function ObfuscatedText({ text }: { text: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 50)
    return () => window.clearInterval(timer)
  }, [])
  return <>{[...text].map((char) => char === ' ' ? ' ' : OBFUSCATED_CHARS[Math.floor(Math.random() * OBFUSCATED_CHARS.length)]).join('')}</>
}

export function ItemTipSegments({ segments, fallbackColor = '#FFFFFF', shadow = false }: {
  segments: ItemTextSegment[]
  fallbackColor?: string
  shadow?: boolean
}) {
  return <>
    {segments.map((segment, index) => {
      const color = segment.color || fallbackColor
      return <span
        key={index}
        style={{
          color,
          fontWeight: segment.bold ? 700 : undefined,
          fontStyle: segment.italic ? 'italic' : undefined,
          textDecoration: [segment.underlined && 'underline', segment.strikethrough && 'line-through'].filter(Boolean).join(' ') || undefined,
          textShadow: shadow ? mcShadow(color, segment.shadowColor) : undefined,
        }}
      >{segment.obfuscated ? <ObfuscatedText text={segment.text} /> : segment.text}</span>
    })}
  </>
}

function tipLines(id: string, presentation: ItemPresentation): ItemTextSegment[][] {
  if (presentation.hidden) return [[{ text: '（原版隐藏了此物品的提示框）', color: '#555555', italic: true }]]
  return id ? [...presentation.tooltip, [{ text: id, color: '#555555' }]] : presentation.tooltip
}

function sourceNote(presentation: ItemPresentation, locale?: string): string {
  if (presentation.source === 'snapshot') return ['游戏快照', locale].filter(Boolean).join(' · ')
  return [
    'WebUI 渲染',
    presentation.unrendered.length > 0 && `${presentation.unrendered.length} 个组件未显示`,
    presentation.iconStale && '图标为旧快照',
  ].filter(Boolean).join(' · ')
}

/** 光标箭头约占右下 12×20px；tooltip 整体放在光标右上方 */
const TIP_GAP_X = 40
const TIP_GAP_Y = 32

const TIP_SCALE_KEY = 'hanshu.kitTooltipScale'
const TIP_SCALE_MIN = 0.8
const TIP_SCALE_MAX = 2.5
const TIP_SCALE_DEFAULT = 1.25

const clampScale = (value: number) => Math.min(TIP_SCALE_MAX, Math.max(TIP_SCALE_MIN, Math.round(value * 20) / 20))

let tipScale = (() => {
  try {
    const saved = Number(localStorage.getItem(TIP_SCALE_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampScale(saved) : TIP_SCALE_DEFAULT
  } catch {
    return TIP_SCALE_DEFAULT
  }
})()
const tipScaleListeners = new Set<() => void>()

function setTipScale(value: number) {
  const next = clampScale(value)
  if (next === tipScale) return
  tipScale = next
  try { localStorage.setItem(TIP_SCALE_KEY, String(next)) } catch { /* 隐私模式等不可写时只在本次会话生效 */ }
  tipScaleListeners.forEach((listener) => listener())
}

export function useItemTipScale() {
  return useSyncExternalStore((listener) => {
    tipScaleListeners.add(listener)
    return () => { tipScaleListeners.delete(listener) }
  }, () => tipScale)
}

function ItemHoverTooltip({ id, presentation, locale, x, y, scale, showScale }: {
  id: string
  presentation: ItemPresentation
  locale?: string
  x: number
  y: number
  scale: number
  showScale: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: x + TIP_GAP_X, top: y - TIP_GAP_Y })
  const fallback = presentation.defaultColor

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    let left = x + TIP_GAP_X
    let top = y - TIP_GAP_Y - box.height / 2
    if (left + box.width > window.innerWidth - 4) left = Math.max(4, x - TIP_GAP_X - box.width)
    if (top + box.height > window.innerHeight - 4) top = window.innerHeight - 4 - box.height
    if (top < 4) top = 4
    setPlace({ left, top })
  }, [x, y, scale, showScale])

  return createPortal(<div ref={ref} className="kit-item-tip" role="tooltip" style={{ ...place, '--tip-scale': scale } as CSSProperties}>
    {tipLines(id, presentation).map((line, lineIndex) => (
      <div key={lineIndex} className="kit-item-tip-line">
        {line.length ? <ItemTipSegments segments={line} fallbackColor={fallback} shadow /> : '\u00a0'}
      </div>
    ))}
    <div className={`kit-item-tip-meta is-${presentation.source}`}>{sourceNote(presentation, locale)}</div>
    {showScale && <div className="kit-item-tip-meta">{Math.round(scale * 100)}% · Ctrl + 滚轮缩放</div>}
  </div>, document.body)
}

/** 悬浮目标：跟光标显示物品 tooltip，Ctrl+滚轮缩放（与礼包共用缩放偏好） */
export function ItemHoverTipTarget({ id, presentation, locale, className, children }: {
  id: string
  presentation: ItemPresentation
  locale?: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const scale = useItemTipScale()
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [showScale, setShowScale] = useState(false)
  const track = (event: MouseEvent) => setPointer({ x: event.clientX, y: event.clientY })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    let timer = 0
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      setTipScale(tipScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
      setShowScale(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setShowScale(false), 1200)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      node.removeEventListener('wheel', onWheel)
      window.clearTimeout(timer)
    }
  }, [])

  return <span
    ref={ref}
    className={className ?? 'kit-item-visual'}
    onMouseEnter={track}
    onMouseMove={track}
    onMouseLeave={() => { setPointer(null); setShowScale(false) }}
  >
    {children}
    {pointer && (
      <ItemHoverTooltip
        id={id}
        presentation={presentation}
        locale={locale}
        x={pointer.x}
        y={pointer.y}
        scale={scale}
        showScale={showScale}
      />
    )}
  </span>
}
