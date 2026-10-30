import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { PageTabScroller } from "./PageTabScroller"
import { NodeContextMenu, type NodeMenuItem } from "../nodeEditor/ContextMenu"
import {
  applyEditorDrop,
  createEditorDockState,
  hitEditorDock,
  moveEditorFloat,
  readEditorDockState,
  redockEditorFloat,
  setEditorSplitRatio,
  syncEditorDock,
  editorDockGroups,
  editorDockCloseTargets,
  closeEditorDockTabs,
  toggleEditorDockPin,
  mergeEditorDockGroups,
  type EditorDockState,
  type EditorDrop,
  type EditorFloat,
  type EditorLeaf,
  type EditorNode,
  type EditorRect,
  type EditorSplit,
} from "./editorDockModel"

export const EDITOR_DOCK_RESET_EVENT = "hanshu:editor-dock-reset"
const FLOAT_W = 500
const FLOAT_H = 300
const MIN_FLOAT_W = 220
const MIN_FLOAT_H = 160

export function resetEditorDock(storageKey: string) {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    /* 无痕模式只保留内存 */
  }
  window.dispatchEvent(new CustomEvent(EDITOR_DOCK_RESET_EVENT, { detail: { storageKey } }))
}

export type EditorDockPage = { id: string; title: string; tooltip?: string; icon?: ReactNode }

type DragSession = {
  pointerId: number
  fromId: string
  tabs: string[]
  whole: boolean
  startX: number
  startY: number
  origin: EditorRect | null
  moved: boolean
}

type Preview = { rect: EditorRect; line: boolean } | null

/**
 * 编辑区内的文件标签停靠。
 * 左右贴边出框，上下只出一条线；拖到别的标签条上合并，拖出后变成浮窗。
 * 贴边看整个浮窗矩形，不看指针落在哪一侧。
 */
export function EditorDock({
  storageKey,
  pages,
  activeId,
  onActivate,
  onClose,
  renderPage,
  tabExtra,
  enableTabMenu = false,
  initialPinnedIds = [],
  onPinnedChange,
  onCloseMany,
}: {
  storageKey: string
  pages: readonly EditorDockPage[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  renderPage: (id: string) => ReactNode
  tabExtra?: ReactNode
  enableTabMenu?: boolean
  initialPinnedIds?: readonly string[]
  onPinnedChange?: (ids: string[]) => void
  onCloseMany?: (ids: string[], nextActiveId?: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageIds = pages.map((page) => page.id).join("\0")
  const titles = useMemo(() => new Map(pages.map(page => [page.id, page])), [pages])
  const [layout, setLayout] = useState<EditorDockState>(() =>
    readEditorDockState(readStorage(storageKey), pages.map((page) => page.id), activeId, initialPinnedIds),
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const [preview, setPreview] = useState<Preview>(null)
  const [ghost, setGhost] = useState<EditorRect | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [menu, setMenu] = useState<{ id: string; groupId: string; x: number; y: number; anchor: HTMLElement } | null>(null)
  const menuAnchor = useMemo(() => ({ current: menu?.anchor ?? null }), [menu?.anchor])
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate

  useEffect(() => {
    setLayout((current) => syncEditorDock(current, pageIds.split("\0").filter(Boolean), activeRef.current))
  }, [pageIds, activeId])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(layout))
    } catch {
      /* 布局存不下时忽略 */
    }
  }, [storageKey, layout])

  useEffect(() => {
    const onReset = (event: Event) => {
      const key = (event as CustomEvent<{ storageKey?: string }>).detail?.storageKey
      if (key && key !== storageKey) return
      const ids = pageIds.split("\0").filter(Boolean)
      setLayout(createEditorDockState(ids, activeRef.current))
    }
    window.addEventListener(EDITOR_DOCK_RESET_EVENT, onReset)
    return () => window.removeEventListener(EDITOR_DOCK_RESET_EVENT, onReset)
  }, [storageKey, pageIds])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const session = dragRef.current
      if (!session || session.pointerId !== event.pointerId) return
      const root = rootRef.current
      if (!root) return
      if (!session.moved && Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 4) return
      session.moved = true
      document.body.classList.add("is-panel-dragging")
      setDraggingId(session.tabs[0] ?? null)
      const rootRect = root.getBoundingClientRect()
      const mover = session.origin
        ? clampFloat(rootRect, {
            x: session.origin.x + event.clientX - session.startX,
            y: session.origin.y + event.clientY - session.startY,
            w: session.origin.w,
            h: session.origin.h,
          })
        : liftAt(rootRect, event.clientX, event.clientY)
      if (session.origin) {
        const next = moveEditorFloat(layoutRef.current, session.fromId, mover)
        layoutRef.current = next
        setLayout(next)
        setGhost(null)
      } else {
        setGhost(mover)
      }
      const hit = probe(root, event.clientX, event.clientY, mover, session.whole ? session.fromId : undefined)
      setPreview(hit.kind === "float" ? null : { rect: hit.preview, line: "line" in hit && hit.line })
    }
    const up = (event: PointerEvent) => {
      const session = dragRef.current
      if (!session || session.pointerId !== event.pointerId) return
      dragRef.current = null
      document.body.classList.remove("is-panel-dragging")
      setDraggingId(null)
      setGhost(null)
      setPreview(null)
      if (!session.moved) return
      const root = rootRef.current
      if (!root) return
      const rootRect = root.getBoundingClientRect()
      const mover = session.origin
        ? clampFloat(rootRect, {
            x: session.origin.x + event.clientX - session.startX,
            y: session.origin.y + event.clientY - session.startY,
            w: session.origin.w,
            h: session.origin.h,
          })
        : liftAt(rootRect, event.clientX, event.clientY)
      const hit = probe(root, event.clientX, event.clientY, mover, session.whole ? session.fromId : undefined)
      if (session.origin && (hit.kind === "float" || (hit.kind === "tabs" && hit.targetId === session.fromId))) return
      const drop = dropFrom(hit, root, event.clientX, mover)
      const next = applyEditorDrop(layoutRef.current, { fromId: session.fromId, tabs: session.tabs }, drop)
      layoutRef.current = next
      setLayout(next)
      const opened = session.tabs[0]
      if (opened) onActivateRef.current(opened)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => {
      document.body.classList.remove("is-panel-dragging")
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
  }, [])

  function beginDrag(event: ReactPointerEvent, fromId: string, tabs: string[], whole: boolean, origin: EditorRect | null) {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest(".flow-page-tab-close, .panel-dock-redock, input, textarea, select, a")) return
    event.preventDefault()
    dragRef.current = {
      pointerId: event.pointerId,
      fromId,
      tabs,
      whole,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      moved: false,
    }
    setLayout((current) => ({ ...current, focusId: fromId }))
  }

  function renderNode(node: EditorNode): ReactNode {
    if (node.kind === "split") {
      return (
        <SplitPane
          key={node.id}
          node={node}
          onRatio={(ratio) => setLayout(setEditorSplitRatio(layoutRef.current, node.id, ratio))}
          first={renderNode(node.first)}
          second={renderNode(node.second)}
        />
      )
    }
    return renderGroup(node, false)
  }

  function closeTabs(groupId: string, id: string, mode: 'one' | 'others' | 'right' | 'group') {
    const closing = editorDockCloseTargets(layoutRef.current, groupId, id, mode)
    if (!closing.length) return
    const next = closeEditorDockTabs(layoutRef.current, closing)
    layoutRef.current = next; setLayout(next)
    const activeClosed = activeRef.current && closing.includes(activeRef.current)
    const groups = editorDockGroups(next)
    const target = activeClosed ? groups.find(g => g.id === next.focusId) ?? groups[0] : undefined
    if (onCloseMany) onCloseMany(closing, target?.active)
    else { closing.forEach(onClose); if (target) onActivate(target.active) }
  }

  function movePage(groupId: string, id: string, drop: EditorDrop) {
    const next = applyEditorDrop(layoutRef.current, { fromId: groupId, tabs: [id] }, drop)
    layoutRef.current = next; setLayout(next); onActivate(id)
  }

  function tabMenuItems(): NodeMenuItem[] {
    if (!menu) return []
    const groups = editorDockGroups(layout), group = groups.find(g => g.id === menu.groupId)
    if (!group?.tabs.includes(menu.id)) return []
    const pinned = (layout.pinned ?? []).includes(menu.id)
    const close = (label: string, mode: 'one' | 'others' | 'right' | 'group'): NodeMenuItem => ({ label, disabled: !editorDockCloseTargets(layout, group.id, menu.id, mode).length, action: () => closeTabs(group.id, menu.id, mode) })
    const moving: NodeMenuItem[] = [
      ...(['right', 'bottom'] as const).map(side => ({ label: side === 'right' ? '移动到右侧新分栏' : '移动到下方新分栏', disabled: group.floating || group.tabs.length < 2, hint: group.floating ? "先停靠此页，再建立新分栏" : "至少保留一页在原分栏中", action: () => movePage(group.id, menu.id, { kind: 'split', targetId: group.id, side }) })),
      { label: '浮动此页', disabled: group.floating && group.tabs.length === 1, action: () => { const rect = rootRef.current?.getBoundingClientRect(); if (rect) movePage(group.id, menu.id, { kind: 'float', rect: clampFloat(rect, { x: 32, y: 40, w: FLOAT_W, h: FLOAT_H }) }) } },
      ...(group.floating ? [{ label: '将此页停靠回编辑区', action: () => movePage(group.id, menu.id, { kind: 'window', side: 'right' }) }]: []),
      ...groups.filter(g => g.id !== group.id).map((target, index) => ({ label: `移至${target.floating ? '浮动' : ''}分栏 ${index + 1} · ${titles.get(target.active)?.title ?? '文件'}`, action: () => movePage(group.id, menu.id, { kind: 'tabs', targetId: target.id, beforeId: null }) })),
      { label: '合并所有分栏到编辑区', disabled: groups.length < 2, action: () => { const next = mergeEditorDockGroups(layoutRef.current, group.id); layoutRef.current = next; setLayout(next); onActivate(group.active) } },
    ]
    return [
      { label: pinned ? '取消固定' : '固定此页', action: () => { const next = toggleEditorDockPin(layoutRef.current, menu.id); layoutRef.current = next; setLayout(next); onPinnedChange?.(next.pinned ?? []) } },
      close('关闭此页', 'one'), close('关闭其他页（当前分栏）', 'others'), close('关闭右侧页（当前分栏）', 'right'), close('关闭未固定页（当前分栏）', 'group'),
      { label: '移动与分栏', children: moving },
    ]
  }

  function renderGroup(group: EditorLeaf | EditorFloat, floating: boolean) {
    const focused = layout.focusId === group.id
    const rect = "rect" in group ? group.rect : null
    return (
      <section
        key={group.id}
        className={`editor-dock-leaf${floating ? " is-float" : ""}${focused ? " is-focused" : ""}`}
        data-editor-group={group.id}
        style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if (layoutRef.current.focusId === group.id) return
          setLayout((current) => ({ ...current, focusId: group.id }))
        }}
      >
        <div
          className="tabbar editor-dock-tabbar"
          data-editor-tabs={group.id}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return
            beginDrag(event, group.id, group.tabs, true, rect)
          }}
        >
          <div
            className="editor-dock-grip"
            role="button"
            aria-label={floating ? "拖动弹层" : "拖动此栏"}
            title={floating ? "拖动弹层" : "拖动此栏"}
            onPointerDown={(event) => {
              event.stopPropagation()
              beginDrag(event, group.id, group.tabs, true, rect)
            }}
          />
          <PageTabScroller activeKey={group.active} itemCount={group.tabs.length} focused={focused} label="已打开的文件">
            {group.tabs.map((id) => {
              const page = titles.get(id)
              const title = page?.title ?? "未命名"
              const tooltip = page?.tooltip || title
              const active = id === group.active
              const only = group.tabs.length === 1
              const pinned = enableTabMenu && (layout.pinned ?? []).includes(id)
              return (
                <div
                  key={id}
                  data-dock-tab={id}
                  data-page-key={id}
                  className={`flow-page-tab${active ? " is-active" : ""}${pinned ? " is-pinned" : ""}${draggingId === id ? " is-dragging" : ""}`}
                  role="tab"
                  aria-selected={active}
                  aria-label={title}
                  title={tooltip}
                  onContextMenu={event => { if (!enableTabMenu) return; event.preventDefault(); event.stopPropagation(); setMenu({ id, groupId: group.id, x: event.clientX, y: event.clientY, anchor: event.currentTarget }) }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    if (event.target instanceof Element && event.target.closest(".flow-page-tab-close")) return
                    onActivate(id)
                    beginDrag(event, group.id, [id], only, floating && only ? rect : null)
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    if (enableTabMenu) closeTabs(group.id, id, 'one')
                    else onClose(id)
                  }}
                >
                  <button type="button" className="flow-page-tab-name" title={tooltip}
                    onClick={event => { if (event.detail === 0) onActivate(id) }}
                    onKeyDown={event => { if (enableTabMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ id, groupId: group.id, x: rect.left, y: rect.bottom, anchor: event.currentTarget }) } }}>
                    {page?.icon}
                    <span>{title}</span>
                    {pinned && <span className="editor-dock-pin" aria-label="已固定">◆</span>}
                  </button>
                  <button
                    type="button"
                    className="flow-page-tab-close"
                    aria-label={`关闭 ${title}`}
                    title={pinned ? "请先取消固定再关闭" : "关闭"}
                    disabled={pinned}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => enableTabMenu ? closeTabs(group.id, id, 'one') : onClose(id)}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <div
              className="flow-page-list-rest"
              onPointerDown={(event) => beginDrag(event, group.id, group.tabs, true, rect)}
            />
          </PageTabScroller>
          {activeId && group.active === activeId ? tabExtra : null}
          {floating && (
            <button
              type="button"
              className="panel-dock-redock"
              title="停靠回编辑区"
              onClick={() => {
                setLayout(redockEditorFloat(layoutRef.current, group.id))
                const opened = group.tabs[0]
                if (opened) onActivate(opened)
              }}
            >
              停靠
            </button>
          )}
        </div>
        <div className="editor-dock-body">{group.active ? renderPage(group.active) : null}</div>
        {floating && rect && (
          <FloatHandles
            group={group as EditorFloat}
            onResize={(next) => {
              const moved = moveEditorFloat(layoutRef.current, group.id, next)
              layoutRef.current = moved
              setLayout(moved)
            }}
          />
        )}
      </section>
    )
  }

  return (
    <div ref={rootRef} className="editor-column editor-dock">
      {layout.root ? renderNode(layout.root) : layout.floats.length === 0 ? <div className="editor-closed" role="status">未打开文件</div> : null}
      {layout.floats.map((group) => renderGroup(group, true))}
      {ghost && <div className="editor-dock-ghost" style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }} />}
      {menu && titles.has(menu.id) && tabMenuItems().length > 0 && <NodeContextMenu x={menu.x} y={menu.y} title={titles.get(menu.id)?.title ?? '页签'} label="页签操作" items={tabMenuItems()} anchor={menuAnchor} onClose={restore => { const anchor = menu.anchor; setMenu(null); if (restore !== false) requestAnimationFrame(() => { if (anchor.isConnected) (anchor.matches('button') ? anchor : anchor.querySelector<HTMLButtonElement>('.flow-page-tab-name'))?.focus({ preventScroll: true }) }) }} />}
      <div className={`panel-dock-zones${preview ? " is-open" : ""}`}>
        <div
          className={`panel-dock-zone${preview ? " is-hot" : ""}${preview?.line ? " is-line" : ""}`}
          style={preview ? { left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h } : undefined}
        />
      </div>
    </div>
  )
}

function SplitPane({
  node,
  onRatio,
  first,
  second,
}: {
  node: EditorSplit
  onRatio: (ratio: number) => void
  first: ReactNode
  second: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; ratio: number } | null>(null)
  const [live, setLive] = useState<number | null>(null)
  const ratio = live ?? node.ratio
  const horizontal = node.direction === "row"
  return (
    <div ref={ref} className={`editor-dock-split is-${node.direction}`}>
      <div className="editor-dock-pane" style={{ flexGrow: ratio }}>{first}</div>
      <div
        className={`editor-dock-sash is-${horizontal ? "col" : "row"}${live !== null ? " is-active" : ""}`}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={horizontal ? "调整左右宽度" : "调整上下高度"}
        onPointerDown={(event) => {
          if (event.button !== 0 || !ref.current) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { pointerId: event.pointerId, ratio: node.ratio }
          setLive(node.ratio)
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId || !ref.current) return
          const rect = ref.current.getBoundingClientRect()
          const value = horizontal
            ? (event.clientX - rect.left) / Math.max(1, rect.width)
            : (event.clientY - rect.top) / Math.max(1, rect.height)
          drag.current.ratio = Math.min(0.8, Math.max(0.2, value))
          setLive(drag.current.ratio)
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return
          const next = drag.current.ratio
          drag.current = null
          setLive(null)
          onRatio(next)
        }}
        onDoubleClick={() => onRatio(0.5)}
      />
      <div className="editor-dock-pane" style={{ flexGrow: 1 - ratio }}>{second}</div>
    </div>
  )
}

function FloatHandles({ group, onResize }: { group: EditorFloat; onResize: (rect: EditorRect) => void }) {
  const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const
  return (
    <>
      {edges.map((edge) => (
        <div
          key={edge}
          className={`explorer-float-handle ${edge}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const startX = event.clientX
            const startY = event.clientY
            const origin = group.rect
            const target = event.currentTarget
            target.setPointerCapture(event.pointerId)
            document.body.classList.add("is-float-resizing")
            const move = (moveEvent: PointerEvent) => {
              onResize(resizeFloat(origin, edge, moveEvent.clientX - startX, moveEvent.clientY - startY))
            }
            const up = () => {
              document.body.classList.remove("is-float-resizing")
              target.removeEventListener("pointermove", move)
              target.removeEventListener("pointerup", up)
              target.removeEventListener("pointercancel", up)
            }
            target.addEventListener("pointermove", move)
            target.addEventListener("pointerup", up)
            target.addEventListener("pointercancel", up)
          }}
        />
      ))}
    </>
  )
}

function probe(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  mover: EditorRect,
  ignoreEdgeId?: string,
) {
  const rootRect = root.getBoundingClientRect()
  const pointer = { x: clientX - rootRect.left, y: clientY - rootRect.top }
  const leaves: { id: string; rect: EditorRect }[] = []
  const tabBands: { id: string; rect: EditorRect }[] = []
  for (const group of root.querySelectorAll<HTMLElement>("[data-editor-group]")) {
    const id = group.dataset.editorGroup
    if (!id) continue
    leaves.push({ id, rect: relativeRect(rootRect, group.getBoundingClientRect()) })
  }
  for (const bar of root.querySelectorAll<HTMLElement>("[data-editor-tabs]")) {
    const id = bar.dataset.editorTabs
    if (!id) continue
    tabBands.push({ id, rect: relativeRect(rootRect, bar.getBoundingClientRect()) })
  }
  return hitEditorDock({ width: rootRect.width, height: rootRect.height }, pointer, mover, leaves, tabBands, ignoreEdgeId)
}

function dropFrom(hit: ReturnType<typeof hitEditorDock>, root: HTMLElement, clientX: number, mover: EditorRect): EditorDrop {
  if (hit.kind === "tabs") return { kind: "tabs", targetId: hit.targetId, beforeId: beforeIdAt(root, hit.targetId, clientX) }
  if (hit.kind === "split") return { kind: "split", targetId: hit.targetId, side: hit.side }
  if (hit.kind === "window") return { kind: "window", side: hit.side }
  return { kind: "float", rect: mover }
}

function beforeIdAt(root: HTMLElement, groupId: string, clientX: number) {
  const bar = root.querySelector<HTMLElement>(`[data-editor-tabs="${CSS.escape(groupId)}"]`)
  if (!bar) return null
  for (const tab of bar.querySelectorAll<HTMLElement>("[data-dock-tab]")) {
    const rect = tab.getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) return tab.dataset.dockTab ?? null
  }
  return null
}

function relativeRect(root: DOMRect, rect: DOMRect): EditorRect {
  return { x: rect.left - root.left, y: rect.top - root.top, w: rect.width, h: rect.height }
}

function liftAt(root: DOMRect, clientX: number, clientY: number): EditorRect {
  const w = Math.min(FLOAT_W, Math.max(MIN_FLOAT_W, root.width - 16))
  const h = Math.min(FLOAT_H, Math.max(MIN_FLOAT_H, root.height - 16))
  return clampFloat(root, { x: clientX - root.left - 28, y: clientY - root.top - 14, w, h })
}

function clampFloat(root: DOMRect, rect: EditorRect): EditorRect {
  const w = Math.min(Math.max(MIN_FLOAT_W, rect.w), Math.max(MIN_FLOAT_W, root.width - 8))
  const h = Math.min(Math.max(MIN_FLOAT_H, rect.h), Math.max(MIN_FLOAT_H, root.height - 8))
  const x = Math.min(Math.max(0, rect.x), Math.max(0, root.width - w))
  const y = Math.min(Math.max(0, rect.y), Math.max(0, root.height - h))
  return { x, y, w, h }
}

function resizeFloat(origin: EditorRect, edge: string, dx: number, dy: number): EditorRect {
  let { x, y, w, h } = origin
  if (edge.includes("w")) {
    x += dx
    w -= dx
  }
  if (edge.includes("e")) w += dx
  if (edge.includes("n")) {
    y += dy
    h -= dy
  }
  if (edge.includes("s")) h += dy
  return { x, y, w: Math.max(MIN_FLOAT_W, w), h: Math.max(MIN_FLOAT_H, h) }
}

function readStorage(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
