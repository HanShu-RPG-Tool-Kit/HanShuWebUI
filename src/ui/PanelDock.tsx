import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import {
  DOCK_DEFAULT_H,
  DOCK_DEFAULT_W,
  DOCK_EDGES,
  DOCK_TAB_H,
  DOCK_MAX_H,
  DOCK_MAX_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  DOCK_SASH,
  activateTab,
  applyStick,
  stickGroup,
  bandId,
  copyLayout,
  defaultRecord,
  detach,
  floatGroupFor,
  liftColumn,
  dockToEdge,
  findCell,
  hitDock,
  isVertical,
  layoutFrame,
  layoutFromSaved,
  orderTab,
  tabInsertIndex,
  limitsFor,
  mergeSpecs,
  removePanel,
  resetCellWeights,
  resizeLane,
  setCellPixels,
  sizeForDock,
  syncFloatGroup,
  tabsOf,
  type DockEdge,
  type DockHit,
  type DockLayout,
  type DockPlacement,
  type DockRect,
  type DockSash,
  type FloatRect,
} from "./panelDockModel"

export type { DockEdge, DockPlacement }

export type PanelDockHandle = {
  placement: DockPlacement
  onTitlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
}

export type DockPanelSpec = {
  id: string
  visible?: boolean
  defaultPlacement?: DockPlacement
  defaultSize?: number
  minSize?: number
  maxSize?: number
  defaultFloat?: FloatRect
  title?: string
  render: (api: PanelDockHandle) => ReactNode
}

type TitleSession = {
  kind: "title"
  panelId: string
  pointerId: number
  startX: number
  startY: number
  clientX: number
  clientY: number
  offsetX: number
  offsetY: number
  moved: boolean
  announced: boolean
  reordered: boolean
  detached: boolean
  activateOnClick?: boolean
  lift?: FloatRect
  tabOrder?: string[]
  tabRects?: { id: string; left: number; width: number }[]
  tabOffset?: number
  tabWidth?: number
  tabHomeIndex?: number
  tabTargetIndex?: number
}

type SashSession = {
  kind: "sash"
  pointerId: number
  axis: "x" | "y"
  invert: boolean
  start: number
  edge: DockEdge
  laneIndex: number
  cellIndex: number | null
  startSize: number
  startCross: number
  startA: number
  startB: number
  min: number
  max: number
}

type ResizeSession = {
  kind: "resize"
  panelId: string
  pointerId: number
  edges: string
  startX: number
  startY: number
  origin: FloatRect
}

type Session = TitleSession | SashSession | ResizeSession

const STORAGE_KEY = "hanshu.panelDock"
export const PANEL_DOCK_RESET_EVENT = "hanshu:panel-dock-reset"
const LEGACY_EXPLORER_KEYS = [
  "hanshu.explorerDock",
  "hanshu.explorerLastEdge",
  "hanshu.explorerWidth",
  "hanshu.explorerHeight",
  "hanshu.explorerFloat",
]

/** Clear the saved dock and ask the mounted PanelDock to rebuild its default edges. */
export function resetPanelDock(storageKey = STORAGE_KEY) {
  try {
    localStorage.removeItem(storageKey)
    if (storageKey === STORAGE_KEY) {
      for (const key of LEGACY_EXPLORER_KEYS) localStorage.removeItem(key)
    }
  } catch {
    /* private mode keeps the in-memory reset */
  }
  window.dispatchEvent(new CustomEvent(PANEL_DOCK_RESET_EVENT, { detail: { storageKey } }))
}
const MIN_FLOAT_W = 220
const MIN_FLOAT_H = 160
const FLOAT_W = 500
const FLOAT_H = 300
const LIFT_OFFSET_X = 28
const LIFT_OFFSET_Y = 14
const SASH_X = "拖拽调整宽度，双击恢复默认"
const SASH_Y = "拖拽调整高度，双击恢复默认"
const MIN_CENTER_W = 180
const MIN_CENTER_H = 96

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(key)
    return saved && (allowed as readonly string[]).includes(saved) ? (saved as T) : fallback
  } catch {
    return fallback
  }
}

function readNumber(key: string, min: number, max: number, fallback: number) {
  try {
    const saved = Number(localStorage.getItem(key))
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : fallback
  } catch {
    return fallback
  }
}

function readLegacyFloat(): FloatRect {
  const fallback = { x: 48, y: 36, w: 360, h: 480 }
  try {
    const raw = JSON.parse(localStorage.getItem("hanshu.explorerFloat") ?? "") as Partial<FloatRect>
    const next = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h) }
    if (Object.values(next).every(Number.isFinite)) return next
  } catch {
    /* keep the default float rect */
  }
  return fallback
}

function clampSize(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function dockOrphans(layout: DockLayout) {
  let changed = false
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (panel.placement === "float" || findCell(layout, id)) continue
    dockToEdge(layout, id, panel.placement, panel.size, "inner")
    changed = true
  }
  return changed
}
function readLegacyLayout(specs: readonly DockPanelSpec[]): DockLayout {
  const dock = readEnum("hanshu.explorerDock", ["left", "right", "top", "bottom", "float"] as const, "left")
  const lastEdge = readEnum("hanshu.explorerLastEdge", DOCK_EDGES, dock === "float" ? "left" : dock)
  const width = readNumber("hanshu.explorerWidth", DOCK_MIN_W, DOCK_MAX_W, DOCK_DEFAULT_W)
  const height = readNumber("hanshu.explorerHeight", DOCK_MIN_H, DOCK_MAX_H, DOCK_DEFAULT_H)
  const layout: DockLayout = { version: 3, agentSized: false, lanes: { left: [], right: [], top: [], bottom: [] }, panels: {}, floatGroups: [] }
  for (const spec of specs) layout.panels[spec.id] = defaultRecord(spec)
  const explorer = layout.panels.explorer
  if (explorer) {
    explorer.placement = dock
    explorer.lastEdge = lastEdge
    explorer.size = dock === "top" || dock === "bottom" ? height : width
    explorer.floatRect = readLegacyFloat()
    if (dock !== "float") dockToEdge(layout, "explorer", dock, explorer.size, "outer")
  }
  // Explorer is special-cased above. Every other non-float panel, including skin library/details,
  // still has to enter a lane or its band stays hidden.
  dockOrphans(layout)
  return layout
}

function readLayout(storageKey: string, specs: readonly DockPanelSpec[]): DockLayout {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const saved = layoutFromSaved(JSON.parse(raw))
      if (saved) return mergeSpecs(saved, specs)
    }
  } catch {
    /* fall through to the explorer keys */
  }
  return readLegacyLayout(specs)
}

function writeLegacyExplorer(layout: DockLayout) {
  const explorer = layout.panels.explorer
  if (!explorer) return
  const vertical = explorer.placement === "top" || explorer.placement === "bottom"
  localStorage.setItem("hanshu.explorerDock", explorer.placement)
  localStorage.setItem("hanshu.explorerLastEdge", explorer.lastEdge)
  if (!vertical && explorer.placement !== "float") {
    localStorage.setItem("hanshu.explorerWidth", String(Math.round(explorer.size)))
  }
  if (vertical) localStorage.setItem("hanshu.explorerHeight", String(Math.round(explorer.size)))
  localStorage.setItem(
    "hanshu.explorerFloat",
    JSON.stringify({
      x: Math.round(explorer.floatRect.x),
      y: Math.round(explorer.floatRect.y),
      w: Math.round(explorer.floatRect.w),
      h: Math.round(explorer.floatRect.h),
    }),
  )
}

function writeLayout(storageKey: string, layout: DockLayout) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout))
    if (storageKey === STORAGE_KEY) writeLegacyExplorer(layout)
  } catch {
    /* private mode: keep the layout in memory */
  }
}

function setRect(el: HTMLElement, rect: DockRect) {
  el.style.left = `${rect.x}px`
  el.style.top = `${rect.y}px`
  el.style.width = `${rect.w}px`
  el.style.height = `${rect.h}px`
}

function clampFloat(rect: DOMRect, box: FloatRect): FloatRect {
  const w = Math.min(Math.max(MIN_FLOAT_W, box.w), Math.max(MIN_FLOAT_W, rect.width - 16))
  const h = Math.min(Math.max(MIN_FLOAT_H, box.h), Math.max(MIN_FLOAT_H, rect.height - 16))
  const maxX = Math.max(0, rect.width - w)
  const maxY = Math.max(0, rect.height - h)
  return {
    x: Math.min(maxX, Math.max(0, box.x)),
    y: Math.min(maxY, Math.max(0, box.y)),
    w,
    h,
  }
}

function isInteractive(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, input, label, a, textarea, select"))
}

function tabBarFor(root: HTMLElement, panelId: string) {
  return [...root.querySelectorAll<HTMLElement>("[data-dock-tabs]")].find((bar) =>
    [...bar.querySelectorAll<HTMLElement>("[role=tab]")].some((tab) => tab.dataset.panelId === panelId),
  )
}

function pointerOnTabStrip(bar: HTMLElement, x: number, y: number) {
  const rect = bar.getBoundingClientRect()
  return x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4
}

function clearTabDrag(root: ParentNode | null | undefined) {
  root?.querySelectorAll<HTMLElement>("[data-dock-tabs]").forEach((bar) => {
    bar.classList.remove("is-reordering")
    bar.querySelectorAll<HTMLElement>("[role=tab]").forEach((tab) => {
      tab.style.order = ""
      tab.style.transform = ""
      tab.style.zIndex = ""
      tab.classList.remove("is-dragging")
    })
  })
}

function paintTabDrag(bar: HTMLElement, session: TitleSession, clientX: number, clientY: number) {
  const rects = session.tabRects
  if (!rects || rects.length < 2) return
  const home = session.tabHomeIndex ?? 0
  const insertAt = tabInsertIndex(rects, session.panelId, clientX, session.tabTargetIndex ?? home)
  session.tabTargetIndex = insertAt
  session.reordered = insertAt !== home
  const others = [...rects].filter((tab) => tab.id !== session.panelId).sort((a, b) => a.left - b.left)
  const order = others.map((tab) => tab.id)
  order.splice(Math.max(0, Math.min(insertAt, order.length)), 0, session.panelId)
  const slots = [...rects].sort((a, b) => a.left - b.left).map((tab) => tab.left)
  bar.classList.add("is-reordering")
  for (const tab of bar.querySelectorAll<HTMLElement>("[role=tab]")) {
    const id = tab.dataset.panelId ?? ""
    const item = rects.find((rect) => rect.id === id)
    if (!item) continue
    const grabbed = id === session.panelId
    const slot = slots[order.indexOf(id)] ?? item.left
    const dx = grabbed ? clientX - session.startX : slot - item.left
    const dy = grabbed ? Math.max(-8, Math.min(12, clientY - session.startY)) : 0
    tab.style.order = ""
    tab.style.transform = dx || dy ? `translate(${Math.round(dx)}px, ${Math.round(dy)}px)` : ""
    tab.style.zIndex = grabbed ? "4" : ""
    tab.classList.toggle("is-dragging", grabbed)
  }
}

function tabPlaceAt(root: HTMLElement, x: number, targetId: string): "before" | "after" | "end" {
  const bar = tabBarFor(root, targetId)
  const tab = bar
    ? [...bar.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.dataset.panelId === targetId)
    : undefined
  if (!tab) return "end"
  const rect = tab.getBoundingClientRect()
  return x < rect.left + rect.width / 2 ? "before" : "after"
}

export function PanelDock({
  panels,
  children,
  storageKey = STORAGE_KEY,
}: {
  panels: readonly DockPanelSpec[]
  children: ReactNode
  storageKey?: string
}) {
  const [layout, setLayout] = useState(() => readLayout(storageKey, panels))
  const layoutRef = useRef<DockLayout>(copyLayout(layout))
  const specsRef = useRef(panels)
  const visibleRef = useRef<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const zonesRef = useRef<HTMLDivElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const bandRefs = useRef(new Map<string, HTMLDivElement>())
  const sessionRef = useRef<Session | null>(null)
  const layoutRenderFrameRef = useRef<number | null>(null)
  const listenersRef = useRef<{
    move: (event: PointerEvent) => void
    up: (event: Event) => void
  } | null>(null)
  specsRef.current = panels
  visibleRef.current = new Set(panels.filter((panel) => panel.visible !== false).map((panel) => panel.id))

  const publish = (next: DockLayout) => {
    if (layoutRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutRenderFrameRef.current)
      layoutRenderFrameRef.current = null
    }
    const stored = copyLayout(next)
    layoutRef.current = stored
    setLayout(stored)
    writeLayout(storageKey, stored)
  }

  const scheduleLayoutRender = () => {
    if (layoutRenderFrameRef.current !== null) return
    layoutRenderFrameRef.current = window.requestAnimationFrame(() => {
      layoutRenderFrameRef.current = null
      setLayout(copyLayout(layoutRef.current))
    })
  }

  useEffect(() => {
    const onReset = (event: Event) => {
      const key = (event as CustomEvent<{ storageKey?: string }>).detail?.storageKey
      if (key && key !== storageKey) return
      endSession()
      publish(readLayout(storageKey, specsRef.current))
    }
    window.addEventListener(PANEL_DOCK_RESET_EVENT, onReset)
    return () => window.removeEventListener(PANEL_DOCK_RESET_EVENT, onReset)
  }, [storageKey])

  const specOf = (id: string) => specsRef.current.find((spec) => spec.id === id)

  const fitAgent = (rect: DOMRect) => {
    const current = layoutRef.current
    if (current.agentSized || !visibleRef.current.has("agent")) return false
    const agent = current.panels.agent
    if (!agent || agent.placement === "float" || isVertical(agent.placement)) {
      current.agentSized = true
      return true
    }
    const loc = findCell(current, "agent")
    if (!loc) {
      current.agentSized = true
      return true
    }
    const percent = readNumber("hanshu.agentPercent", 25, 70, 45)
    const visible = visibleRef.current
    const agentLane = current.lanes[loc.edge][loc.laneIndex]
    const others = [...current.lanes.left, ...current.lanes.right].filter(
      (lane) => lane !== agentLane && lane.cells.some((cell) => tabsOf(cell).some((id) => visible.has(id))),
    )
    const used = others.reduce((sum, lane) => sum + lane.size, 0) + DOCK_SASH * (others.length + 1)
    const room = rect.width - used
    const { min, max } = limitsFor(specOf("agent"), agent.placement)
    resizeLane(current, loc.edge, loc.laneIndex, clampSize(Math.round((room * percent) / 100), min, max), min, max)
    current.agentSized = true
    return true
  }

  const hideZones = () => {
    zonesRef.current?.classList.remove("is-open")
    zoneRef.current?.classList.remove("is-hot", "is-line", "is-tabs")
  }

  const showHit = (hit: DockHit) => {
    const zones = zonesRef.current
    const zone = zoneRef.current
    if (!zones || !zone || hit.kind === "float" || !hit.preview) {
      hideZones()
      return
    }
    zones.classList.add("is-open")
    zones.style.zIndex = "1000"
    zone.classList.add("is-hot")
    zone.classList.toggle("is-tabs", hit.kind === "tabs")
    zone.classList.toggle("is-line", hit.kind !== "tabs" && hit.line)
    setRect(zone, hit.preview)
  }

  const applyGeometry = () => {
    const root = rootRef.current
    const main = mainRef.current
    if (!root || !main) return null
    const rect = root.getBoundingClientRect()
    if (rect.width < 16 || rect.height < 16) return null
    if (!sessionRef.current && fitAgent(rect)) publish(layoutRef.current)
    const frame = layoutFrame(layoutRef.current, rect, visibleRef.current)
    setRect(main, frame.main)
    for (const spec of specsRef.current) {
      const band = bandRefs.current.get(spec.id)
      const panel = layoutRef.current.panels[spec.id]
      if (!band || !panel) continue
      const shown = visibleRef.current.has(spec.id)
      band.style.display = shown ? "" : "none"
      if (!shown) continue
      band.classList.toggle("is-float", panel.placement === "float")
      if (panel.placement === "float") {
        const group = floatGroupFor(layoutRef.current, spec.id)
        const members = (group?.tabs ?? [spec.id]).filter((id) => visibleRef.current.has(id))
        const shown = members.includes(group?.active ?? "") ? group?.active : members[0]
        if (shown !== spec.id) {
          band.style.display = "none"
          continue
        }
        const tabH = members.length > 1 ? DOCK_TAB_H : 0
        const box = panel.floatRect
        setRect(band, { x: box.x, y: box.y + tabH, w: box.w, h: Math.max(0, box.h - tabH) })
        band.style.zIndex = String(40 + panel.z)
        continue
      }
      const box = frame.bands[spec.id]
      if (!box) {
        band.style.display = "none"
        continue
      }
      setRect(band, box)
      band.style.zIndex = "1"
    }
    root.querySelectorAll<HTMLElement>("[data-dock-tabs]").forEach((el) => {
      const key = el.dataset.dockTabs ?? ""
      const bar = frame.tabBars.find((item) => item.key === key)
      if (bar) {
        el.style.display = ""
        el.style.zIndex = "5"
        setRect(el, bar.rect)
        return
      }
      const group = (layoutRef.current.floatGroups ?? []).find((item) => {
        const tabs = item.tabs.filter((id) => visibleRef.current.has(id)).sort().join(",")
        return key === `float-tabs:${tabs}`
      })
      const activeId = group
        ? group.tabs.find((id) => visibleRef.current.has(id) && id === group.active) ??
          group.tabs.find((id) => visibleRef.current.has(id))
        : undefined
      const host = activeId ? layoutRef.current.panels[activeId] : undefined
      if (!host || host.placement !== "float") {
        el.style.display = "none"
        return
      }
      el.style.display = ""
      el.style.zIndex = String(41 + host.z)
      setRect(el, { x: host.floatRect.x, y: host.floatRect.y, w: host.floatRect.w, h: DOCK_TAB_H })
    })
    root.querySelectorAll<HTMLElement>("[data-dock-sash]").forEach((el) => {
      const key = el.dataset.dockSash ?? ""
      const sash = frame.sashes.find((item) => item.key === key)
      if (!sash) {
        el.style.display = "none"
        return
      }
      el.style.display = ""
      setRect(el, sash.rect)
    })
    root.classList.add("is-measured")
    return frame
  }

  const endSession = () => {
    if (layoutRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutRenderFrameRef.current)
      layoutRenderFrameRef.current = null
    }
    const listeners = listenersRef.current
    clearTabDrag(rootRef.current)
    if (listeners) {
      window.removeEventListener("pointermove", listeners.move, true)
      window.removeEventListener("pointerup", listeners.up, true)
      window.removeEventListener("pointercancel", listeners.up, true)
      window.removeEventListener("blur", listeners.up)
      listenersRef.current = null
    }
    sessionRef.current = null
    hideZones()
    document.body.classList.remove("is-panel-dragging", "is-float-resizing", "is-resizing", "is-resizing-y")
    document.body.style.cursor = ""
  }

  const columnRect = (panelId: string): FloatRect | null => {
    const root = rootRef.current?.getBoundingClientRect()
    const layout = layoutRef.current
    const panel = layout.panels[panelId]
    if (!root || !panel) return null
    const loc = findCell(layout, panelId)
    if (loc) {
      const frame = layoutFrame(layout, root, visibleRef.current)
      const cell = layout.lanes[loc.edge][loc.laneIndex].cells[loc.cellIndex]
      const host = bandId(cell, visibleRef.current)
      const box = host ? frame.slots[host] : undefined
      if (box && box.w > 8 && box.h > 8) return { x: box.x, y: box.y, w: box.w, h: box.h }
    }
    const group = floatGroupFor(layout, panelId)
    const hostId =
      group?.tabs.find((id) => id === group.active && layout.panels[id]?.placement === "float") ??
      (panel.placement === "float" ? panelId : "")
    if (hostId) {
      const band = bandRefs.current.get(hostId)?.getBoundingClientRect()
      const tabCount = (group?.tabs ?? [hostId]).filter((id) => visibleRef.current.has(id)).length
      const tabH = tabCount > 1 ? DOCK_TAB_H : 0
      if (band && band.width > 8 && band.height > 8) {
        return {
          x: band.left - root.left,
          y: band.top - root.top - tabH,
          w: band.width,
          h: band.height + tabH,
        }
      }
      const host = layout.panels[hostId]
      if (host) return { ...host.floatRect }
    }
    const band = bandRefs.current.get(panelId)?.getBoundingClientRect()
    if (band && band.width > 8 && band.height > 8) {
      return { x: band.left - root.left, y: band.top - root.top, w: band.width, h: band.height }
    }
    return null
  }

  const placeFloat = (panelId: string, clientX: number, clientY: number, offsetX: number, offsetY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const panel = layoutRef.current.panels[panelId]
    if (!rect || !panel) return
    const lift = sessionRef.current?.kind === "title" ? sessionRef.current.lift : undefined
    const w =
      lift?.w ??
      (panel.placement === "float" ? panel.floatRect.w : Math.min(FLOAT_W, Math.max(MIN_FLOAT_W, rect.width - 16)))
    const h =
      lift?.h ??
      (panel.placement === "float" ? panel.floatRect.h : Math.min(FLOAT_H, Math.max(MIN_FLOAT_H, rect.height - 16)))
    panel.floatRect = clampFloat(rect, {
      x: clientX - rect.left - offsetX,
      y: clientY - rect.top - offsetY,
      w,
      h,
    })
    const dragGroup = sessionRef.current?.kind === "title" && !sessionRef.current.activateOnClick
    if (dragGroup) liftColumn(layoutRef.current, panelId)
    else if (panel.placement !== "float") detach(layoutRef.current, panelId)
    else if (floatGroupFor(layoutRef.current, panelId)) removePanel(layoutRef.current, panelId)
  }

  const hitAt = (clientX: number, clientY: number, panelId?: string) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const frame = applyGeometry()
    if (!rect || !frame) return { kind: "float", preview: null, line: false } as DockHit
    const floats: Record<string, DockRect> = {}
    const mover = panelId ? layoutRef.current.panels[panelId] : undefined
    if (panelId) {
      const group =
        sessionRef.current?.kind === "title" && !sessionRef.current.activateOnClick
          ? floatGroupFor(layoutRef.current, panelId)
          : null
      for (const [id, panel] of Object.entries(layoutRef.current.panels)) {
        if (id === panelId || panel.placement !== "float" || !visibleRef.current.has(id)) continue
        if (group?.tabs.includes(id)) continue
        floats[id] = panel.floatRect
      }
    }
    let moverRect = mover?.placement === "float" ? { ...mover.floatRect } : undefined
    if (panelId && rootRef.current) {
      const band = bandRefs.current.get(panelId)?.getBoundingClientRect()
      if (band && band.width > 8 && band.height > 8) {
        let top = band.top
        let bottom = band.bottom
        let left = band.left
        let right = band.right
        const bar = tabBarFor(rootRef.current, panelId)
        if (bar && bar.style.display !== "none") {
          const tabBox = bar.getBoundingClientRect()
          if (tabBox.width > 8 && tabBox.height > 2) {
            top = Math.min(top, tabBox.top)
            bottom = Math.max(bottom, tabBox.bottom)
            left = Math.min(left, tabBox.left)
            right = Math.max(right, tabBox.right)
          }
        }
        moverRect = {
          x: left - rect.left,
          y: top - rect.top,
          w: right - left,
          h: bottom - top,
        }
      }
    }
    return hitDock(rect, { x: clientX - rect.left, y: clientY - rect.top }, frame.slots, {
      ignoreId: panelId,
      mover: moverRect,
      floats,
    })
  }

  const startSession = (session: Session, cursor = "") => {
    endSession()
    sessionRef.current = session
    const move = (event: PointerEvent) => {
      const active = sessionRef.current
      if (!active || event.pointerId !== active.pointerId) return
      const root = rootRef.current
      const rect = root?.getBoundingClientRect()
      if (!root || !rect) return
      if (active.kind === "title") {
        active.clientX = event.clientX
        active.clientY = event.clientY
        const dx = event.clientX - active.startX
        const dy = event.clientY - active.startY
        const travel = Math.hypot(dx, dy)
        if (active.activateOnClick && !active.detached) {
          const bar = tabBarFor(root, active.panelId)
          const reorder =
            Boolean(
              bar &&
                active.tabRects &&
                pointerOnTabStrip(bar, event.clientX, event.clientY) &&
                Math.abs(dx) >= 3 &&
                Math.abs(dx) > Math.abs(dy) * 1.25,
            )
          if (reorder && bar) {
            paintTabDrag(bar, active, event.clientX, event.clientY)
            hideZones()
            return
          }
          if (travel < 8) return
          clearTabDrag(root)
          active.reordered = false
        } else if (!active.moved && travel < 8) {
          return
        }
        if (!active.moved) {
          active.moved = true
          active.detached = true
          document.body.classList.add("is-panel-dragging")
          const origin = columnRect(active.panelId)
          const panel = layoutRef.current.panels[active.panelId]
          if (origin && panel) {
            const docked = panel.placement !== "float"
            const w = docked ? Math.min(FLOAT_W, Math.max(MIN_FLOAT_W, rect.width - 16)) : origin.w
            const h = docked ? Math.min(FLOAT_H, Math.max(MIN_FLOAT_H, rect.height - 16)) : origin.h
            let offsetX = event.clientX - rect.left - origin.x
            let offsetY = event.clientY - rect.top - origin.y
            if (docked) {
              offsetX = Math.min(Math.max(16, offsetX), Math.max(16, w - 24))
              offsetY = Math.min(Math.max(8, offsetY), 28)
            }
            const box = {
              x: event.clientX - rect.left - offsetX,
              y: event.clientY - rect.top - offsetY,
              w,
              h,
            }
            active.lift = box
            active.offsetX = offsetX
            active.offsetY = offsetY
            panel.floatRect = { ...box }
          }
        }
        const wasFloat = layoutRef.current.panels[active.panelId]?.placement === "float"
        placeFloat(active.panelId, event.clientX, event.clientY, active.offsetX, active.offsetY)
        const hit = hitAt(event.clientX, event.clientY, active.panelId)
        showHit(hit)
        if (!wasFloat && !active.announced) {
          active.announced = true
          scheduleLayoutRender()
        }
        return
      }
      if (active.kind === "sash") {
        const delta = (active.axis === "x" ? event.clientX : event.clientY) - active.start
        const signed = active.invert ? -delta : delta
        if (active.cellIndex == null) {
          resizeLane(
            layoutRef.current,
            active.edge,
            active.laneIndex,
            active.startSize + signed,
            active.min,
            active.max,
          )
        } else {
          const pair = active.startA + active.startB
          const nextA = clampSize(active.startA + signed, Math.min(72, pair), Math.max(72, pair - 72))
          setCellPixels(
            layoutRef.current,
            active.edge,
            active.laneIndex,
            active.cellIndex,
            nextA,
            pair - nextA,
            active.startCross,
            visibleRef.current,
          )
        }
        applyGeometry()
        return
      }
      const panel = layoutRef.current.panels[active.panelId]
      if (!panel) return
      const dx = event.clientX - active.startX
      const dy = event.clientY - active.startY
      let { x, y, w, h } = active.origin
      if (active.edges.includes("e")) w += dx
      if (active.edges.includes("s")) h += dy
      if (active.edges.includes("w")) {
        x += dx
        w -= dx
      }
      if (active.edges.includes("n")) {
        y += dy
        h -= dy
      }
      if (w < MIN_FLOAT_W) {
        if (active.edges.includes("w")) x -= MIN_FLOAT_W - w
        w = MIN_FLOAT_W
      }
      if (h < MIN_FLOAT_H) {
        if (active.edges.includes("n")) y -= MIN_FLOAT_H - h
        h = MIN_FLOAT_H
      }
      panel.floatRect = clampFloat(rect, { x, y, w, h })
      syncFloatGroup(layoutRef.current, active.panelId)
      applyGeometry()
    }
    const up = (event: Event) => {
      const active = sessionRef.current
      if (!active) return
      if (event instanceof PointerEvent && event.pointerId !== active.pointerId) return
      if (active.kind === "title" && !active.detached) {
        const activate = active.activateOnClick
        const panelId = active.panelId
        if (activate) {
          if (active.reordered && active.tabTargetIndex !== undefined) {
            orderTab(layoutRef.current, panelId, active.tabTargetIndex, visibleRef.current)
          }
          activateTab(layoutRef.current, panelId)
        }
        const next = copyLayout(layoutRef.current)
        endSession()
        if (activate) publish(next)
        return
      }
      if (active.kind === "title" && active.moved && event instanceof PointerEvent && event.type === "pointerup") {
        const root = rootRef.current
        const panel = layoutRef.current.panels[active.panelId]
        const rawHit = hitAt(event.clientX, event.clientY, active.panelId)
        const hit =
          rawHit.kind === "tabs" && root
            ? {
                ...rawHit,
                place: tabPlaceAt(root, event.clientX, rawHit.panelId),
              }
            : rawHit
        if (panel) {
          const targetId = hit.kind === "panel" || hit.kind === "tabs" ? hit.panelId : ""
          const dockEdge = targetId ? layoutRef.current.panels[targetId]?.placement : hit.kind === "window" ? hit.edge : panel.lastEdge
          const sizeEdge = dockEdge && dockEdge !== "float" ? dockEdge : panel.lastEdge
          const stick = active.activateOnClick ? applyStick : stickGroup
          stick(layoutRef.current, active.panelId, hit, sizeForDock(panel, sizeEdge, specOf(active.panelId)))
        }
      }
      const next = copyLayout(layoutRef.current)
      endSession()
      layoutRef.current = next
      applyGeometry()
      publish(next)
    }
    listenersRef.current = { move, up }
    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", up, true)
    window.addEventListener("pointercancel", up, true)
    window.addEventListener("blur", up)
    if (cursor) document.body.style.cursor = cursor
  }

  useLayoutEffect(() => {
    const merged = mergeSpecs(layoutRef.current, panels)
    const base = merged === layoutRef.current ? layoutRef.current : merged
    const healed = !sessionRef.current && dockOrphans(base)
    if (healed || base !== layoutRef.current) {
      const stored = copyLayout(base)
      layoutRef.current = stored
      setLayout(stored)
      writeLayout(storageKey, stored)
    }
    const session = sessionRef.current
    if (session?.kind === "title" && session.moved) {
      showHit(hitAt(session.clientX, session.clientY, session.panelId))
      return
    }
    applyGeometry()
    if (!session) hideZones()
  })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      if (sessionRef.current) return
      const rect = root.getBoundingClientRect()
      if (rect.width < 16 || rect.height < 16) return
      const next = copyLayout(layoutRef.current)
      let changed = false
      for (const panel of Object.values(next.panels)) {
        if (panel.placement !== "float") continue
        const clamped = clampFloat(rect, panel.floatRect)
        if (
          clamped.x !== panel.floatRect.x ||
          clamped.y !== panel.floatRect.y ||
          clamped.w !== panel.floatRect.w ||
          clamped.h !== panel.floatRect.h
        ) {
          panel.floatRect = clamped
          changed = true
        }
      }
      if (changed) publish(next)
      applyGeometry()
    })
    observer.observe(root)
    return () => observer.disconnect()
    // Geometry lives in refs; the observer is bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // endSession only touches refs; the empty deps cleanup is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => endSession(), [])

  const onTitlePointerDown = (panelId: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractive(event.target)) return
    event.preventDefault()
    const panel = layoutRef.current.panels[panelId]
    if (!panel) return
    const maxZ = Math.max(1, ...Object.values(layoutRef.current.panels).map((item) => item.z))
    panel.z = maxZ + 1
    const rect = rootRef.current?.getBoundingClientRect()
    const origin = columnRect(panelId)
    if (origin) panel.floatRect = { ...origin }
    if (panel.placement === "float") syncFloatGroup(layoutRef.current, panelId)
    const offsetX = origin && rect ? event.clientX - rect.left - origin.x : LIFT_OFFSET_X
    const offsetY = origin && rect ? event.clientY - rect.top - origin.y : LIFT_OFFSET_Y
    startSession({
      kind: "title",
      panelId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX,
      offsetY,
      moved: false,
      announced: false,
      reordered: false,
      detached: false,
      lift: origin ?? undefined,
    })
  }

  const onTabPointerDown = (panelId: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const panel = layoutRef.current.panels[panelId]
    if (!panel) return
    const maxZ = Math.max(1, ...Object.values(layoutRef.current.panels).map((item) => item.z))
    panel.z = maxZ + 1
    const bar = tabBarFor(rootRef.current!, panelId)
    const tabElements = bar ? [...bar.querySelectorAll<HTMLElement>("[role=tab]")] : []
    const tabOrder = tabElements.map((tab) => tab.dataset.panelId ?? "").filter(Boolean)
    const tabRect = event.currentTarget.getBoundingClientRect()
    const tabRects = tabElements.flatMap((tab) => {
      const id = tab.dataset.panelId ?? ""
      const rect = tab.getBoundingClientRect()
      return id && rect.width > 0 ? [{ id, left: rect.left, width: rect.width }] : []
    })
    const rect = rootRef.current?.getBoundingClientRect()
    const origin = columnRect(panelId)
    if (origin) panel.floatRect = { ...origin }
    startSession({
      kind: "title",
      panelId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: origin && rect ? event.clientX - rect.left - origin.x : LIFT_OFFSET_X,
      offsetY: origin && rect ? event.clientY - rect.top - origin.y : LIFT_OFFSET_Y,
      moved: false,
      announced: false,
      reordered: false,
      detached: false,
      activateOnClick: true,
      lift: origin ?? undefined,
      tabOrder,
      tabRects,
      tabOffset: event.clientX - tabRect.left,
      tabWidth: tabRect.width,
      tabHomeIndex: Math.max(0, [...tabRects].sort((a, b) => a.left - b.left).findIndex((tab) => tab.id === panelId)),
      tabTargetIndex: Math.max(0, [...tabRects].sort((a, b) => a.left - b.left).findIndex((tab) => tab.id === panelId)),
    })
  }

  const onSashPointerDown = (sash: DockSash, event: ReactPointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const lane = layoutRef.current.lanes[sash.edge][sash.laneIndex]
    const rect = rootRef.current?.getBoundingClientRect()
    const frame = rect ? layoutFrame(layoutRef.current, rect, visibleRef.current) : null
    const shown = lane?.cells.filter((cell) => tabsOf(cell).some((id) => visibleRef.current.has(id))) ?? []
    const first = shown[0]
    const band = first ? frame?.bands[bandId(first, visibleRef.current) ?? ""] : undefined
    let startA = 0
    let startB = 0
    let startCross = rect ? (isVertical(sash.edge) ? frame?.main.w ?? rect.width : rect.height) : 0
    if (sash.cellIndex != null && lane) {
      const a = lane.cells[sash.cellIndex]
      const bIndex = lane.cells.findIndex((cell, index) => index > sash.cellIndex! && tabsOf(cell).some((id) => visibleRef.current.has(id)))
      const b = lane.cells[bIndex]
      const aBox = a ? frame?.bands[bandId(a, visibleRef.current) ?? ""] : undefined
      const bBox = b ? frame?.bands[bandId(b, visibleRef.current) ?? ""] : undefined
      const verticalCells = sash.edge === "left" || sash.edge === "right"
      startA = verticalCells ? aBox?.h ?? 0 : aBox?.w ?? 0
      startB = verticalCells ? bBox?.h ?? 0 : bBox?.w ?? 0
      startCross = verticalCells ? rect?.height ?? 0 : frame?.main.w ?? 0
    }
    const limits = limitsFor(specOf(sash.panelId), sash.edge)
    const slack = frame ? Math.max(0, (isVertical(sash.edge) ? frame.main.h - MIN_CENTER_H : frame.main.w - MIN_CENTER_W)) : 0
    const displayed = band ? (isVertical(sash.edge) ? band.h : band.w) : lane?.size ?? limits.min
    startSession(
      {
        kind: "sash",
        pointerId: event.pointerId,
        axis: sash.axis,
        invert: sash.invert,
        start: sash.axis === "x" ? event.clientX : event.clientY,
        edge: sash.edge,
        laneIndex: sash.laneIndex,
        cellIndex: sash.cellIndex,
        startSize: displayed,
        startCross,
        startA,
        startB,
        min: limits.min,
        max: Math.max(limits.min, Math.min(limits.max, displayed + slack)),
      },
      sash.axis === "x" ? "col-resize" : "row-resize",
    )
    document.body.classList.add(sash.axis === "x" ? "is-resizing" : "is-resizing-y")
  }

  const resetSize = (sash: DockSash) => {
    const panel = layoutRef.current.panels[sash.panelId]
    if (!panel || panel.placement === "float") return
    const next = copyLayout(layoutRef.current)
    if (sash.cellIndex != null) {
      resetCellWeights(next, sash.edge, sash.laneIndex)
      publish(next)
      return
    }
    const spec = specOf(sash.panelId)
    const fallback = isVertical(sash.edge) ? DOCK_DEFAULT_H : DOCK_DEFAULT_W
    const { min, max } = limitsFor(spec, sash.edge)
    resizeLane(next, sash.edge, sash.laneIndex, clampSize(spec?.defaultSize ?? fallback, min, max), min, max)
    publish(next)
  }

  const onResizeDown = (panelId: string, edges: string, cursor: string) => (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const panel = layoutRef.current.panels[panelId]
    if (!panel) return
    startSession(
      {
        kind: "resize",
        panelId,
        pointerId: event.pointerId,
        edges,
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...panel.floatRect },
      },
      cursor,
    )
    document.body.classList.add("is-float-resizing")
  }

  const redock = (panelId: string) => {
    const panel = layoutRef.current.panels[panelId]
    if (!panel) return
    const next = copyLayout(layoutRef.current)
    dockToEdge(next, panelId, panel.lastEdge, sizeForDock(panel, panel.lastEdge, specOf(panelId)), "inner")
    publish(next)
  }

  const labelOf = (id: string) => specOf(id)?.title || id
  const tabStrips = [
    ...DOCK_EDGES.flatMap((edge) =>
      layout.lanes[edge].flatMap((lane, laneIndex) =>
        lane.cells.flatMap((cell, cellIndex) => {
          const tabs = tabsOf(cell).filter((id) => visibleRef.current.has(id))
          if (tabs.length < 2) return []
          const active = tabs.includes(cell.id) ? cell.id : tabs[0]
          return [{ key: `tabs:${edge}:${laneIndex}:${cellIndex}`, tabs: tabs.map((id) => ({ id, active: id === active })) }]
        }),
      ),
    ),
    ...(layout.floatGroups ?? []).flatMap((group) => {
      const tabs = group.tabs.filter((id) => visibleRef.current.has(id))
      if (tabs.length < 2) return []
      const active = tabs.includes(group.active) ? group.active : tabs[0]
      return [{ key: `float-tabs:${[...tabs].sort().join(",")}`, tabs: tabs.map((id) => ({ id, active: id === active })) }]
    }),
  ]
  const sashItems = layoutFrame(layout, { width: 1200, height: 800 }, visibleRef.current).sashes
  const handlesFor = (panelId: string) =>
    (
      [
        ["n", "ns-resize"],
        ["s", "ns-resize"],
        ["e", "ew-resize"],
        ["w", "ew-resize"],
        ["ne", "nesw-resize"],
        ["nw", "nwse-resize"],
        ["se", "nwse-resize"],
        ["sw", "nesw-resize"],
      ] as const
    ).map(([edges, cursor]) => (
      <div
        key={edges}
        className={`explorer-float-handle ${edges}`}
        onPointerDown={onResizeDown(panelId, edges, cursor)}
      />
    ))

  return (
    <div ref={rootRef} className="workspace panel-dock">
      {panels.map((spec) => {
        const record = layout.panels[spec.id]
        if (!record) return null
        const floating = record.placement === "float"
        return (
          <div
            key={spec.id}
            ref={(node) => {
              if (node) bandRefs.current.set(spec.id, node)
              else bandRefs.current.delete(spec.id)
            }}
            className={`panel-dock-band${floating ? " is-float" : ""}`}
            data-panel-id={spec.id}
          >
            {spec.render({
              placement: record.placement,
              onTitlePointerDown: onTitlePointerDown(spec.id),
              onRedock: floating ? () => redock(spec.id) : undefined,
            })}
            {floating && handlesFor(spec.id)}
          </div>
        )
      })}
      <div ref={mainRef} className="panel-dock-main">
        {children}
      </div>
      {tabStrips.map((strip) => (
        <div
          key={strip.key}
          data-dock-tabs={strip.key}
          className="panel-dock-tabs"
          onPointerDown={(event) => {
            if (event.button !== 0 || isInteractive(event.target)) return
            if (event.target instanceof Element && event.target.closest("[role=tab]")) return
            const activeId = strip.tabs.find((tab) => tab.active)?.id
            if (activeId) onTitlePointerDown(activeId)(event)
          }}
        >
          {strip.tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.active}
              data-panel-id={tab.id}
              className={`panel-dock-tab${tab.active ? " is-active" : ""}`}
              title={labelOf(tab.id)}
              onPointerDown={onTabPointerDown(tab.id)}
            >
              <span>{labelOf(tab.id)}</span>
            </div>
          ))}
          <div className="panel-dock-tab-gap" />
        </div>
      ))}
      {sashItems.map((sash) => (
        <div
          key={sash.key}
          data-dock-sash={sash.key}
          className={sash.axis === "x" ? "panel-dock-sash is-col" : "panel-dock-sash is-row"}
          title={sash.axis === "x" ? SASH_X : SASH_Y}
          onPointerDown={(event) => onSashPointerDown(sash, event)}
          onDoubleClick={() => resetSize(sash)}
        />
      ))}
      <div ref={zonesRef} className="panel-dock-zones">
        <div ref={zoneRef} className="panel-dock-zone" />
      </div>
    </div>
  )
}
