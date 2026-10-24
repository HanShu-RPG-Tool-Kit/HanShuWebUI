import {
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
  DOCK_MAX_H,
  DOCK_MAX_W,
  DOCK_MIN_H,
  DOCK_MIN_W,
  DOCK_SASH,
  applyStick,
  copyLayout,
  defaultRecord,
  detach,
  dockToEdge,
  findCell,
  hitDock,
  isVertical,
  layoutFrame,
  layoutFromSaved,
  limitsFor,
  mergeSpecs,
  resetCellWeights,
  resizeLane,
  setCellPixels,
  sizeForDock,
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
const MIN_FLOAT_W = 220
const MIN_FLOAT_H = 160
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

function readLegacyLayout(specs: readonly DockPanelSpec[]): DockLayout {
  const dock = readEnum("hanshu.explorerDock", ["left", "right", "top", "bottom", "float"] as const, "left")
  const lastEdge = readEnum("hanshu.explorerLastEdge", DOCK_EDGES, dock === "float" ? "left" : dock)
  const width = readNumber("hanshu.explorerWidth", DOCK_MIN_W, DOCK_MAX_W, DOCK_DEFAULT_W)
  const height = readNumber("hanshu.explorerHeight", DOCK_MIN_H, DOCK_MAX_H, DOCK_DEFAULT_H)
  const layout: DockLayout = { version: 2, agentSized: false, lanes: { left: [], right: [], top: [], bottom: [] }, panels: {} }
  for (const spec of specs) layout.panels[spec.id] = defaultRecord(spec)
  const explorer = layout.panels.explorer
  if (explorer) {
    explorer.placement = dock
    explorer.lastEdge = lastEdge
    explorer.size = dock === "top" || dock === "bottom" ? height : width
    explorer.floatRect = readLegacyFloat()
    if (dock !== "float") dockToEdge(layout, "explorer", dock, explorer.size, "outer")
  }
  for (const id of ["agent", "roles"] as const) {
    const panel = layout.panels[id]
    if (panel && panel.placement !== "float") dockToEdge(layout, id, panel.placement, panel.size, "inner")
  }
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
  const maxX = Math.max(0, rect.width - 48)
  const maxY = Math.max(0, rect.height - 28)
  return {
    x: Math.min(maxX, Math.max(-w + 48, box.x)),
    y: Math.min(maxY, Math.max(0, box.y)),
    w,
    h,
  }
}

function isInteractive(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, input, label, a, textarea, select"))
}

function opposite(edge: DockEdge): DockEdge {
  if (edge === "left") return "right"
  if (edge === "right") return "left"
  if (edge === "top") return "bottom"
  return "top"
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
  const listenersRef = useRef<{
    move: (event: PointerEvent) => void
    up: (event: Event) => void
  } | null>(null)
  specsRef.current = panels
  visibleRef.current = new Set(panels.filter((panel) => panel.visible !== false).map((panel) => panel.id))

  const publish = (next: DockLayout) => {
    const stored = copyLayout(next)
    layoutRef.current = stored
    setLayout(stored)
    writeLayout(storageKey, stored)
  }

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
      (lane) => lane !== agentLane && lane.cells.some((cell) => visible.has(cell.id)),
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
    zoneRef.current?.classList.remove("is-hot")
  }

  const showHit = (hit: DockHit) => {
    const zones = zonesRef.current
    const zone = zoneRef.current
    if (!zones || !zone || hit.kind === "float" || !hit.preview) {
      hideZones()
      return
    }
    zones.classList.add("is-open")
    zone.classList.add("is-hot")
    zone.classList.toggle("is-line", hit.line)
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
        setRect(band, panel.floatRect)
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
    const listeners = listenersRef.current
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

  const placeFloat = (panelId: string, clientX: number, clientY: number, offsetX: number, offsetY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const panel = layoutRef.current.panels[panelId]
    if (!rect || !panel) return
    const bandBox = bandRefs.current.get(panelId)?.getBoundingClientRect()
    const w =
      panel.placement === "float"
        ? panel.floatRect.w
        : Math.min(560, Math.max(MIN_FLOAT_W, bandBox?.width ?? panel.size))
    const h =
      panel.placement === "float"
        ? panel.floatRect.h
        : Math.min(640, Math.max(MIN_FLOAT_H, Math.min(bandBox?.height ?? 420, 560)))
    panel.floatRect = clampFloat(rect, {
      x: clientX - rect.left - offsetX,
      y: clientY - rect.top - offsetY,
      w,
      h,
    })
    if (panel.placement !== "float") detach(layoutRef.current, panelId)
  }

  const hitAt = (clientX: number, clientY: number, panelId?: string) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const frame = applyGeometry()
    if (!rect || !frame) return { kind: "float", preview: null, line: false } as DockHit
    const floats: Record<string, DockRect> = {}
    const mover = panelId ? layoutRef.current.panels[panelId] : undefined
    if (panelId) {
      for (const [id, panel] of Object.entries(layoutRef.current.panels)) {
        if (id === panelId || panel.placement !== "float" || !visibleRef.current.has(id)) continue
        floats[id] = panel.floatRect
      }
    }
    return hitDock(rect, { x: clientX - rect.left, y: clientY - rect.top }, frame.bands, {
      ignoreId: panelId,
      mover: mover?.placement === "float" ? mover.floatRect : undefined,
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
        if (!active.moved) {
          if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 4) return
          active.moved = true
          document.body.classList.add("is-panel-dragging")
          const panel = layoutRef.current.panels[active.panelId]
          if (panel && panel.placement !== "float") {
            active.offsetX = LIFT_OFFSET_X
            active.offsetY = LIFT_OFFSET_Y
          }
        }
        active.clientX = event.clientX
        active.clientY = event.clientY
        const wasFloat = layoutRef.current.panels[active.panelId]?.placement === "float"
        placeFloat(active.panelId, event.clientX, event.clientY, active.offsetX, active.offsetY)
        const hit = hitAt(event.clientX, event.clientY, active.panelId)
        showHit(hit)
        if (!wasFloat && !active.announced) {
          active.announced = true
          setLayout(copyLayout(layoutRef.current))
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
      applyGeometry()
    }
    const up = (event: Event) => {
      const active = sessionRef.current
      if (!active) return
      if (event instanceof PointerEvent && event.pointerId !== active.pointerId) return
      if (active.kind === "title" && !active.moved) {
        endSession()
        return
      }
      if (active.kind === "title" && active.moved && event instanceof PointerEvent) {
        const panel = layoutRef.current.panels[active.panelId]
        const hit = hitAt(event.clientX, event.clientY, active.panelId)
        if (panel) {
          const edge = hit.kind === "window" ? hit.edge : hit.kind === "panel" ? layoutRef.current.panels[hit.panelId]?.lastEdge ?? panel.lastEdge : panel.lastEdge
          const dockEdge = hit.kind === "panel" ? layoutRef.current.panels[hit.panelId]?.placement : edge
          const sizeEdge = dockEdge && dockEdge !== "float" ? dockEdge : panel.lastEdge
          applyStick(layoutRef.current, active.panelId, hit, sizeForDock(panel, sizeEdge, specOf(active.panelId)))
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
    if (merged !== layoutRef.current) {
      layoutRef.current = merged
      setLayout(copyLayout(merged))
      writeLayout(storageKey, merged)
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
    const offsetX = rect ? event.clientX - rect.left - panel.floatRect.x : LIFT_OFFSET_X
    const offsetY = rect ? event.clientY - rect.top - panel.floatRect.y : LIFT_OFFSET_Y
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
    })
  }

  const onSashPointerDown = (sash: DockSash, event: ReactPointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const lane = layoutRef.current.lanes[sash.edge][sash.laneIndex]
    const rect = rootRef.current?.getBoundingClientRect()
    const frame = rect ? layoutFrame(layoutRef.current, rect, visibleRef.current) : null
    const shown = lane?.cells.filter((cell) => visibleRef.current.has(cell.id)) ?? []
    const first = shown[0]
    const band = first ? frame?.bands[first.id] : undefined
    let startA = 0
    let startB = 0
    let startCross = rect ? (isVertical(sash.edge) ? frame?.main.w ?? rect.width : rect.height) : 0
    if (sash.cellIndex != null && lane) {
      const a = lane.cells[sash.cellIndex]
      const bIndex = lane.cells.findIndex((cell, index) => index > sash.cellIndex! && visibleRef.current.has(cell.id))
      const b = lane.cells[bIndex]
      const aBox = a ? frame?.bands[a.id] : undefined
      const bBox = b ? frame?.bands[b.id] : undefined
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
