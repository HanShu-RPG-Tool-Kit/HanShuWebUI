import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export type NodeMenuItem = { label: string; disabled?: boolean; hint?: string; action: () => void }

/** Portal coordinates are viewport coordinates, independent of canvas zoom and scrolling. */
export function NodeContextMenu({ x, y, title, items, onClose, label = '节点操作', className = '' }: {
  x: number; y: number; title: string; items: NodeMenuItem[]; onClose: (restoreFocus?: boolean) => void; label?: string; className?: string
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(false) }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(false) }
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
  }, [onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!buttons.length) return
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }

  return createPortal(<div ref={menu} className={`flow-node-menu ${className}`} style={{ left: x, top: y }} role="menu" aria-label={label} onKeyDown={onKeyDown} onContextMenu={(event) => event.preventDefault()}>
    <div className="flow-node-menu-title" title={title}>{title}</div>
    {items.map((item) => <button key={item.label} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} title={item.hint} onClick={() => { onClose(); item.action() }}>
      {item.label}
    </button>)}
  </div>, document.body)
}
