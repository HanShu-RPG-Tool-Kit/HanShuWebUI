import { useEffect, useLayoutEffect, useRef, useState, useId, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'

export type NodeMenuItem = { label: string; disabled?: boolean; hint?: string; className?: string } & (
  | { action: () => void; children?: never }
  | { children: NodeMenuItem[]; action?: never }
)

type MenuProps = { x: number; y: number; title: string; items: NodeMenuItem[]; onClose: (restoreFocus?: boolean) => void; label?: string; className?: string; anchor?: RefObject<HTMLElement | null>; boundary?: RefObject<HTMLElement | null> }

type MenuBounds = { left: number; top: number; right: number; bottom: number }
function visibleBounds(boundary?: RefObject<HTMLElement | null>): MenuBounds {
  const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  let element = boundary?.current ?? null
  while (element && element !== document.body) {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect()
    const editor = element.matches('.item-editor, .flow-group-body')
    if (editor || /auto|scroll|hidden|clip/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left + element.clientLeft)
      bounds.right = Math.min(bounds.right, rect.left + element.clientLeft + element.clientWidth)
    }
    if (editor || /auto|scroll|hidden|clip/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top + element.clientTop)
      bounds.bottom = Math.min(bounds.bottom, rect.top + element.clientTop + element.clientHeight)
    }
    element = element.parentElement
  }
  return bounds
}

/** Each level is a sibling fixed panel: scrolling/clipping the parent cannot hide its submenu. */
function MenuLevel({ x, y, title, items, onClose, label, className, parent, onBack, focus = true, boundary }: Omit<MenuProps, 'anchor'> & {
  parent?: DOMRect; onBack?: () => void; focus?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState<{ index: number; rect: DOMRect; focus: boolean } | null>(null)
  const submenuId = useId()
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    const bounds = visibleBounds(boundary)
    const margin = 6
    const availableWidth = Math.max(1, bounds.right - bounds.left - margin * 2)
    const availableHeight = Math.max(1, bounds.bottom - bounds.top - margin * 2)
    element.style.boxSizing = 'border-box'
    element.style.minWidth = '0'
    element.style.maxWidth = `${availableWidth}px`
    element.style.maxHeight = `${availableHeight}px`
    const rect = element.getBoundingClientRect()
    const desiredLeft = parent ? (parent.right + rect.width + 4 > bounds.right - margin ? parent.left - rect.width - 4 : parent.right + 4) : x
    element.style.left = `${Math.max(bounds.left + margin, Math.min(desiredLeft, bounds.right - rect.width - margin))}px`
    element.style.top = `${Math.max(bounds.top + margin, Math.min(parent?.top ?? y, bounds.bottom - rect.height - margin))}px`
  }, [x, y, parent, boundary])

  useLayoutEffect(() => {
    if (focus) (panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? panel.current)?.focus({ preventScroll: true })
  }, [focus])

  function open(index: number, button: HTMLButtonElement, focusChild: boolean) {
    if (!items[index]?.children || items[index].disabled) return
    setOpened({ index, rect: button.getBoundingClientRect(), focus: focusChild })
  }
  function back() { onBack?.() }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (onBack) back(); else onClose(); return }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
    if (event.key === 'ArrowLeft' && onBack) { event.preventDefault(); back(); return }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      const button = document.activeElement as HTMLButtonElement
      const itemIndex = Number(button.dataset.menuIndex)
      if (Number.isInteger(itemIndex)) open(itemIndex, button, true)
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!buttons.length) return
      setOpened(null)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus({ preventScroll: true })
    }
  }
  const child = opened ? items[opened.index] : undefined
  return <>
    <div ref={panel} id={parent ? submenuId : undefined} className={`flow-node-menu ${className ?? ''}`} style={{ left: x, top: y }} role="menu" tabIndex={-1} aria-label={label} onKeyDown={onKeyDown} onContextMenu={event => event.preventDefault()}>
      <div className="flow-node-menu-title" title={title}>{title}</div>
      {items.map((item, index) => <button key={item.label} data-menu-index={index} className={item.className} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} title={item.hint}
        aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? opened?.index === index : undefined}
        onPointerEnter={event => { if (item.children && !item.disabled) open(index, event.currentTarget, false); else setOpened(null) }}
        onClick={event => { if (item.children) open(index, event.currentTarget, true); else { onClose(); item.action() } }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}><span>{item.label}</span>{item.children && <span aria-hidden="true">›</span>}</span>
      </button>)}
    </div>
    {opened && child?.children && !child.disabled && <MenuLevel key={opened.index} x={opened.rect.right + 4} y={opened.rect.top} parent={opened.rect} focus={opened.focus}
      title={child.label} label={child.label} items={child.children} className={className} onClose={onClose} boundary={boundary}
      onBack={() => { const button = panel.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${opened.index}"]`); setOpened(null); button?.focus({ preventScroll: true }) }} />}
  </>
}

/** Portal coordinates are viewport coordinates, independent of canvas zoom and scrolling. */
export function NodeContextMenu({ x, y, title, items, onClose, label = '节点操作', className = '', anchor, boundary }: MenuProps) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !anchor?.current?.contains(event.target as Node)) onClose(false) }
    const scroll = (event: Event) => { if (!root.current?.contains(event.target as Node)) onClose(false) }
    const close = () => onClose(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose, anchor])
  return createPortal(<div ref={root}><MenuLevel key={`${x}:${y}`} x={x} y={y} title={title} items={items} onClose={onClose} label={label} className={className} boundary={boundary} /></div>, document.body)
}
