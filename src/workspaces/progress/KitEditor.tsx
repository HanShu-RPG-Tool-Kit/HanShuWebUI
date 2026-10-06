import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../../monaco/hanshuLanguage'
import { parseJsonValue } from '../../utils/strictJson'
import { useEditorFontSize } from './editorFont'
import { isObject } from './model'
import type { KitCatalog, KitDocument, KitEffect, KitExperience, KitFeedback, KitItem, KitModifier, KitMods, KitParam, KitParamKind, KitPool, KitPoolEntry, KitPoolHit } from './kit'
import { KIT_NUMBER_RULES, activeKitModifiers, activeKitParams, createKitEffect, createKitItem, createKitModifier, createKitParam, createKitPool, createKitPoolEntry, flattenKit, isKitBindingId, normalizeKitRef, normalizeKitTag, resolveKit, rollKitPools, stringifyKit, unionKitTags } from './kit'
import { interpolateKitText, resolveKitNumber, type KitModifierEnv, type KitNumberRule } from './kitExpr'
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

function Panel({ title, subtitle, count, action, className = '', children }: {
  title: string
  subtitle?: string
  count?: number
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return <section className={`kit-panel ${className}`}>
    <header className="kit-panel-head">
      <h3>{title}</h3>
      {count !== undefined && <span className="kit-badge">{count}</span>}
      {subtitle && <span className="kit-panel-sub">{subtitle}</span>}
      <div className="kit-panel-actions">{action}</div>
    </header>
    {children}
  </section>
}

type KitExprUi = {
  env: KitModifierEnv
  modifiers: { id: string; label: string }[]
  /** 编译结果：字段已是最终值，ƒ 只标注用过的修饰器 */
  applied?: boolean
}

const KitExprContext = createContext<KitExprUi | null>(null)

const formatNumber = (value: number) => Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)

function setMod<K extends string>(mods: KitMods<K> | undefined, key: K, id: string): KitMods<K> | undefined {
  const next: KitMods<K> = { ...mods }
  if (id) next[key] = id
  else delete next[key]
  return Object.keys(next).length > 0 ? next : undefined
}

/** 数值字段旁的 ƒ：绑定修饰器后显示 id 与最终值；用透明原生 select 承载下拉，避免被面板裁切 */
function ModChip({ raw, mod, rule, label, skip, disabled, onChange }: {
  raw: number
  mod?: string
  rule: KitNumberRule
  label: string
  /** 该 raw 不经修饰器（如时长 0 = 无限） */
  skip?: boolean
  disabled?: boolean
  onChange: (mod: string) => void
}) {
  const ui = useContext(KitExprContext)
  if (!ui) return null
  const bound = (mod ?? '').trim()
  if (ui.applied) {
    if (!bound || skip) return null
    return <span className="kit-mod is-bound is-applied" title={`已应用修饰器 ${bound}`}>
      <span className="kit-mod-face"><i>ƒ</i><em>{bound}</em></span>
    </span>
  }
  const result = bound && !skip ? resolveKitNumber(raw, bound, ui.env, rule) : null
  const known = ui.modifiers.some((item) => item.id === bound)
  const state = !bound ? (ui.modifiers.length ? '' : ' is-idle') : result?.error ? ' is-error' : result?.warning ? ' is-warn' : ' is-bound'
  const title = !bound
    ? ui.modifiers.length ? `${label}：绑定修饰器` : '先在「修饰器」卡片中声明修饰器'
    : skip ? `${bound}：原值不经修饰器`
      : result?.error ?? result?.warning ?? `${bound}(${formatNumber(raw)}) → ${formatNumber(result!.value)}`

  return <span className={`kit-mod${state}`} title={title}>
    <span className="kit-mod-face" aria-hidden>
      <i>ƒ</i>
      {bound && <em>{bound}</em>}
      {result && <b>{formatNumber(result.value)}</b>}
    </span>
    <select value={bound} disabled={disabled} aria-label={`${label} 修饰器`} onChange={(event) => onChange(event.target.value)}>
      <option value="">不绑定</option>
      {ui.modifiers.map((item) => <option key={item.id} value={item.id}>{item.label ? `${item.id} · ${item.label}` : item.id}</option>)}
      {bound && !known && <option value={bound}>{bound}（不存在）</option>}
    </select>
  </span>
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
    <span className="kit-numbind">
      <input className="kit-num" type="number" min={0} step={1} value={item.count} disabled={disabled} aria-label={`物品 ${index + 1} 数量`} onChange={(event) => onChange({ count: toCount(event.target.value) })} />
      <ModChip raw={item.count} mod={item.mods?.count} rule={KIT_NUMBER_RULES.count} label={`物品 ${index + 1} 数量`} disabled={disabled} onChange={(id) => onChange({ mods: setMod(item.mods, 'count', id) })} />
    </span>
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
    <span className="kit-numbind">
      <input className="kit-num" type="number" min={1} step={1} value={effect.amplifier + 1} disabled={disabled} aria-label={`效果 ${index + 1} 等级`} onChange={(event) => onChange({ amplifier: Math.max(0, toCount(event.target.value) - 1) })} />
      <ModChip raw={effect.amplifier + 1} mod={effect.mods?.amplifier} rule={KIT_NUMBER_RULES.level} label={`效果 ${index + 1} 等级`} disabled={disabled} onChange={(id) => onChange({ mods: setMod(effect.mods, 'amplifier', id) })} />
    </span>
    <span className="kit-numbind">
      <label className="kit-suffix">
        <input className="kit-num" type="number" min={0} step={1} value={effect.duration || ''} placeholder="∞" disabled={disabled} aria-label={`效果 ${index + 1} 时长（秒）`} onChange={(event) => onChange({ duration: toCount(event.target.value) })} />
        <span>s</span>
      </label>
      <ModChip raw={effect.duration} mod={effect.mods?.duration} rule={KIT_NUMBER_RULES.duration} skip={effect.duration === 0} label={`效果 ${index + 1} 时长`} disabled={disabled} onChange={(id) => onChange({ mods: setMod(effect.mods, 'duration', id) })} />
    </span>
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
      <ModChip raw={pool.rolls} mod={pool.mods?.rolls} rule={KIT_NUMBER_RULES.rolls} label={`池 ${index + 1} 抽取次数`} disabled={disabled} onChange={(id) => onChange({ ...pool, mods: setMod(pool.mods, 'rolls', id) })} />
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
          <ModChip raw={entry.weight} mod={entry.mods?.weight} rule={KIT_NUMBER_RULES.weight} label={`分组 ${entryIndex + 1} 权重`} disabled={disabled} onChange={(id) => setEntry(entryIndex, { ...entry, mods: setMod(entry.mods, 'weight', id) })} />
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

function ExperienceField({ experience, disabled, onChange }: {
  experience: KitExperience
  disabled?: boolean
  onChange: (next: KitExperience) => void
}) {
  const { kind, amount } = experience
  return <div className="kit-xp">
    <span className="kit-xp-label">给予</span>
    <div className="kit-xp-control">
      <input type="number" min={0} step={1} value={amount} disabled={disabled} aria-label={kind === 'levels' ? '等级' : '经验'} onChange={(event) => onChange({ ...experience, amount: toCount(event.target.value) })} />
      <div className="kit-segment" role="radiogroup" aria-label="经验单位">
        {(['levels', 'points'] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? 'is-active' : ''} disabled={disabled} onClick={() => onChange({ ...experience, kind: value })}>
            {value === 'levels' ? '等级' : '经验'}
          </button>
        ))}
      </div>
    </div>
    <ModChip raw={amount} mod={experience.mods?.amount} rule={KIT_NUMBER_RULES.amount} label="经验" disabled={disabled} onChange={(id) => onChange({ ...experience, mods: setMod(experience.mods, 'amount', id) })} />
  </div>
}

function CompositionBar({ kit, selfRef, options, disabled, onChange }: {
  kit: KitDocument
  selfRef: string
  options: { ref: string; label: string }[]
  disabled?: boolean
  onChange: (patch: Pick<KitDocument, 'extends' | 'includes'>) => void
}) {
  const self = normalizeKitRef(selfRef)
  const parent = normalizeKitRef(kit.extends)
  const included = kit.includes.map(normalizeKitRef)
  const others = options.filter((option) => option.ref !== self)
  const nextInclude = others.find((option) => !included.includes(option.ref) && option.ref !== parent)
  const empty = others.length === 0 && !parent && kit.includes.length === 0

  return <div className="kit-compose-bar">
    <label className="kit-compose-slot" title="继承：父礼包先展开；物品等内容卡有内容则整张覆盖；超参数与修饰器按标识符覆盖；标签与父礼包并集">
      <span className="kit-compose-key">继承</span>
      <select
        value={parent}
        disabled={disabled || (others.length === 0 && !parent)}
        aria-label="继承父礼包"
        onChange={(event) => onChange({ extends: event.target.value, includes: kit.includes })}
      >
        <option value="">无</option>
        {others.map((option) => <option key={option.ref} value={option.ref}>{option.label}</option>)}
        {parent && !others.some((option) => option.ref === parent) && <option value={parent}>{parent}（不存在）</option>}
      </select>
    </label>
    <div className="kit-compose-slot is-wide" title="组合：按顺序追加物品 / 随机池 / 效果 / 指令；超参数与修饰器按 id 并入；不改宿主标签">
      <span className="kit-compose-key">组合</span>
      {kit.includes.map((ref, index) => (
        <span key={`${ref}-${index}`} className="kit-compose-chip">
          <select
            value={normalizeKitRef(ref)}
            disabled={disabled}
            aria-label={`组合礼包 ${index + 1}`}
            onChange={(event) => onChange({ extends: kit.extends, includes: replaceAt(kit.includes, index, event.target.value) })}
          >
            {others.map((option) => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            {!others.some((option) => option.ref === normalizeKitRef(ref)) && <option value={normalizeKitRef(ref)}>{normalizeKitRef(ref)}（不存在）</option>}
          </select>
          <RemoveButton label={`移除组合 ${ref}`} disabled={disabled} onClick={() => onChange({ extends: kit.extends, includes: removeAt(kit.includes, index) })} />
        </span>
      ))}
      <AddButton label="" disabled={disabled || !nextInclude} onClick={() => { if (nextInclude) onChange({ extends: kit.extends, includes: [...kit.includes, nextInclude.ref] }) }} />
      {empty && <span className="kit-compose-empty">新建其它 .kit 后可继承或组合</span>}
    </div>
  </div>
}

/** 礼包标签录入：交互对齐皮肤管理器 TagPicker（chip + 回车） */
function KitTagField({ tags, disabled, readOnly, onChange }: {
  tags: string[]
  disabled?: boolean
  readOnly?: boolean
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const locked = disabled || readOnly
  const selected = unionKitTags(tags)

  const addTag = (raw: string) => {
    if (locked) return
    const tag = normalizeKitTag(raw)
    if (!tag) return
    onChange(unionKitTags(selected, [tag]))
    setDraft('')
  }

  const removeTag = (name: string) => {
    if (locked) return
    onChange(selected.filter((item) => item.toLowerCase() !== name.toLowerCase()))
    inputRef.current?.focus()
  }

  return <div className="kit-tags-row">
    <span className="kit-tags-label" title="游戏标签：引擎可按标签查询发放；继承与父并集，组合不并入">标签</span>
    <div
      className={`kit-tag-picker${locked ? ' is-disabled' : ''}${selected.length === 0 && !draft ? ' is-empty' : ''}`}
      onClick={() => { if (!locked) inputRef.current?.focus() }}
    >
      {selected.map((name) => (
        <span key={name.toLowerCase()} className="kit-tag-chip">
          <span className="kit-tag-chip-label">{name}</span>
          {!readOnly && (
            <button
              type="button"
              className="kit-tag-chip-remove"
              aria-label={`移除标签 ${name}`}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => { event.stopPropagation(); removeTag(name) }}
            >×</button>
          )}
        </span>
      ))}
      {!readOnly && (
        <input
          ref={inputRef}
          type="text"
          className="kit-tag-input"
          value={draft}
          disabled={disabled}
          placeholder={selected.length === 0 ? '输入标签后回车，如 daily 或 event/summer' : ''}
          aria-label="添加礼包标签"
          onChange={(event) => setDraft(event.target.value.replace(/[\r\n]/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addTag(draft)
              return
            }
            if (event.key === 'Backspace' && draft.length === 0 && selected.length > 0) {
              event.preventDefault()
              removeTag(selected[selected.length - 1]!)
            }
          }}
          onBlur={() => { if (draft.trim()) addTag(draft) }}
        />
      )}
      {readOnly && selected.length === 0 && <span className="kit-tag-empty">无</span>}
    </div>
  </div>
}


function ParamPanel({ params, preview, disabled, onChange, onPreview }: {
  params: KitParam[]
  preview: Record<string, unknown>
  disabled?: boolean
  onChange: (params: KitParam[]) => void
  onPreview: (id: string, value: unknown) => void
}) {
  const setParam = (index: number, patch: Partial<KitParam>) => {
    const current = params[index]
    if (!current) return
    let next: KitParam = { ...current, ...patch }
    if (patch.kind && patch.kind !== current.kind) {
      next = { ...createKitParam(next.id, patch.kind), hint: next.hint }
    }
    onChange(replaceAt(params, index, next))
  }

  if (params.length === 0) return <p className="kit-empty">暂无超参数</p>

  return <div className="kit-table-wrap">
    <table className="kit-table">
      <thead>
        <tr>
          <th className="kit-col-id">标识符</th>
          <th className="kit-col-kind">类型</th>
          <th>默认值</th>
          <th title="仅用于编辑器预览，不写入文件">预览值</th>
          <th>说明</th>
          <th className="kit-col-x" />
        </tr>
      </thead>
      <tbody>
        {params.map((param, index) => {
          const ignored = !isKitBindingId(param.id)
          const override = ignored ? undefined : preview[param.id]
          return <tr key={index} className={ignored ? 'is-ignored' : undefined} title={ignored ? '未填标识符，此行被无视' : undefined}>
            <td className="kit-col-id">
              <input className="kit-mono" value={param.id} disabled={disabled} placeholder="必填 id" aria-label={`超参数标识符 ${index + 1}`} onChange={(event) => setParam(index, { id: event.target.value.trim() })} />
            </td>
            <td className="kit-col-kind">
              <select value={param.kind} disabled={disabled} aria-label={`超参数类型 ${index + 1}`} onChange={(event) => setParam(index, { kind: event.target.value as KitParamKind })}>
                <option value="float">float</option>
                <option value="int">int</option>
                <option value="string">string</option>
                <option value="bool">bool</option>
              </select>
            </td>
            <td>
              {param.kind === 'bool' ? (
                <select value={param.default ? 'true' : 'false'} disabled={disabled} aria-label={`超参数默认值 ${index + 1}`} onChange={(event) => setParam(index, { default: event.target.value === 'true' })}>
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : (
                <input
                  className={param.kind === 'string' ? undefined : 'kit-mono'}
                  type={param.kind === 'string' ? 'text' : 'number'}
                  step={param.kind === 'float' ? 'any' : 1}
                  value={String(param.default)}
                  disabled={disabled}
                  aria-label={`超参数默认值 ${index + 1}`}
                  onChange={(event) => {
                    if (param.kind === 'string') setParam(index, { default: event.target.value })
                    else if (param.kind === 'int') setParam(index, { default: Math.trunc(Number(event.target.value) || 0) })
                    else setParam(index, { default: Number(event.target.value) || 0 })
                  }}
                />
              )}
            </td>
            <td className={override !== undefined ? 'is-override' : undefined}>
              {param.kind === 'bool' ? (
                <select value={override === undefined ? '' : override ? 'true' : 'false'} disabled={ignored} aria-label={`超参数预览值 ${index + 1}`} onChange={(event) => onPreview(param.id, event.target.value === '' ? undefined : event.target.value === 'true')}>
                  <option value="">默认</option>
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              ) : (
                <input
                  className={param.kind === 'string' ? undefined : 'kit-mono'}
                  type={param.kind === 'string' ? 'text' : 'number'}
                  step={param.kind === 'float' ? 'any' : 1}
                  value={override === undefined ? '' : String(override)}
                  placeholder={String(param.default)}
                  disabled={ignored}
                  aria-label={`超参数预览值 ${index + 1}`}
                  onChange={(event) => {
                    const text = event.target.value
                    if (text === '') onPreview(param.id, undefined)
                    else onPreview(param.id, param.kind === 'string' ? text : Number(text))
                  }}
                />
              )}
            </td>
            <td>
              <input value={param.hint} disabled={disabled} placeholder="奖励强度" aria-label={`超参数说明 ${index + 1}`} onChange={(event) => setParam(index, { hint: event.target.value })} />
            </td>
            <td className="kit-col-x">
              <RemoveButton label={`移除超参数 ${param.id || index + 1}`} disabled={disabled} onClick={() => onChange(removeAt(params, index))} />
            </td>
          </tr>
        })}
      </tbody>
    </table>
  </div>
}

const SPARK_SAMPLES = 64

function Sparkline({ points }: { points: (number | null)[] }) {
  const values = points.filter((value): value is number => value !== null)
  if (values.length === 0) return <div className="kit-spark is-empty">无可绘制的点</div>
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const y = (value: number) => 36 - (value - lo) / (hi - lo) * 32
  const segments: string[] = []
  let current: string[] = []
  points.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current.join(' '))
      current = []
      return
    }
    current.push(`${(index / (points.length - 1) * 100).toFixed(2)},${y(value).toFixed(2)}`)
  })
  if (current.length) segments.push(current.join(' '))
  const zero = lo < 0 && hi > 0 ? y(0) : null

  return <div className="kit-spark">
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      {zero !== null && <line className="kit-spark-zero" x1="0" x2="100" y1={zero} y2={zero} />}
      {segments.map((segment, index) => <polyline key={index} points={segment} />)}
    </svg>
    <span className="kit-spark-hi">{formatNumber(hi)}</span>
    <span className="kit-spark-lo">{formatNumber(lo)}</span>
  </div>
}

function ModifierPreview({ modifier, env, error, ignored, range, onRange }: {
  modifier: KitModifier
  env: KitModifierEnv
  error?: string
  ignored: boolean
  range: number
  onRange: (range: number) => void
}) {
  const ready = !ignored && !error && env.ready.has(modifier.id)
  const curve = useMemo(() => {
    if (!ready) return null
    const sample = (x: number) => {
      try { return env.apply(modifier.id, x) } catch { return null }
    }
    const points = Array.from({ length: SPARK_SAMPLES }, (_, i) => sample(i / (SPARK_SAMPLES - 1) * range))
    const marks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const x = Math.round(t * range * 1000) / 1000
      return { x, value: sample(x) }
    })
    return { points, marks }
  }, [ready, env, modifier.id, range])

  return <div className="kit-mod-preview">
    {ignored && <p className="kit-modifier-msg is-muted">未填标识符：此修饰器被无视，不能被绑定或调用。</p>}
    {error && <p className="kit-modifier-msg is-error" role="alert">{error}</p>}
    {curve && <>
      <Sparkline points={curve.points} />
      <div className="kit-mod-preview-side">
        <dl className="kit-modifier-marks">
          {curve.marks.map((mark) => (
            <div key={mark.x}>
              <dt>x={formatNumber(mark.x)}</dt>
              <dd>{mark.value === null ? '错误' : formatNumber(mark.value)}</dd>
            </div>
          ))}
        </dl>
        <label className="kit-inline">
          x ∈ [0,
          <input className="kit-num" type="number" min={1} step={1} value={range} aria-label="预览 x 上限" onChange={(event) => onRange(Math.max(1, Number(event.target.value) || 1))} />
          ]
        </label>
      </div>
    </>}
  </div>
}

function ModifierPanel({ modifiers, env, disabled, onChange }: {
  modifiers: KitModifier[]
  env: KitModifierEnv
  disabled?: boolean
  onChange: (modifiers: KitModifier[]) => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [range, setRange] = useState(10)
  const declErrorOf = (id: string) => id && !env.declared.has(id) ? env.errors.find((message) => message.includes(`「${id}」`)) : undefined

  if (modifiers.length === 0) return <p className="kit-empty">暂无修饰器</p>

  return <div className="kit-mods">
    <div className="kit-mods-row kit-mods-head" aria-hidden>
      <span>标识符</span><span /><span>表达式</span><span>名称</span><span /><span />
    </div>
    {modifiers.map((modifier, index) => {
      const ignored = !isKitBindingId(modifier.id)
      const error = ignored ? undefined : declErrorOf(modifier.id) ?? env.modifierErrors.get(modifier.id)?.message
      const isOpen = selected === index
      const state = ignored ? 'is-ignored' : error ? 'is-error' : 'is-ok'
      const set = (patch: Partial<KitModifier>) => onChange(replaceAt(modifiers, index, { ...modifier, ...patch }))
      return <div key={index} className={`kit-mods-item ${state}${isOpen ? ' is-open' : ''}`} onFocus={() => setSelected(index)}>
        <div className="kit-mods-row">
          <input className="kit-mono kit-mods-id" value={modifier.id} disabled={disabled} placeholder="必填 id" aria-label={`修饰器 ${index + 1} 标识符`} onChange={(event) => set({ id: event.target.value.trim() })} />
          <span className="kit-mods-eq">(x) =</span>
          <input className="kit-mono kit-mods-expr" value={modifier.expr} disabled={disabled} spellCheck={false} placeholder="x * intensity" aria-label={`修饰器 ${index + 1} 表达式`} aria-invalid={Boolean(error)} title={error} onChange={(event) => set({ expr: event.target.value })} />
          <input className="kit-mods-label" value={modifier.label} disabled={disabled} placeholder="可选" aria-label={`修饰器 ${index + 1} 名称`} onChange={(event) => set({ label: event.target.value })} />
          <button
            type="button"
            className="kit-mods-toggle"
            aria-expanded={isOpen}
            title={error ?? (ignored ? '被无视' : isOpen ? '收起预览' : '展开预览')}
            onClick={() => setSelected(isOpen ? null : index)}
          >
            <span className="kit-mods-dot" aria-hidden />
            <svg viewBox="0 0 16 16" aria-hidden><path d={isOpen ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} /></svg>
          </button>
          <RemoveButton label={`移除修饰器 ${modifier.id || index + 1}`} disabled={disabled} onClick={() => { onChange(removeAt(modifiers, index)); setSelected(null) }} />
        </div>
        {isOpen && <ModifierPreview modifier={modifier} env={env} error={error} ignored={ignored} range={range} onRange={setRange} />}
      </div>
    })}
  </div>
}

/** 礼包表单主体：可编辑表单与只读编译结果共用同一套布局 */
function KitBody({ kit, disabled, readOnly, editorPath, simulatorPools, afterHeader, update }: {
  kit: KitDocument
  disabled?: boolean
  readOnly?: boolean
  editorPath: string
  simulatorPools: KitPool[]
  afterHeader?: ReactNode
  update: (patch: Partial<KitDocument>) => void
}) {
  const fontSize = useEditorFontSize()
  const ui = useContext(KitExprContext)
  const locked = disabled || readOnly
  const add = (label: string, onClick: () => void) => readOnly ? undefined : <AddButton label={label} disabled={disabled} onClick={onClick} />

  return <>
    <header className="kit-header">
      <label className="kit-name-field">
        <span className="kit-name-label" title="礼包显示名称">名称</span>
        <input className="kit-title" value={kit.name} disabled={locked} placeholder="未命名礼包" aria-label="名称" onChange={(event) => update({ name: event.target.value })} />
      </label>
      <ExperienceField experience={kit.experience} disabled={locked} onChange={(experience) => update({ experience })} />
    </header>

    <KitTagField tags={kit.tags} disabled={disabled} readOnly={readOnly} onChange={(tags) => update({ tags })} />

    {afterHeader}

    <div className="kit-columns">
      <div className="kit-stack">
        <Panel title="物品" count={kit.items.length} action={add('添加', () => update({ items: [...kit.items, createKitItem()] }))}>
          <ItemList items={kit.items} header disabled={locked} onChange={(items) => update({ items })} />
        </Panel>

        <Panel title="随机池" count={kit.pools.length} action={add('添加', () => update({ pools: [...kit.pools, createKitPool()] }))}>
          {!readOnly && <p className="kit-hint">
            每个池独立抽取：每抽一次按权重选中<b>一个分组</b>，发放该组的全部物品；同一分组可被重复抽中。
          </p>}
          {kit.pools.length === 0 ? <p className="kit-empty">暂无随机池</p> : <>
            <div className="kit-pools">
              {kit.pools.map((pool, index) => (
                <PoolCard key={index} pool={pool} index={index} disabled={locked} onChange={(next) => update({ pools: replaceAt(kit.pools, index, next) })} onRemove={() => update({ pools: removeAt(kit.pools, index) })} />
              ))}
            </div>
            <PoolSimulator pools={simulatorPools} />
          </>}
        </Panel>

        <Panel title="药水效果" count={kit.effects.length} action={add('添加', () => update({ effects: [...kit.effects, createKitEffect()] }))}>
          {kit.effects.length === 0 ? <p className="kit-empty">暂无效果</p> : <>
            <div className="kit-row kit-effect kit-row-head" aria-hidden><span /><span>效果 ID</span><span>等级</span><span>时长</span><span>粒子</span><span /></div>
            <ol className="kit-list">
              {kit.effects.map((effect, index) => (
                <EffectRow key={index} effect={effect} index={index} disabled={locked} onChange={(patch) => update({ effects: replaceAt(kit.effects, index, { ...effect, ...patch }) })} onRemove={() => update({ effects: removeAt(kit.effects, index) })} />
              ))}
            </ol>
          </>}
        </Panel>

        <Panel title="指令" subtitle={readOnly ? undefined : '${表达式} 插值，可调用修饰器'} count={kit.commands.length} action={add('添加', () => update({ commands: [...kit.commands, ''] }))}>
          {kit.commands.length === 0 ? <p className="kit-empty">暂无指令</p> : (
            <ol className="kit-list">
              {kit.commands.map((command, index) => {
                const problems = ui ? interpolateKitText(command, ui.env).errors : []
                return <li key={index} className={`kit-row kit-command${problems.length ? ' is-error' : ''}`} title={problems.join('\n') || undefined}>
                  <span className="kit-row-index">{index + 1}</span>
                  <input className="kit-mono" value={command} disabled={locked} placeholder="give @s minecraft:apple ${round(loot(1))}" aria-label={`指令 ${index + 1}`} onChange={(event) => update({ commands: replaceAt(kit.commands, index, event.target.value) })} />
                  <RemoveButton label={`移除指令 ${index + 1}`} disabled={locked} onClick={() => update({ commands: removeAt(kit.commands, index) })} />
                </li>
              })}
            </ol>
          )}
        </Panel>
      </div>

      <div className="kit-aside">
        <Panel title="领取反馈">
          <FeedbackForm feedback={kit.feedback} disabled={locked} onChange={(patch) => update({ feedback: { ...kit.feedback, ...patch } })} />
        </Panel>

        <Panel title="脚本" subtitle={readOnly ? undefined : 'kit.param(id) · kit.mod(id, x) · kit.expr(src)'} className="kit-script" action={<span className="kit-lang">Python</span>}>
          <div className={`kit-script-body${disabled ? ' is-disabled' : ''}`}>
            <Editor
              height="100%"
              language="python"
              theme={HANSHU_THEME_ID}
              value={kit.script}
              path={editorPath}
              beforeMount={registerHanshuLanguage}
              onChange={(value) => { if (!locked) update({ script: value ?? '' }) }}
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
                readOnly: locked,
                domReadOnly: readOnly,
              }}
            />
          </div>
        </Panel>
      </div>
    </div>
  </>
}

const NOOP = () => {}
const EMPTY_CATALOG: KitCatalog = new Map()

export function KitEditor({ kit, error, disabled, editorPath, selfRef = 'kit', catalog = EMPTY_CATALOG, catalogOptions = [], onChange }: {
  kit: KitDocument
  error?: string
  disabled?: boolean
  editorPath?: string
  /** 当前资源引用名（文件名去 .kit） */
  selfRef?: string
  catalog?: KitCatalog
  catalogOptions?: { ref: string; label: string }[]
  onChange: (source: string) => void
}) {
  const update = (patch: Partial<KitDocument>) => onChange(stringifyKit({ ...kit, ...patch }))
  const [preview, setPreview] = useState<Record<string, unknown>>({})
  const [compiledOpen, setCompiledOpen] = useState(true)
  const flat = useMemo(() => flattenKit(kit, selfRef, catalog), [kit, selfRef, catalog])
  const compiled = useMemo(() => resolveKit(flat.kit, preview), [flat.kit, preview])
  // 本文件随机池按展开后的修饰器求值，模拟器与当前卡片一一对应
  const localPools = useMemo(
    () => resolveKit({ ...kit, params: flat.kit.params, modifiers: flat.kit.modifiers }, preview).pools,
    [kit, flat.kit.params, flat.kit.modifiers, preview],
  )
  const env = compiled.env
  const exprUi = useMemo<KitExprUi>(() => ({
    env,
    modifiers: activeKitModifiers(flat.kit.modifiers)
      .filter((modifier) => env.declared.has(modifier.id))
      .map((modifier) => ({ id: modifier.id, label: modifier.label })),
  }), [env, flat.kit.modifiers])
  const appliedUi = useMemo<KitExprUi>(() => ({ ...exprUi, applied: true }), [exprUi])
  const problems = [
    ...flat.errors.map((message) => ({ path: '继承/组合', level: 'error' as const, message })),
    ...env.errors.map((message) => ({ path: '声明', level: 'error' as const, message })),
    ...compiled.issues,
  ]
  const scriptPath = editorPath ?? 'progress-kit-script://kit.py'
  const setPreviewValue = (id: string, value: unknown) => setPreview((previous) => {
    const next = { ...previous }
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) delete next[id]
    else next[id] = value
    return next
  })

  return <div className="kit-editor">
    <div className="kit-page">
      {error && <p className="kit-banner" role="alert">草稿无法解析，已显示空表单：{error}</p>}

      <KitExprContext.Provider value={exprUi}>
        <KitBody
          kit={kit}
          disabled={disabled}
          editorPath={scriptPath}
          simulatorPools={localPools}
          afterHeader={<CompositionBar kit={kit} selfRef={selfRef} options={catalogOptions} disabled={disabled} onChange={(patch) => update(patch)} />}
          update={update}
        />

        <Panel
          title="超参数"
          subtitle="由引擎注入，此处为默认值"
          count={activeKitParams(kit.params).length}
          action={<AddButton label="添加" disabled={disabled} onClick={() => update({ params: [...kit.params, createKitParam()] })} />}
        >
          <ParamPanel
            params={kit.params}
            preview={preview}
            disabled={disabled}
            onChange={(params) => update({ params })}
            onPreview={setPreviewValue}
          />
        </Panel>

        <Panel
          title="修饰器"
          subtitle="一元函数 f(x)，x 为字段原值"
          count={activeKitModifiers(kit.modifiers).length}
          action={<AddButton label="添加" disabled={disabled} onClick={() => update({ modifiers: [...kit.modifiers, createKitModifier()] })} />}
        >
          <ModifierPanel modifiers={kit.modifiers} env={env} disabled={disabled} onChange={(modifiers) => update({ modifiers })} />
        </Panel>
      </KitExprContext.Provider>

      <div className="kit-compiled-divider">
        <button type="button" className="kit-fold" aria-expanded={compiledOpen} onClick={() => setCompiledOpen(!compiledOpen)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d={compiledOpen ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} /></svg>
          编译结果
        </button>
        <span className="kit-compiled-note">只读 · 展开继承与组合，按预览值应用修饰器与插值</span>
        <ol className="kit-flatten-chain">{flat.chain.map((ref, index) => <li key={`${ref}-${index}`}>{ref}</li>)}</ol>
        {problems.length > 0 && <span className="kit-compiled-count">{problems.length} 个问题</span>}
      </div>

      {compiledOpen && <>
        {problems.length > 0 && (
          <ul className="kit-issues kit-compiled-issues" role="status">
            {problems.map((issue, index) => <li key={index} className={`is-${issue.level}`}><code>{issue.path}</code>{issue.message}</li>)}
          </ul>
        )}
        <div className="kit-compiled" aria-label="编译结果（只读）">
          <KitExprContext.Provider value={appliedUi}>
            <KitBody kit={compiled} readOnly editorPath={`${scriptPath}.compiled`} simulatorPools={compiled.pools} update={NOOP} />
          </KitExprContext.Provider>
          <Panel title="超参数" subtitle="预览值可在此直接调整" count={activeKitParams(compiled.params).length}>
            <ParamPanel params={compiled.params} preview={preview} disabled onChange={NOOP} onPreview={setPreviewValue} />
          </Panel>
          <Panel title="修饰器" count={activeKitModifiers(compiled.modifiers).length}>
            <ModifierPanel modifiers={compiled.modifiers} env={env} disabled onChange={NOOP} />
          </Panel>
        </div>
      </>}
    </div>
  </div>
}
