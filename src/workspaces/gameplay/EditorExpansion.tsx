import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './EditorExpansion.css'

type Controls = { expanded: boolean; expand: () => void; restore: () => void }

/** One portal destination for the lifetime of the editor. Move its DOM host,
 * rather than changing the portal target or mounting a second editable copy. */
export function EditorExpansion({ title, kind, children }: {
  title: string
  kind: 'form' | 'text' | 'graph'
  children: (controls: Controls) => ReactNode
}) {
  const [host] = useState(() => document.createElement('div'))
  const [expanded, setExpanded] = useState(false)
  const home = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null), destination = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const lastFocus = useRef<HTMLElement | null>(null)
  const scrolls = useRef<{ element: HTMLElement; top: number; left: number }[]>([])
  const restore = () => setExpanded(false)
  const expand = () => {
    const slot = home.current!
    slot.style.minHeight = `${slot.offsetHeight}px`
    scrolls.current = [host, ...host.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth).map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
    setExpanded(true)
  }
  useLayoutEffect(() => {
    host.className = `editor-expansion-host is-${kind}`
    return () => { host.remove() }
  }, [host, kind])
  useLayoutEffect(() => {
    const modal = dialog.current!, slot = expanded ? destination.current! : home.current!
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : lastFocus.current
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null
    // moveBefore preserves browser-managed state (including focus); append is a
    // fallback for older WebViews, with focus/selection explicitly restored.
    const movable = slot as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void }
    if (host.isConnected && slot.isConnected && movable.moveBefore) movable.moveBefore(host, null)
    else slot.append(host)
    if (expanded) modal.showModal()
    else {
      if (modal.open) modal.close()
      home.current!.style.minHeight = ''
      for (const item of scrolls.current) { item.element.scrollTop = item.top; item.element.scrollLeft = item.left }
    }
    const focus = focused?.isConnected && host.contains(focused) ? focused : expanded ? host.querySelector<HTMLElement>('textarea,input,select,.node-editor,button') : null
    focus?.focus({ preventScroll: true })
    if (selection && focused && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && selection.start !== null) {
      focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined)
    }
  }, [expanded, host])
  useLayoutEffect(() => {
    const modal = dialog.current!
    // Portal events follow their React parent. Native listeners on the dialog
    // establish the actual modal keyboard boundary around the moved DOM host.
    const keyCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('dialog') !== modal || target.closest('[role="menu"]')) return
      event.preventDefault(); event.stopPropagation(); restore()
    }
    const keyBubble = (event: KeyboardEvent) => event.stopPropagation()
    modal.addEventListener('keydown', keyCapture, true)
    modal.addEventListener('keydown', keyBubble)
    return () => { modal.removeEventListener('keydown', keyCapture, true); modal.removeEventListener('keydown', keyBubble) }
  }, [])
  return <div ref={home} className={`editor-expansion is-${kind}${expanded ? ' is-expanded' : ''}`} onFocusCapture={event => {
    const target = event.target as HTMLElement
    if (host.contains(target) && target.matches('input,textarea,select,[contenteditable="true"],.node-editor,.react-flow__node')) lastFocus.current = target
  }}>
    {expanded && <div className="editor-expansion-placeholder">{title}正在放大编辑<span>返回后继续在此处编辑</span></div>}
    {createPortal(children({ expanded, expand, restore }), host)}
    {createPortal(<dialog ref={dialog} className={`editor-expansion-dialog progress-editor is-${kind}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); restore() }}>
      <header className="editor-expansion-heading"><div><strong id={titleId}>{title}</strong><span>编辑同步到当前草稿</span></div><button type="button" aria-label={`返回${title}`} onClick={restore}>还原到原处 <span aria-hidden="true">↙</span></button></header>
      <div ref={destination} className="editor-expansion-destination" />
    </dialog>, document.body)}
  </div>
}
