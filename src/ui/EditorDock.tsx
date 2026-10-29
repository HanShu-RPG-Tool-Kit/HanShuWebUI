import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { PageTabScroller } from "./PageTabScroller"
import {
  applyEditorDrop,
  createEditorDockState,
  hitEditorDock,
  moveEditorFloat,
  readEditorDockState,
  redockEditorFloat,
  setEditorSplitRatio,
  syncEditorDock,
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

export type EditorDockPage = { id: string; title: string; tooltip?: string }

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
}: {
  storageKey: string
  pages: readonly EditorDockPage[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  renderPage: (id: string) => ReactNode
  tabExtra?: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pageIds = pages.map((page) => page.id).join("\0")
  const titles = useRef(new Map<string, { title: string; tooltip?: string }>())
  titles.current = new Map(pages.map((page) => [page.id, { title: page.title, tooltip: page.tooltip }]))
  const [layout, setLayout] = useState<EditorDockState>(() =>
    readEditorDockState(readStorage(storageKey), pages.map((page) => page.id), activeId),
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const [preview, setPreview] = useState<Preview>(null)
  const [ghost, setGhost] = useState<EditorRect | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragRef = useRef<DragSession | null>(null)
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

  function renderGroup(group: EditorLeaf | EditorFloat, floating: boolean) {
    const focused = layout.focusId === group.id
    const rect = "rect" in group ? group.rect : null
    return (
      <section
        key={group.id}
        className={`editor-dock-leaf${floating ? " is-float" : ""}${focused ? " is-focused" : ""}`}
        data-editor-group={group.id}
        style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : undefined}
        onPointerDown={() => {
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
              const page = titles.current.get(id)
              const title = page?.title ?? "未命名"
              const tooltip = page?.tooltip || title
              const active = id === group.active
              const only = group.tabs.length === 1
              return (
                <div
                  key={id}
                  data-dock-tab={id}
                  data-page-key={id}
                  className={`flow-page-tab${active ? " is-active" : ""}${draggingId === id ? " is-dragging" : ""}`}
                  role="tab"
                  aria-selected={active}
                  title={tooltip}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    if (event.target instanceof Element && event.target.closest(".flow-page-tab-close")) return
                    onActivate(id)
                    beginDrag(event, group.id, [id], only, floating && only ? rect : null)
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    onClose(id)
                  }}
                >
                  <button type="button" className="flow-page-tab-name" title={tooltip}>
                    <span>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="flow-page-tab-close"
                    aria-label={`关闭 ${title}`}
                    title="关闭"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onClose(id)}
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
