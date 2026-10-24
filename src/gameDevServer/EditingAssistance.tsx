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
      const available = Math.min(340, Math.max(64, upwards ? above : below))
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
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [selected, setSelected] = useState(-1)
  const generation = useRef(0)
  const previewGeneration = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => { if (disabled || !connected) { setOpen(false); previewGeneration.current++; setPlaying(null) } }, [disabled, connected])
  useEffect(() => {
    if (!open || !connected) return
    const current = ++generation.current
    setLoading(true); setError(''); setSelected(-1)
    const timer = setTimeout(() => {
      void (async () => {
        const entries: Entry[] = []
        let total = 0
        do {
          const result = await controlRequest(`${kind}.list`, { query, offset: entries.length, limit: 128 })
          if (generation.current !== current) return
          const response = result as Page
          if (!response || response.version !== 1 || !Array.isArray(response.items)
            || !Number.isInteger(response.total) || response.total < 0
            || response.items.some(entry => !entry || typeof entry.id !== 'string'
              || (entry.name !== undefined && typeof entry.name !== 'string')
              || (entry.icon !== undefined && (typeof entry.icon !== 'string' || !entry.icon.startsWith('data:image/png;base64,')))))
            throw new Error('游戏返回了不支持的目录格式')
          total = response.total
          if (!response.items.length && entries.length < total) throw new Error('游戏目录未完整返回，请重新展开重试')
          entries.push(...response.items)
          setPage({ ...response, items: [...entries] })
          // Keep the first results usable while the remaining transport batches arrive.
          setLoading(false)
        } while (entries.length < total && generation.current === current)
      })().catch(reason => {
        if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { if (generation.current === current) setLoading(false) })
    }, 160)
    return () => { clearTimeout(timer); generation.current++ }
  }, [open, connected, kind, query])

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      const target = event.target as Element
      if (!root.current?.contains(target) && !document.getElementById(id)?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('focusin', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('focusin', close) }
  }, [open, id])
  const preview = async (sound: string) => {
    const current = ++previewGeneration.current
    setPlaying(sound); setError('')
    try { await controlRequest('sounds.preview', { id: sound }) }
    catch (reason) { if (current === previewGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === previewGeneration.current) setPlaying(null) }
  }
  const expand = () => {
    if (!connected || disabled || open) return
    setQuery(''); setPage(null); setSelected(-1); setOpen(true)
  }
  const choose = (entry: Entry) => {
    if (disabled) return
    onChange(entry.id); setOpen(false); setSelected(-1)
    input.current?.focus()
  }
  const entries = page?.items ?? []
  return <div ref={root} className="game-assist" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>
    <input ref={input} className="kit-mono" value={value} disabled={disabled} aria-label={label}
      role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && selected >= 0 ? `${id}-${selected}` : undefined}
      placeholder={kind === 'effects' ? '搜索效果名称或 ID' : '搜索音效 ID'}
      onFocus={expand} onClick={expand}
      onChange={event => {
        onChange(event.target.value); setQuery(event.target.value); setSelected(-1)
        if (connected) setOpen(true)
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) { expand(); return }
          if (loading || !entries.length) return
          setSelected(previous => previous < 0 ? (event.key === 'ArrowDown' ? 0 : entries.length - 1)
            : (previous + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && open && !loading && selected >= 0 && entries[selected]) {
          event.preventDefault(); choose(entries[selected])
        } else if (event.key === 'Tab') setOpen(false)
      }} />
    {open && connected && !disabled && <Floating anchor={root} className="game-assist-picker" id={id}>
      <div className="game-assist-entries" role="listbox" aria-label={label} aria-busy={loading}>
        {entries.map((entry, index) => <div className={`game-assist-entry${index === selected ? ' selected' : ''}${entry.id === value ? ' is-current' : ''}`} key={entry.id}>
          <button type="button" className="game-assist-choice" id={`${id}-${index}`} role="option" aria-selected={index === selected}
            disabled={loading} onMouseDown={event => event.preventDefault()} onClick={() => choose(entry)}
            ref={node => { if (index === selected) node?.scrollIntoView({ block: 'nearest' }) }}>
            {entry.icon && <img src={entry.icon} alt="" />}
            <span>{entry.name && <strong>{entry.name}</strong>}<code>{entry.id}</code></span>
            {entry.id === value && <svg className="game-assist-check" viewBox="0 0 16 16" aria-hidden><path d="m3 8 3 3 7-7" /></svg>}
          </button>
          {kind === 'sounds' && <button type="button" className="game-assist-play" disabled={playing !== null}
            title="在游戏中试听" aria-label={`试听 ${entry.id}`} onMouseDown={event => event.preventDefault()} onClick={() => void preview(entry.id)}>
            <svg viewBox="0 0 16 16" className={playing === entry.id ? 'is-loading' : undefined} aria-hidden>{playing === entry.id ? <circle cx="8" cy="8" r="5" strokeDasharray="18 14" /> : <path d="m5 3 8 5-8 5Z" />}</svg>
          </button>}
        </div>)}
        {loading && <p role="status">正在搜索…</p>}
        {!loading && !error && !entries.length && <p>没有匹配项，可直接填写 ID</p>}
      </div>
      {error && <p className="game-assist-error" role="alert">{error}</p>}
      {page && <footer><span>{page.total} 项</span></footer>}
    </Floating>}
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
