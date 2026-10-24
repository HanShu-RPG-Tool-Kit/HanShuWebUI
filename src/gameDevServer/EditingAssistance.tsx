import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { controlRequest, getControlHubSnapshot, subscribeControlHub } from './controlHub'
import './EditingAssistance.css'

type Entry = { id: string; name?: string; icon?: string }
type Page = { version: number; items: Entry[]; total: number }
type Suggestion = { text: string; start: number; end: number; tooltip?: string }

function useGameConnection() {
  return useSyncExternalStore(subscribeControlHub, getControlHubSnapshot).phase === 'open'
}

function Floating({ anchor, children, className, id, listbox = false }: { anchor: RefObject<HTMLDivElement | null>; children: ReactNode; className: string; id?: string; listbox?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 260 })
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 280), 480, window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const height = Math.min(panel.current?.scrollHeight ?? 260, 340)
      const upwards = below < height && above > below
      const available = Math.max(64, upwards ? above : below)
      setPosition({ width, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? Math.max(8, rect.top - Math.min(height, available) - 4) : rect.bottom + 4, maxHeight: available })
    }
    update()
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [anchor])
  return createPortal(<div ref={panel} id={id} className={className} role={listbox ? 'listbox' : undefined} aria-label={listbox ? '游戏指令补全' : undefined} data-game-assist-floating style={{ position: 'fixed', ...position }}>{children}</div>, document.body)
}

/** Catalog is a transient view of the connected game; selecting still edits the normal document draft. */
export function GameResourceInput({ kind, value, disabled, onChange, label }: {
  kind: 'effects' | 'sounds'; value: string; disabled?: boolean; onChange: (value: string) => void; label: string
}) {
  const connected = useGameConnection()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const generation = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => { if (disabled || !connected) setOpen(false) }, [disabled, connected])
  useEffect(() => {
    if (!open || !connected) return
    const current = ++generation.current
    setLoading(true); setError(''); setPage(null)
    const timer = setTimeout(() => {
      void controlRequest(`${kind}.list`, { query, offset, limit: 32 }).then(result => {
        if (generation.current !== current) return
        const response = result as Page
        if (!response || response.version !== 1 || !Array.isArray(response.items)
          || !Number.isInteger(response.total) || response.total < 0
          || response.items.some(entry => !entry || typeof entry.id !== 'string'
            || (entry.name !== undefined && typeof entry.name !== 'string')
            || (entry.icon !== undefined && (typeof entry.icon !== 'string' || !entry.icon.startsWith('data:image/png;base64,')))))
          throw new Error('游戏返回了不支持的目录格式')
        setPage(response)
      }).catch(reason => {
        if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { if (generation.current === current) setLoading(false) })
    }, 180)
    return () => { clearTimeout(timer); generation.current++ }
  }, [open, connected, kind, query, offset])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !(event.target as Element).closest('[data-game-assist-floating]')) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const preview = async () => {
    setPlaying(true); setError('')
    try { await controlRequest('sounds.preview', { id: value }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPlaying(false) }
  }
  return <div ref={root} className="game-assist" onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
    <div className="game-assist-input">
      <input className="kit-mono" value={value} disabled={disabled} aria-label={label}
        placeholder={kind === 'effects' ? 'minecraft:speed' : 'minecraft:entity.player.levelup'} onChange={event => onChange(event.target.value)} />
      <button type="button" disabled={disabled || !connected} title={connected ? '从游戏中选择' : '连接游戏后可浏览'}
        aria-label={`选择${label}`} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); setQuery(''); setOffset(0) }}>⌄</button>
      {kind === 'sounds' && <button type="button" disabled={!connected || !value || playing} onClick={() => void preview()} title="在游戏中播放，点击游戏聊天中的链接停止">{playing ? '…' : '▷'} 在游戏中播放</button>}
    </div>
    {open && <Floating anchor={root} className="game-assist-picker" id={id}>
      <input autoFocus value={query} placeholder={kind === 'effects' ? '搜索名称或 ID' : '搜索音效 ID'} aria-label={`搜索${label}`} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
      {!connected ? <p>游戏已断开连接</p> : loading ? <p>正在读取游戏目录…</p> : error ? <p role="alert">{error}</p> : <>
        <div className="game-assist-entries">{page?.items.map(entry => <button type="button" key={entry.id} disabled={disabled} onClick={() => { if (!disabled) onChange(entry.id); setOpen(false) }}>
          {entry.icon && <img src={entry.icon} alt="" />}
          <span>{entry.name && <strong>{entry.name}</strong>}<code>{entry.id}</code></span>
          {entry.id === value && <span>✓</span>}
        </button>)}{page?.items.length === 0 && <p>没有匹配项</p>}</div>
        <footer><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 32))}>上一页</button><span>{page?.total ?? 0} 项</span><button type="button" disabled={!page || offset + 32 >= page.total} onClick={() => setOffset(offset + 32)}>下一页</button></footer>
      </>}
    </Floating>}
    {!open && error && <small className="game-assist-error" role="alert">{error}</small>}
  </div>
}

export function GameCommandInput({ value, disabled, label, onChange }: {
  value: string; disabled?: boolean; label: string; onChange: (value: string) => void
}) {
  const connected = useGameConnection()
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(value.length)
  const [focused, setFocused] = useState(false)
  const [items, setItems] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState('')
  const seq = useRef(0)
  useEffect(() => {
    const current = ++seq.current
    setItems([]); setSelected(0); setError('')
    // Interpolation is a kit expression, not valid vanilla command input until evaluated.
    if (!connected || !focused || disabled || value.slice(0, cursor).includes('${')) return
    const timer = setTimeout(() => {
      void controlRequest('commands.complete', { command: value, cursor }, 7000).then(raw => {
        if (seq.current !== current) return
        const result = raw as { version: number; items: Suggestion[] }
        if (!result || result.version !== 1 || !Array.isArray(result.items)) throw new Error('不支持的指令补全格式')
        setItems(result.items.filter(item => item && typeof item.text === 'string'
          && (item.tooltip === undefined || typeof item.tooltip === 'string')
          && Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end >= item.start && item.end <= value.length))
      }).catch(reason => { if (seq.current === current) setError(reason instanceof Error ? reason.message : String(reason)) })
    }, 250)
    return () => { clearTimeout(timer); seq.current++ }
  }, [connected, focused, disabled, value, cursor])
  const accept = (item: Suggestion) => {
    onChange(value.slice(0, item.start) + item.text + value.slice(item.end))
    setItems([])
    const next = item.start + item.text.length
    setCursor(next)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next, next) })
  }
  return <div ref={root} className="game-assist game-command" title={error ? `游戏补全不可用：${error}` : undefined}>
    <input ref={input} className="kit-mono" value={value} disabled={disabled} placeholder="give @s minecraft:apple ${round(loot(1))}" aria-label={label}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onSelect={event => setCursor(event.currentTarget.selectionStart ?? value.length)}
      onChange={event => { onChange(event.target.value); setCursor(event.target.selectionStart ?? event.target.value.length) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setItems([]); return }
        if (!items.length) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length) }
        if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); accept(items[selected]) }
      }} />
    {focused && items.length > 0 && <Floating anchor={root} className="game-assist-completions" listbox>
      {items.map((item, index) => <button type="button" key={`${item.start}:${item.text}`} role="option" aria-selected={selected === index} className={index === selected ? 'selected' : ''} title={item.tooltip}
        ref={node => { if (index === selected) node?.scrollIntoView({ block: 'nearest' }) }}
        onMouseDown={event => { event.preventDefault(); accept(item) }}><code>{item.text}</code>{item.tooltip && <small>{item.tooltip}</small>}</button>)}
    </Floating>}
  </div>
}
