import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../../monaco/hanshuLanguage'
import { parseJsonValue } from '../../utils/strictJson'
import { useEditorFontSize } from './editorFont'
import { isObject } from './model'
import type { KitDocument, KitEffect, KitExperienceKind, KitFeedback, KitItem, KitPool, KitPoolEntry, KitPoolHit } from './kit'
import { createKitEffect, createKitItem, createKitPool, createKitPoolEntry, rollKitPools, stringifyKit } from './kit'
import {
  collectItemStackFiles,
  hasItemStackDrag,
  itemStackIconSrc,
  readItemStackFiles,
  type ItemTextSegment,
} from './itemstack'
import { presentItem, type ItemPresentation } from './itemTooltip'
import './KitEditor.css'

const toCount = (value: string) => Math.max(0, Math.floor(Number(value) || 0))
const replaceAt = <T,>(list: T[], index: number, value: T) => list.map((item, i) => i === index ? value : item)
const removeAt = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index)

function Panel({ title, count, action, className = '', children }: {
  title: string
  count?: number
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return <section className={`kit-panel ${className}`}>
    <header className="kit-panel-head">
      <h3>{title}</h3>
      {count !== undefined && <span className="kit-badge">{count}</span>}
      <div className="kit-panel-actions">{action}</div>
    </header>
    {children}
  </section>
}

function AddButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="kit-add" disabled={disabled} onClick={onClick}>
    <span aria-hidden>+</span>{label}
  </button>
}

function RemoveButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="kit-remove" disabled={disabled} aria-label={label} title={label} onClick={onClick}>
    <svg viewBox="0 0 16 16" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
  </button>
}

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

function TextSegments({ segments, fallbackColor = '#FFFFFF', shadow = false }: {
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

function ItemIcon({ item, presentation }: { item: KitItem; presentation: ItemPresentation }) {
  const icon = item.display?.icon
  const src = icon ? itemStackIconSrc(icon) : ''
  const mask = src ? { WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` } : undefined
  return <span className={`kit-item-icon${icon ? '' : ' is-empty'}${presentation.iconStale ? ' is-stale' : ''}`}>
    {icon
      ? <img src={src} alt="" width={28} height={28} draggable={false} />
      : <span className="kit-item-icon-fallback" aria-hidden />}
    {presentation.foil && <span className={`kit-item-glint${src ? '' : ' is-unmasked'}`} style={mask} aria-hidden />}
    {presentation.iconStale && <span className="kit-item-stale" aria-label="图标为旧快照" />}
    {item.count > 1 && <span className="kit-item-count">{item.count}</span>}
  </span>
}

function tooltipLines(item: KitItem, presentation: ItemPresentation): ItemTextSegment[][] {
  if (presentation.hidden) return [[{ text: '（原版隐藏了此物品的提示框）', color: '#555555', italic: true }]]
  return item.id ? [...presentation.tooltip, [{ text: item.id, color: '#555555' }]] : presentation.tooltip
}

/** 光标箭头约占右下 12×20px；tooltip 整体放在光标右上方，与箭头保持明显间隔 */
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

function useTipScale() {
  return useSyncExternalStore((listener) => {
    tipScaleListeners.add(listener)
    return () => { tipScaleListeners.delete(listener) }
  }, () => tipScale)
}

function sourceNote(item: KitItem, presentation: ItemPresentation): string {
  if (presentation.source === 'snapshot') return ['游戏快照', item.display?.locale].filter(Boolean).join(' · ')
  return [
    'WebUI 渲染',
    presentation.unrendered.length > 0 && `${presentation.unrendered.length} 个组件未显示`,
    presentation.iconStale && '图标为旧快照',
  ].filter(Boolean).join(' · ')
}

function ItemTooltip({ item, presentation, x, y, scale, showScale }: {
  item: KitItem
  presentation: ItemPresentation
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
    {tooltipLines(item, presentation).map((line, lineIndex) => (
      <div key={lineIndex} className="kit-item-tip-line">
        {line.length ? <TextSegments segments={line} fallbackColor={fallback} shadow /> : '\u00a0'}
      </div>
    ))}
    <div className={`kit-item-tip-meta is-${presentation.source}`}>{sourceNote(item, presentation)}</div>
    {showScale && <div className="kit-item-tip-meta">{Math.round(scale * 100)}% · Ctrl + 滚轮缩放</div>}
  </div>, document.body)
}

function ItemVisual({ item, presentation }: { item: KitItem; presentation: ItemPresentation }) {
  const ref = useRef<HTMLSpanElement>(null)
  const scale = useTipScale()
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

  return <span ref={ref} className="kit-item-visual" onMouseEnter={track} onMouseMove={track} onMouseLeave={() => { setPointer(null); setShowScale(false) }}>
    <ItemIcon item={item} presentation={presentation} />
    {pointer && <ItemTooltip item={item} presentation={presentation} x={pointer.x} y={pointer.y} scale={scale} showScale={showScale} />}
  </span>
}

async function acceptItemStacks(event: DragEvent, onItems: (items: KitItem[]) => void, onNotice: (message: string) => void) {
  event.preventDefault()
  event.stopPropagation()
  const files = collectItemStackFiles(event.dataTransfer)
  if (files.length === 0) {
    onNotice('请拖入 .itemstack 文件')
    return
  }
  const { items, errors } = await readItemStackFiles(files)
  if (items.length) onItems(items)
  if (errors.length) onNotice(errors.join('；'))
  else if (items.length) onNotice(`已导入 ${items.length} 个物品`)
}

function ItemDropZone({ disabled, hint, className = '', onDropItems, children }: {
  disabled?: boolean
  hint?: string
  className?: string
  onDropItems: (items: KitItem[]) => void
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const [notice, setNotice] = useState('')

  function onDragOver(event: DragEvent) {
    if (disabled || !hasItemStackDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  return <div
    className={`kit-drop${over ? ' is-over' : ''}${className ? ` ${className}` : ''}`}
    onDragEnter={onDragOver}
    onDragOver={onDragOver}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
    }}
    onDrop={(event) => {
      setOver(false)
      if (disabled) return
      void acceptItemStacks(event, onDropItems, (message) => {
        setNotice(message)
        window.setTimeout(() => setNotice((current) => current === message ? '' : current), 3200)
      })
    }}
  >
    {children}
    {(over || hint) && <p className={`kit-drop-hint${over ? ' is-over' : ''}`}>{over ? '松开以导入 .itemstack' : hint}</p>}
    {notice && <p className="kit-drop-notice" role="status">{notice}</p>}
  </div>
}

function ComponentsEditor({ value, disabled, onChange }: {
  value: Record<string, unknown>
  disabled?: boolean
  onChange: (value: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  function apply(text: string) {
    setDraft(text)
    try {
      const parsed = parseJsonValue(text.trim() || '{}')
      if (!isObject(parsed)) throw new Error('应为 JSON 对象')
      onChange(parsed)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return <div className="kit-components">
    <textarea
      spellCheck={false}
      disabled={disabled}
      rows={5}
      aria-label="物品组件 JSON"
      placeholder={'{\n  "minecraft:custom_name": "\\"传说之剑\\""\n}'}
      value={draft ?? (Object.keys(value).length ? JSON.stringify(value, null, 2) : '')}
      onChange={(event) => apply(event.target.value)}
      onBlur={() => { if (!error) setDraft(null) }}
    />
    {error && <p className="kit-error">{error}</p>}
  </div>
}

function ItemRow({ item, index, open, disabled, onToggle, onChange, onRemove, onDropReplace }: {
  item: KitItem
  index: number
  open: boolean
  disabled?: boolean
  onToggle: () => void
  onChange: (patch: Partial<KitItem>) => void
  onRemove: () => void
  onDropReplace: (items: KitItem[]) => void
}) {
  const componentCount = Object.keys(item.components).length
  const presentation = useMemo(() => presentItem(item), [item])
  const showName = !!item.display || Object.keys(item.components).some((key) => /(^|:)(custom_name|item_name)$/.test(key))
  const [over, setOver] = useState(false)

  function onDragOver(event: DragEvent) {
    if (disabled || !hasItemStackDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  return <li
    className={`kit-row kit-item${open ? ' is-open' : ''}${over ? ' is-drop' : ''}`}
    onDragEnter={onDragOver}
    onDragOver={onDragOver}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
    }}
    onDrop={(event) => {
      setOver(false)
      if (disabled) return
      void acceptItemStacks(event, onDropReplace, () => {})
    }}
  >
    <span className="kit-row-index">{index + 1}</span>
    <ItemVisual item={item} presentation={presentation} />
    <div className="kit-item-fields">
      <input className="kit-mono" value={item.id} disabled={disabled} placeholder="minecraft:diamond_sword" aria-label={`物品 ${index + 1} ID`} onChange={(event) => onChange({ id: event.target.value })} />
      {showName && <span className="kit-item-name"><TextSegments segments={presentation.name} fallbackColor={presentation.defaultColor} /></span>}
    </div>
    <input className="kit-num" type="number" min={0} step={1} value={item.count} disabled={disabled} aria-label={`物品 ${index + 1} 数量`} onChange={(event) => onChange({ count: toCount(event.target.value) })} />
    <button type="button" className={`kit-chip${componentCount ? ' has-value' : ''}`} aria-expanded={open} title="组件" onClick={onToggle}>
      {'{ }'}{componentCount > 0 && <span>{componentCount}</span>}
    </button>
    <RemoveButton label={`移除物品 ${index + 1}`} disabled={disabled} onClick={onRemove} />
    {open && <ComponentsEditor value={item.components} disabled={disabled} onChange={(components) => onChange({ components })} />}
  </li>
}

function ItemList({ items, header, disabled, onChange }: {
  items: KitItem[]
  header?: boolean
  disabled?: boolean
  onChange: (items: KitItem[]) => void
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set())

  function remove(index: number) {
    onChange(removeAt(items, index))
    setOpen((previous) => new Set([...previous].filter((i) => i !== index).map((i) => i > index ? i - 1 : i)))
  }
  function toggle(index: number) {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return <ItemDropZone disabled={disabled} hint={items.length === 0 ? '可从桌面拖入 .itemstack' : undefined} onDropItems={(dropped) => onChange([...items, ...dropped])}>
    {header && items.length > 0 && <div className="kit-row kit-item kit-row-head" aria-hidden><span /><span /><span>物品</span><span>数量</span><span>组件</span><span /></div>}
    {items.length === 0
      ? <p className="kit-empty">暂无物品 · 拖入 .itemstack 或点添加</p>
      : <ol className="kit-list">
        {items.map((item, index) => (
          <ItemRow
            key={`${item.id}:${index}`}
            item={item}
            index={index}
            open={open.has(index)}
            disabled={disabled}
            onToggle={() => toggle(index)}
            onChange={(patch) => onChange(replaceAt(items, index, { ...item, ...patch }))}
            onRemove={() => remove(index)}
            onDropReplace={(dropped) => {
              if (!dropped.length) return
              const next = [...items]
              next[index] = dropped[0]
              next.splice(index + 1, 0, ...dropped.slice(1))
              onChange(next)
            }}
          />
        ))}
      </ol>}
  </ItemDropZone>
}

function EffectRow({ effect, index, disabled, onChange, onRemove }: {
  effect: KitEffect
  index: number
  disabled?: boolean
  onChange: (patch: Partial<KitEffect>) => void
  onRemove: () => void
}) {
  return <li className="kit-row kit-effect">
    <span className="kit-row-index">{index + 1}</span>
    <input className="kit-mono" value={effect.id} disabled={disabled} placeholder="minecraft:speed" aria-label={`效果 ${index + 1} ID`} onChange={(event) => onChange({ id: event.target.value })} />
    <input className="kit-num" type="number" min={1} step={1} value={effect.amplifier + 1} disabled={disabled} aria-label={`效果 ${index + 1} 等级`} onChange={(event) => onChange({ amplifier: Math.max(0, toCount(event.target.value) - 1) })} />
    <label className="kit-suffix">
      <input className="kit-num" type="number" min={0} step={1} value={effect.duration || ''} placeholder="∞" disabled={disabled} aria-label={`效果 ${index + 1} 时长（秒）`} onChange={(event) => onChange({ duration: toCount(event.target.value) })} />
      <span>s</span>
    </label>
    <button type="button" className={`kit-chip${effect.particles ? ' has-value' : ''}`} aria-pressed={effect.particles} disabled={disabled} title={effect.particles ? '显示粒子' : '隐藏粒子'} onClick={() => onChange({ particles: !effect.particles })}>
      {effect.particles ? '显示' : '隐藏'}
    </button>
    <RemoveButton label={`移除效果 ${index + 1}`} disabled={disabled} onClick={onRemove} />
  </li>
}

function PoolCard({ pool, index, disabled, onChange, onRemove }: {
  pool: KitPool
  index: number
  disabled?: boolean
  onChange: (pool: KitPool) => void
  onRemove: () => void
}) {
  const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0)
  const setEntry = (entryIndex: number, entry: KitPoolEntry) => onChange({ ...pool, entries: replaceAt(pool.entries, entryIndex, entry) })

  return <div className="kit-pool">
    <div className="kit-pool-head">
      <span className="kit-pool-name">池 {index + 1}</span>
      <label className="kit-inline">
        每次领取抽
        <input className="kit-num" type="number" min={1} step={1} value={pool.rolls} disabled={disabled} aria-label={`池 ${index + 1} 抽取次数`} onChange={(event) => onChange({ ...pool, rolls: Math.max(1, toCount(event.target.value)) })} />
        次
      </label>
      <div className="kit-pool-actions">
        <AddButton label="分组" disabled={disabled} onClick={() => onChange({ ...pool, entries: [...pool.entries, createKitPoolEntry()] })} />
        <RemoveButton label={`移除池 ${index + 1}`} disabled={disabled} onClick={onRemove} />
      </div>
    </div>
    {pool.entries.length === 0 ? <p className="kit-empty">暂无分组</p> : pool.entries.map((entry, entryIndex) => (
      <div key={entryIndex} className="kit-pool-entry">
        <div className="kit-pool-entry-head">
          <label className="kit-inline">
            权重
            <input className="kit-num" type="number" min={0} step={1} value={entry.weight} disabled={disabled} aria-label={`分组 ${entryIndex + 1} 权重`} onChange={(event) => setEntry(entryIndex, { ...entry, weight: toCount(event.target.value) })} />
          </label>
          <span className="kit-chance">{total > 0 ? `${Math.round(entry.weight / total * 1000) / 10}%` : '—'}</span>
          <div className="kit-pool-actions">
            <AddButton label="物品" disabled={disabled} onClick={() => setEntry(entryIndex, { ...entry, items: [...entry.items, createKitItem()] })} />
            <RemoveButton label={`移除分组 ${entryIndex + 1}`} disabled={disabled} onClick={() => onChange({ ...pool, entries: removeAt(pool.entries, entryIndex) })} />
          </div>
        </div>
        <ItemList items={entry.items} disabled={disabled} onChange={(items) => setEntry(entryIndex, { ...entry, items })} />
      </div>
    ))}
  </div>
}

const itemLabel = (id: string) => id.trim().replace(/^minecraft:/, '') || '未填 ID'

function tallyItems(items: KitItem[], into: Map<string, number>) {
  for (const item of items) into.set(itemLabel(item.id), (into.get(itemLabel(item.id)) ?? 0) + item.count)
}

const TRIALS = 1000

type SimResult =
  | { kind: 'once'; hits: KitPoolHit[] }
  | { kind: 'many'; entryHits: number[][]; items: [string, number][] }

function PoolSimulator({ pools }: { pools: KitPool[] }) {
  const [result, setResult] = useState<SimResult | null>(null)

  function once() {
    setResult({ kind: 'once', hits: rollKitPools(pools) })
  }
  function many() {
    const entryHits = pools.map((pool) => pool.entries.map(() => 0))
    const items = new Map<string, number>()
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const hit of rollKitPools(pools)) {
        entryHits[hit.pool][hit.entry]++
        tallyItems(pools[hit.pool].entries[hit.entry].items, items)
      }
    }
    setResult({ kind: 'many', entryHits, items: [...items].sort((a, b) => b[1] - a[1]) })
  }

  return <div className="kit-sim">
    <div className="kit-sim-bar">
      <span className="kit-sim-title">模拟领取</span>
      <button type="button" className="kit-sim-btn" onClick={once}>抽一次</button>
      <button type="button" className="kit-sim-btn" onClick={many}>抽 {TRIALS} 次</button>
      {result && <button type="button" className="kit-sim-clear" onClick={() => setResult(null)}>清除</button>}
    </div>

    {result?.kind === 'once' && (result.hits.length === 0
      ? <p className="kit-sim-note">没有可抽取的分组（权重全为 0）</p>
      : <ul className="kit-sim-list">
        {result.hits.map((hit, index) => {
          const items = pools[hit.pool]?.entries[hit.entry]?.items ?? []
          return <li key={index}>
            <span className="kit-sim-tag">池 {hit.pool + 1}{(pools[hit.pool]?.rolls ?? 1) > 1 ? ` · 第 ${hit.roll + 1} 抽` : ''}</span>
            <span className="kit-sim-arrow">→ 分组 {hit.entry + 1}</span>
            <span className="kit-sim-items">{items.length ? items.map((item) => `${itemLabel(item.id)} ×${item.count}`).join('、') : '（空）'}</span>
          </li>
        })}
      </ul>)}

    {result?.kind === 'many' && <div className="kit-sim-stats">
      {pools.map((pool, poolIndex) => {
        const total = pool.entries.reduce((sum, entry) => sum + entry.weight, 0)
        const draws = (result.entryHits[poolIndex] ?? []).reduce((sum, value) => sum + value, 0)
        return <div key={poolIndex} className="kit-sim-pool">
          <span className="kit-sim-tag">池 {poolIndex + 1}</span>
          {pool.entries.map((entry, entryIndex) => {
            const actual = draws ? (result.entryHits[poolIndex]?.[entryIndex] ?? 0) / draws : 0
            const expected = total ? entry.weight / total : 0
            return <div key={entryIndex} className="kit-sim-bar-row">
              <span>分组 {entryIndex + 1}</span>
              <span className="kit-sim-meter"><i style={{ width: `${actual * 100}%` }} /><b style={{ left: `${expected * 100}%` }} /></span>
              <span className="kit-sim-pct">{(actual * 100).toFixed(1)}%</span>
              <span className="kit-sim-exp">理论 {(expected * 100).toFixed(1)}%</span>
            </div>
          })}
        </div>
      })}
      {result.items.length > 0 && <div className="kit-sim-avg">
        <span className="kit-sim-tag">平均每次领取获得</span>
        <ul>
          {result.items.map(([id, count]) => <li key={id}><span className="kit-mono">{id}</span><b>×{(count / TRIALS).toFixed(2)}</b></li>)}
        </ul>
      </div>}
    </div>}
  </div>
}

function FeedbackForm({ feedback, disabled, onChange }: {
  feedback: KitFeedback
  disabled?: boolean
  onChange: (patch: Partial<KitFeedback>) => void
}) {
  const field = (key: keyof KitFeedback, label: string, placeholder: string, mono = false) => (
    <label className="kit-field">
      <span>{label}</span>
      <input className={mono ? 'kit-mono' : undefined} value={feedback[key]} disabled={disabled} placeholder={placeholder} onChange={(event) => onChange({ [key]: event.target.value })} />
    </label>
  )
  return <div className="kit-form">
    {field('message', '消息', '你领取了新手礼包')}
    <div className="kit-form-pair">
      {field('title', '标题', '欢迎')}
      {field('subtitle', '副标题', '祝你旅途愉快')}
    </div>
    {field('sound', '音效', 'minecraft:entity.player.levelup', true)}
  </div>
}

function ExperienceField({ kind, amount, disabled, onChange }: {
  kind: KitExperienceKind
  amount: number
  disabled?: boolean
  onChange: (next: { kind: KitExperienceKind; amount: number }) => void
}) {
  return <div className="kit-xp">
    <span className="kit-xp-label">给予</span>
    <div className="kit-xp-control">
      <input type="number" min={0} step={1} value={amount} disabled={disabled} aria-label={kind === 'levels' ? '等级' : '经验'} onChange={(event) => onChange({ kind, amount: toCount(event.target.value) })} />
      <div className="kit-segment" role="radiogroup" aria-label="经验单位">
        {(['levels', 'points'] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'is-active' : ''} disabled={disabled} onClick={() => onChange({ kind: value, amount })}>
            {value === 'levels' ? '等级' : '经验'}
          </button>
        ))}
      </div>
    </div>
  </div>
}

export function KitEditor({ kit, error, disabled, editorPath, onChange }: {
  kit: KitDocument
  error?: string
  disabled?: boolean
  editorPath?: string
  onChange: (source: string) => void
}) {
  const update = (patch: Partial<KitDocument>) => onChange(stringifyKit({ ...kit, ...patch }))
  const fontSize = useEditorFontSize()

  return <div className="kit-editor">
    <div className="kit-page">
      {error && <p className="kit-banner" role="alert">草稿无法解析，已显示空表单：{error}</p>}

      <header className="kit-header">
        <input className="kit-title" value={kit.name} disabled={disabled} placeholder="未命名礼包" aria-label="项目名" onChange={(event) => update({ name: event.target.value })} />
        <ExperienceField kind={kit.experience.kind} amount={kit.experience.amount} disabled={disabled} onChange={(experience) => update({ experience })} />
      </header>

      <div className="kit-columns">
        <div className="kit-stack">
          <Panel title="物品" count={kit.items.length} action={<AddButton label="添加" disabled={disabled} onClick={() => update({ items: [...kit.items, createKitItem()] })} />}>
            <ItemList items={kit.items} header disabled={disabled} onChange={(items) => update({ items })} />
          </Panel>

          <Panel title="随机池" count={kit.pools.length} action={<AddButton label="添加" disabled={disabled} onClick={() => update({ pools: [...kit.pools, createKitPool()] })} />}>
            <p className="kit-hint">
              每个池独立抽取：每抽一次按权重选中<b>一个分组</b>，发放该组的全部物品；同一分组可被重复抽中。
            </p>
            {kit.pools.length === 0 ? <p className="kit-empty">暂无随机池</p> : <>
              <div className="kit-pools">
                {kit.pools.map((pool, index) => (
                  <PoolCard key={index} pool={pool} index={index} disabled={disabled} onChange={(next) => update({ pools: replaceAt(kit.pools, index, next) })} onRemove={() => update({ pools: removeAt(kit.pools, index) })} />
                ))}
              </div>
              <PoolSimulator pools={kit.pools} />
            </>}
          </Panel>

          <Panel title="药水效果" count={kit.effects.length} action={<AddButton label="添加" disabled={disabled} onClick={() => update({ effects: [...kit.effects, createKitEffect()] })} />}>
            {kit.effects.length === 0 ? <p className="kit-empty">暂无效果</p> : <>
              <div className="kit-row kit-effect kit-row-head" aria-hidden><span /><span>效果 ID</span><span>等级</span><span>时长</span><span>粒子</span><span /></div>
              <ol className="kit-list">
                {kit.effects.map((effect, index) => (
                  <EffectRow key={index} effect={effect} index={index} disabled={disabled} onChange={(patch) => update({ effects: replaceAt(kit.effects, index, { ...effect, ...patch }) })} onRemove={() => update({ effects: removeAt(kit.effects, index) })} />
                ))}
              </ol>
            </>}
          </Panel>

          <Panel title="指令" count={kit.commands.length} action={<AddButton label="添加" disabled={disabled} onClick={() => update({ commands: [...kit.commands, ''] })} />}>
            {kit.commands.length === 0 ? <p className="kit-empty">暂无指令</p> : (
              <ol className="kit-list">
                {kit.commands.map((command, index) => (
                  <li key={index} className="kit-row kit-command">
                    <span className="kit-row-index">{index + 1}</span>
                    <input className="kit-mono" value={command} disabled={disabled} placeholder="give @s minecraft:apple 1" aria-label={`指令 ${index + 1}`} onChange={(event) => update({ commands: replaceAt(kit.commands, index, event.target.value) })} />
                    <RemoveButton label={`移除指令 ${index + 1}`} disabled={disabled} onClick={() => update({ commands: removeAt(kit.commands, index) })} />
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="kit-aside">
          <Panel title="领取反馈">
            <FeedbackForm feedback={kit.feedback} disabled={disabled} onChange={(patch) => update({ feedback: { ...kit.feedback, ...patch } })} />
          </Panel>

          <Panel title="脚本" className="kit-script" action={<span className="kit-lang">Python</span>}>
            <div className={`kit-script-body${disabled ? ' is-disabled' : ''}`}>
              <Editor
                height="100%"
                language="python"
                theme={HANSHU_THEME_ID}
                value={kit.script}
                path={editorPath ?? 'progress-kit-script://kit.py'}
                beforeMount={registerHanshuLanguage}
                onChange={(value) => { if (!disabled) update({ script: value ?? '' }) }}
                options={{
                  fontSize,
                  mouseWheelZoom: true,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  lineNumbersMinChars: 3,
                  renderLineHighlight: 'line',
                  overviewRulerLanes: 0,
                  padding: { top: 10, bottom: 10 },
                  readOnly: disabled,
                }}
              />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  </div>
}
