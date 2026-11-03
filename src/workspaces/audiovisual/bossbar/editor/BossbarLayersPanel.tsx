import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { isDisplayRegion, type BossbarComponent, type BossbarDocument } from '../protocol'
import type { DockPlacement } from '../../../../ui/PanelDock'
import { DockPanelTitle } from '../../../../ui/DockPanelTitle'
import { NodeContextMenu, type NodeMenuItem } from '../../../../nodeEditor/ContextMenu'
import { Button } from './BossbarEditorUi'

const TYPE_LABEL: Record<BossbarComponent['type'], string> = {
  display_region: '显示区域',
  background: '背景',
  bar: '数值条',
  text: '文本',
}

const DRAG_THRESHOLD = 4
const INSERT_HOLD = 10

export type LayerMovePlace = 'before' | 'after'

type LayerRect = { id: string; top: number; height: number }

type LayerDragSession = {
  id: string
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  originLeft: number
  originTop: number
  originWidth: number
  originHeight: number
  home: number
  insertAt: number
  rects: LayerRect[]
}

export function BossbarLayersPanel({
  document,
  selection,
  locked,
  hidden,
  readOnly,
  placement,
  onTitlePointerDown,
  onRedock,
  onSelectionChange,
  onLockToggle,
  onHiddenToggle,
  onReorder,
  onMoveTo,
  onDuplicate,
  onRemove,
  onAdd,
}: {
  document: BossbarDocument
  selection: readonly string[]
  locked: readonly string[]
  hidden: readonly string[]
  readOnly: boolean
  placement: DockPlacement
  onTitlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
  onSelectionChange: (ids: string[]) => void
  onLockToggle: (id: string) => void
  onHiddenToggle: (id: string) => void
  onReorder: (id: string, direction: -1 | 1) => void
  onMoveTo: (id: string, targetId: string, place: LayerMovePlace) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onAdd: (type: 'background' | 'bar' | 'text') => void
}) {
  const region = document.components.find(isDisplayRegion) ?? null
  const paintables = document.components.filter((component) => !isDisplayRegion(component))
  const visualIds = [...paintables].reverse().map((component) => component.id)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const sessionRef = useRef<LayerDragSession | null>(null)
  const pendingRef = useRef<{ id: string; pointerId: number; startX: number; startY: number } | null>(null)
  const skipClick = useRef(false)
  const listRef = useRef<HTMLUListElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const listenersRef = useRef<{ move: (event: PointerEvent) => void; up: (event: PointerEvent) => void } | null>(null)

  const select = (id: string, additive: boolean) => {
    if (additive) {
      onSelectionChange(selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id])
      return
    }
    onSelectionChange([id])
  }

  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const rowOf = (id: string) => {
    const list = listRef.current
    if (!list) return null
    for (const row of list.querySelectorAll<HTMLElement>('[data-layer-id]')) {
      if (row.dataset.layerId === id) return row
    }
    return null
  }

  const unbindPointer = () => {
    const listeners = listenersRef.current
    if (!listeners) return
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.up)
    listenersRef.current = null
  }

  const clearPaint = () => {
    const list = listRef.current
    if (!list) return
    list.classList.remove('is-reordering')
    for (const row of list.querySelectorAll<HTMLElement>('[data-layer-id]')) {
      row.style.transform = ''
      row.style.zIndex = ''
      row.classList.remove('is-placeholder')
    }
  }

  const insertIndexAt = (rects: LayerRect[], id: string, centerY: number, previous: number) => {
    const others = rects.filter((row) => row.id !== id).sort((a, b) => a.top - b.top)
    let next = 0
    for (const row of others) {
      if (centerY > row.top + row.height / 2) next += 1
    }
    if (previous < 0 || previous === next) return next
    const crossed = others[Math.min(previous, next)]
    if (!crossed) return next
    const boundary = crossed.top + crossed.height / 2
    if (next > previous && centerY < boundary + INSERT_HOLD) return previous
    if (next < previous && centerY > boundary - INSERT_HOLD) return previous
    return next
  }

  const paintDrag = (session: LayerDragSession, clientX: number, clientY: number) => {
    const list = listRef.current
    if (!list) return
    session.lastX = clientX
    session.lastY = clientY
    const centerY = session.originTop + session.originHeight / 2 + (clientY - session.startY)
    session.insertAt = insertIndexAt(session.rects, session.id, centerY, session.insertAt)
    const others = session.rects.filter((row) => row.id !== session.id).sort((a, b) => a.top - b.top)
    const order = others.map((row) => row.id)
    order.splice(Math.max(0, Math.min(session.insertAt, order.length)), 0, session.id)
    const slots = [...session.rects].sort((a, b) => a.top - b.top).map((row) => row.top)
    list.classList.add('is-reordering')
    for (const row of session.rects) {
      const el = rowOf(row.id)
      if (!el) continue
      const grabbed = row.id === session.id
      const slot = slots[order.indexOf(row.id)] ?? row.top
      const dy = slot - row.top
      el.style.transform = dy ? `translateY(${Math.round(dy)}px)` : ''
      el.style.zIndex = ''
      el.classList.toggle('is-placeholder', grabbed)
    }
    const ghost = ghostRef.current
    if (ghost) {
      ghost.style.width = `${Math.round(session.originWidth)}px`
      ghost.style.height = `${Math.round(session.originHeight)}px`
      ghost.style.transform = `translate(${Math.round(session.originLeft + clientX - session.startX)}px, ${Math.round(session.originTop + clientY - session.startY)}px)`
    }
  }

  useLayoutEffect(() => {
    const session = sessionRef.current
    if (!dragId || !session || session.id !== dragId) return
    paintDrag(session, session.lastX, session.lastY)
  }, [dragId])

  const finishDrag = (id: string) => {
    const session = sessionRef.current
    pendingRef.current = null
    sessionRef.current = null
    unbindPointer()
    setDragId(null)
    clearPaint()
    if (!session || session.id !== id) return
    const to = session.insertAt
    if (to === session.home || to < 0 || to >= visualIds.length) return
    onMoveTo(id, visualIds[to], session.home < to ? 'after' : 'before')
  }

  const beginDrag = (
    pending: { id: string; pointerId: number; startX: number; startY: number },
    clientX: number,
    clientY: number,
    row: HTMLElement,
  ) => {
    const rects: LayerRect[] = []
    for (const rowId of visualIds) {
      const el = rowOf(rowId)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      rects.push({ id: rowId, top: rect.top, height: rect.height })
    }
    const home = visualIds.indexOf(pending.id)
    if (home < 0 || rects.length < 2) return
    const grabbed = rowOf(pending.id)
    if (!grabbed) return
    const origin = grabbed.getBoundingClientRect()
    const next: LayerDragSession = {
      id: pending.id,
      pointerId: pending.pointerId,
      startX: pending.startX,
      startY: pending.startY,
      lastX: clientX,
      lastY: clientY,
      originLeft: origin.left,
      originTop: origin.top,
      originWidth: origin.width,
      originHeight: origin.height,
      home,
      insertAt: home,
      rects,
    }
    pendingRef.current = null
    sessionRef.current = next
    skipClick.current = true
    setDragId(pending.id)
    try {
      row.setPointerCapture(pending.pointerId)
    } catch {
      /* window listeners already follow the pointer */
    }
    paintDrag(next, clientX, clientY)
  }

  const onLayerPointerDown = (event: ReactPointerEvent<HTMLLIElement>, id: string) => {
    if (readOnly || event.button !== 0) return
    if ((event.target as HTMLElement).closest('.bb-layer-actions')) return
    event.stopPropagation()
    select(id, event.shiftKey || event.metaKey || event.ctrlKey)
    pendingRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY }
    const row = event.currentTarget
    const pointerId = event.pointerId
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const session = sessionRef.current
      if (session && session.id === id) {
        ev.preventDefault()
        paintDrag(session, ev.clientX, ev.clientY)
        return
      }
      const pending = pendingRef.current
      if (!pending || pending.id !== id || pending.pointerId !== pointerId) return
      if (Math.abs(ev.clientX - pending.startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - pending.startY) < DRAG_THRESHOLD) {
        return
      }
      ev.preventDefault()
      beginDrag(pending, ev.clientX, ev.clientY, row)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (row.hasPointerCapture(pointerId)) {
        try {
          row.releasePointerCapture(pointerId)
        } catch {
          /* already released */
        }
      }
      finishDrag(id)
    }
    unbindPointer()
    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  useEffect(() => () => unbindPointer(), [])

  const dragged = dragId ? paintables.find((component) => component.id === dragId) : null

  const createItems: NodeMenuItem[] = [
    { label: '新建背景', action: () => onAdd('background'), disabled: readOnly },
    { label: '新建数值条', action: () => onAdd('bar'), disabled: readOnly },
    { label: '新建文本', action: () => onAdd('text'), disabled: readOnly },
  ]

  return (
    <div className="bb-layers">
      <DockPanelTitle
        title="图层"
        placement={placement}
        onTitlePointerDown={onTitlePointerDown}
        onRedock={onRedock}
      >
        <span className="bb-layers-count">{paintables.length}</span>
      </DockPanelTitle>
      <ul ref={listRef} className="bb-layer-list" onContextMenu={openMenu}>
        {region && (
          <li
            className={'bb-layer bb-layer-region' + (selection.includes(region.id) ? ' is-selected' : '')}
            onClick={(event) => select(region.id, event.shiftKey || event.metaKey)}
            onContextMenu={(event) => {
              select(region.id, false)
              openMenu(event)
            }}
          >
            <span className="bb-layer-icon">▣</span>
            <span className="bb-layer-name">
              显示区域
              <em>
                {Math.round(region.box.width)}x{Math.round(region.box.height)} @ {Math.round(region.box.x)},
                {Math.round(region.box.y)}
              </em>
            </span>
          </li>
        )}
        {paintables.slice().reverse().map((component) => {
          const selected = selection.includes(component.id)
          return (
            <li
              key={component.id}
              data-layer-id={component.id}
              className={
                'bb-layer'
                + (readOnly ? '' : ' is-sortable')
                + (selected ? ' is-selected' : '')
                + (hidden.includes(component.id) ? ' is-hidden' : '')
                + (dragId === component.id ? ' is-placeholder' : '')
              }
              onClick={(event) => {
                if (skipClick.current) {
                  skipClick.current = false
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              onPointerDown={(event) => onLayerPointerDown(event, component.id)}
              onContextMenu={(event) => {
                select(component.id, false)
                openMenu(event)
              }}
            >
              <span className="bb-layer-icon" data-type={component.type}>
                {component.type === 'background' ? '▤' : component.type === 'bar' ? '▬' : 'T'}
              </span>
              <span className="bb-layer-name">
                {component.id}
                <em>{TYPE_LABEL[component.type]}</em>
              </span>
              <span className="bb-layer-actions" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  title={locked.includes(component.id) ? '解锁' : '锁定（仅本机）'}
                  className={locked.includes(component.id) ? 'is-on' : undefined}
                  onClick={() => onLockToggle(component.id)}
                >
                  {locked.includes(component.id) ? '🔒' : '🔓'}
                </button>
                <button
                  type="button"
                  title={hidden.includes(component.id) ? '显示（仅本机）' : '临时隐藏（仅本机）'}
                  className={hidden.includes(component.id) ? 'is-on' : undefined}
                  onClick={() => onHiddenToggle(component.id)}
                >
                  {hidden.includes(component.id) ? '◌' : '◉'}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {selection.length === 1 && selection[0] !== region?.id && (
        <div className="bb-layers-tools">
          <Button disabled={readOnly} onClick={() => onReorder(selection[0], 1)} title="向前一层">
            ↑ 上移
          </Button>
          <Button disabled={readOnly} onClick={() => onReorder(selection[0], -1)} title="向后一层">
            ↓ 下移
          </Button>
          <Button disabled={readOnly} onClick={() => onDuplicate(selection[0])}>
            复制
          </Button>
          <Button disabled={readOnly} variant="danger" onClick={() => onRemove(selection[0])}>
            删除
          </Button>
        </div>
      )}
      {menu ? (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          title="图层"
          label="图层操作"
          items={createItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {dragged
        ? createPortal(
            <div
              ref={ghostRef}
              className="bb-layer bb-layer-ghost is-dragging"
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                margin: 0,
                listStyle: 'none',
                pointerEvents: 'none',
                zIndex: 10000,
              }}
            >
              <span className="bb-layer-icon" data-type={dragged.type}>
                {dragged.type === 'background' ? '▤' : dragged.type === 'bar' ? '▬' : 'T'}
              </span>
              <span className="bb-layer-name">
                {dragged.id}
                <em>{TYPE_LABEL[dragged.type]}</em>
              </span>
            </div>,
            window.document.body,
          )
        : null}
    </div>
  )
}
