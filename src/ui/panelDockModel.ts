export type DockEdge = "left" | "right" | "top" | "bottom"
export type DockPlacement = DockEdge | "float"
export type DockRect = { x: number; y: number; w: number; h: number }
export type FloatRect = DockRect

export type DockCell = { id: string; tabs?: string[]; weight: number }
export type DockLane = { size: number; cells: DockCell[] }
export type DockTabGroup = { tabs: string[]; active: string }

export type DockPanelRecord = {
  placement: DockPlacement
  lastEdge: DockEdge
  size: number
  floatRect: FloatRect
  z: number
}

export type DockLayout = {
  version: 2 | 3
  agentSized: boolean
  lanes: Record<DockEdge, DockLane[]>
  panels: Record<string, DockPanelRecord>
  floatGroups?: DockTabGroup[]
}

export type DockSpec = {
  id: string
  defaultPlacement?: DockPlacement
  defaultSize?: number
  minSize?: number
  maxSize?: number
  defaultFloat?: FloatRect
}

export type DockHit =
  | { kind: "float"; preview: null; line: false }
  | { kind: "window"; edge: DockEdge; preview: DockRect; line: boolean }
  | { kind: "panel"; panelId: string; side: DockEdge; preview: DockRect; line: boolean }
  | { kind: "tabs"; panelId: string; preview: DockRect; line: false; place?: "before" | "after" | "end" }

export type DockSash = {
  key: string
  axis: "x" | "y"
  invert: boolean
  edge: DockEdge
  laneIndex: number
  cellIndex: number | null
  panelId: string
  rect: DockRect
}

export type DockTabBar = {
  key: string
  rect: DockRect
  tabs: { id: string; active: boolean }[]
}

export type DockFrame = {
  bands: Record<string, DockRect>
  slots: Record<string, DockRect>
  sashes: DockSash[]
  tabBars: DockTabBar[]
  main: DockRect
}

export const DOCK_EDGES = ["left", "right", "top", "bottom"] as const
export const DOCK_SASH = 6
export const DOCK_TAB_H = 26
export const DOCK_HIT = 12
export const DOCK_SIDE_PREVIEW = 12
export const DOCK_LINE_PREVIEW = 2
export const DOCK_MIN_W = 160
export const DOCK_MAX_W = 640
export const DOCK_MIN_H = 120
export const DOCK_MAX_H = 720
export const DOCK_DEFAULT_W = 280
export const DOCK_DEFAULT_H = 240
const MIN_CELL = 72
const MIN_CENTER_W = 180
const MIN_CENTER_H = 96

export function emptyLanes(): Record<DockEdge, DockLane[]> {
  return { left: [], right: [], top: [], bottom: [] }
}

export function tabsOf(cell: DockCell) {
  const listed = (cell.tabs ?? []).filter((id) => id)
  const base = listed.length > 0 ? listed : cell.id ? [cell.id] : []
  const unique: string[] = []
  for (const id of base) {
    if (!unique.includes(id)) unique.push(id)
  }
  if (cell.id && !unique.includes(cell.id)) unique.unshift(cell.id)
  return unique
}

export function tabInsertIndex(
  tabs: { id: string; left: number; width: number }[],
  draggedId: string,
  pointerX: number,
  previous = -1,
) {
  const ordered = [...tabs].filter((tab) => tab.id && tab.width > 0).sort((a, b) => a.left - b.left)
  const selfIndex = ordered.findIndex((tab) => tab.id === draggedId)
  if (selfIndex < 0) return 0
  const boundaries: number[] = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index]
    const right = ordered[index + 1]
    boundaries.push((left.left + left.width / 2 + right.left + right.width / 2) / 2)
  }
  let next = 0
  for (const boundary of boundaries) {
    if (pointerX > boundary) next += 1
  }
  if (previous < 0 || previous === next || previous > ordered.length - 1) return next
  const boundary = boundaries[Math.min(previous, next)]
  const hold = 18
  if (boundary == null) return next
  if (next > previous && pointerX < boundary + hold) return previous
  if (next < previous && pointerX > boundary - hold) return previous
  return next
}

export function orderTab(layout: DockLayout, id: string, index: number) {
  const loc = findCell(layout, id)
  if (loc) {
    const cell = layout.lanes[loc.edge][loc.laneIndex].cells[loc.cellIndex]
    const current = tabsOf(cell)
    const rest = current.filter((tab) => tab !== id)
    const at = Math.max(0, Math.min(index, rest.length))
    const next = [...rest.slice(0, at), id, ...rest.slice(at)]
    if (next.join("\0") === current.join("\0")) return false
    cell.tabs = next
    if (!next.includes(cell.id)) cell.id = next[0]
    return true
  }
  const group = floatGroupFor(layout, id)
  if (!group) return false
  const rest = group.tabs.filter((tab) => tab !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  const next = [...rest.slice(0, at), id, ...rest.slice(at)]
  if (next.join("\0") === group.tabs.join("\0")) return false
  group.tabs = next
  return true
}

export function bandId(cell: DockCell, visible: ReadonlySet<string>) {
  const tabs = tabsOf(cell).filter((id) => visible.has(id))
  if (tabs.length === 0) return null
  return tabs.includes(cell.id) ? cell.id : tabs[0]
}

export function copyLayout(layout: DockLayout): DockLayout {
  return {
    version: 3,
    agentSized: layout.agentSized,
    lanes: {
      left: layout.lanes.left.map(copyLane),
      right: layout.lanes.right.map(copyLane),
      top: layout.lanes.top.map(copyLane),
      bottom: layout.lanes.bottom.map(copyLane),
    },
    panels: Object.fromEntries(
      Object.entries(layout.panels).map(([id, panel]) => [id, { ...panel, floatRect: { ...panel.floatRect } }]),
    ),
    floatGroups: (layout.floatGroups ?? []).map((group) => ({ tabs: [...group.tabs], active: group.active })),
  }
}

function copyLane(lane: DockLane): DockLane {
  return {
    size: lane.size,
    cells: lane.cells.map((cell) => ({ id: cell.id, weight: cell.weight, tabs: tabsOf(cell) })),
  }
}

export function isVertical(edge: DockEdge) {
  return edge === "top" || edge === "bottom"
}

export function limitsFor(spec: DockSpec | undefined, edge: DockEdge) {
  const vertical = isVertical(edge)
  return {
    min: spec?.minSize ?? (vertical ? DOCK_MIN_H : DOCK_MIN_W),
    max: spec?.maxSize ?? (vertical ? DOCK_MAX_H : DOCK_MAX_W),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function defaultRecord(spec: DockSpec): DockPanelRecord {
  const placement = spec.defaultPlacement ?? "left"
  const vertical = placement === "top" || placement === "bottom"
  return {
    placement,
    lastEdge: placement === "float" ? "left" : placement,
    size: spec.defaultSize ?? (vertical ? DOCK_DEFAULT_H : DOCK_DEFAULT_W),
    floatRect: spec.defaultFloat ?? { x: 72, y: 48, w: 360, h: 420 },
    z: 1,
  }
}

export function findCell(layout: DockLayout, id: string) {
  for (const edge of DOCK_EDGES) {
    const laneIndex = layout.lanes[edge].findIndex((lane) => lane.cells.some((cell) => tabsOf(cell).includes(id)))
    if (laneIndex < 0) continue
    const cellIndex = layout.lanes[edge][laneIndex].cells.findIndex((cell) => tabsOf(cell).includes(id))
    return { edge, laneIndex, cellIndex }
  }
  return null
}

function stripFromLanes(layout: DockLayout, id: string) {
  for (const edge of DOCK_EDGES) {
    layout.lanes[edge] = layout.lanes[edge]
      .map((lane) => ({
        ...lane,
        cells: lane.cells.flatMap((cell) => {
          const tabs = tabsOf(cell).filter((tab) => tab !== id)
          if (tabs.length === 0) return []
          const active = cell.id === id || !tabs.includes(cell.id) ? tabs[0] : cell.id
          return [{ id: active, tabs, weight: cell.weight }]
        }),
      }))
      .filter((lane) => lane.cells.length > 0)
  }
}

export function removePanel(layout: DockLayout, id: string) {
  stripFromLanes(layout, id)
  layout.floatGroups = (layout.floatGroups ?? []).flatMap((group) => {
    const tabs = group.tabs.filter((tab) => tab !== id)
    if (tabs.length < 2) return []
    const active = group.active === id || !tabs.includes(group.active) ? tabs[0] : group.active
    return [{ tabs, active }]
  })
}

function syncLaneSize(layout: DockLayout, edge: DockEdge, laneIndex: number) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  for (const cell of lane.cells) {
    for (const id of tabsOf(cell)) {
      const panel = layout.panels[id]
      if (panel) panel.size = lane.size
    }
  }
}

export function detach(layout: DockLayout, id: string) {
  removePanel(layout, id)
  const panel = layout.panels[id]
  if (panel) panel.placement = "float"
}

export function dockToEdge(layout: DockLayout, id: string, edge: DockEdge, size: number, where: "outer" | "inner" = "outer") {
  const panel = layout.panels[id]
  if (!panel) return
  removePanel(layout, id)
  const lane = { size, cells: [{ id, weight: 1 }] }
  if (where === "outer") layout.lanes[edge].unshift(lane)
  else layout.lanes[edge].push(lane)
  panel.placement = edge
  panel.lastEdge = edge
  panel.size = size
}

export function dockBeside(layout: DockLayout, id: string, targetId: string, side: DockEdge, size: number) {
  const panel = layout.panels[id]
  if (!panel || id === targetId || !layout.panels[targetId]) return false
  removePanel(layout, id)
  const loc = findCell(layout, targetId)
  if (!loc) return false
  const lane = layout.lanes[loc.edge][loc.laneIndex]
  const alongLane =
    loc.edge === "left" || loc.edge === "right" ? side === "left" || side === "right" : side === "top" || side === "bottom"
  if (alongLane) {
    const towardStart = side === "left" || side === "top"
    const before = loc.edge === "left" || loc.edge === "top" ? towardStart : !towardStart
    const index = before ? loc.laneIndex : loc.laneIndex + 1
    layout.lanes[loc.edge].splice(index, 0, { size, cells: [{ id, weight: 1 }] })
  } else {
    const towardStart = side === "top" || side === "left"
    const index = towardStart ? loc.cellIndex : loc.cellIndex + 1
    const weight = lane.cells[loc.cellIndex]?.weight ?? 1
    lane.cells.splice(index, 0, { id, weight })
    syncLaneSize(layout, loc.edge, loc.laneIndex)
  }
  panel.placement = loc.edge
  panel.lastEdge = loc.edge
  panel.size = alongLane ? size : lane.size
  return true
}

export function floatGroupFor(layout: DockLayout, id: string) {
  return (layout.floatGroups ?? []).find((group) => group.tabs.includes(id)) ?? null
}

export function activateTab(layout: DockLayout, id: string) {
  const panel = layout.panels[id]
  if (!panel) return false
  const loc = findCell(layout, id)
  if (loc) {
    const lane = layout.lanes[loc.edge][loc.laneIndex]
    const cell = lane.cells[loc.cellIndex]
    cell.id = id
    for (const tab of tabsOf(cell)) {
      const member = layout.panels[tab]
      if (!member) continue
      member.placement = loc.edge
      member.lastEdge = loc.edge
      member.size = lane.size
    }
    return true
  }
  const group = floatGroupFor(layout, id)
  if (!group) return false
  const previous = layout.panels[group.active]
  const rect = previous?.placement === "float" ? previous.floatRect : panel.floatRect
  const z = previous?.z ?? panel.z
  group.active = id
  for (const tab of group.tabs) {
    const member = layout.panels[tab]
    if (!member) continue
    member.placement = "float"
    member.floatRect = { ...rect }
    member.z = z
  }
  return true
}

export function columnTabs(layout: DockLayout, id: string) {
  const group = floatGroupFor(layout, id)
  if (group) return group.tabs.filter((tab) => layout.panels[tab])
  const loc = findCell(layout, id)
  if (!loc) return layout.panels[id] ? [id] : []
  return tabsOf(layout.lanes[loc.edge][loc.laneIndex].cells[loc.cellIndex]).filter((tab) => layout.panels[tab])
}

export function liftColumn(layout: DockLayout, id: string) {
  const panel = layout.panels[id]
  if (!panel) return
  if (panel.placement === "float") {
    syncFloatGroup(layout, id)
    return
  }
  const loc = findCell(layout, id)
  const tabs = columnTabs(layout, id)
  const active = loc
    ? layout.lanes[loc.edge][loc.laneIndex].cells[loc.cellIndex].id
    : id
  const rect = { ...panel.floatRect }
  const z = panel.z
  for (const tab of tabs) removePanel(layout, tab)
  if (tabs.length > 1) {
    const groups = (layout.floatGroups ??= [])
    groups.push({ tabs: [...tabs], active: tabs.includes(active) ? active : id })
  }
  for (const tab of tabs) {
    const member = layout.panels[tab]
    if (!member) continue
    member.placement = "float"
    member.floatRect = { ...rect }
    member.z = z
  }
}

export function syncFloatGroup(layout: DockLayout, id: string) {
  const group = floatGroupFor(layout, id)
  const source = layout.panels[id]
  if (!group || !source) return
  for (const tab of group.tabs) {
    const panel = layout.panels[tab]
    if (!panel || panel === source) continue
    panel.placement = "float"
    panel.floatRect = { ...source.floatRect }
    panel.z = source.z
  }
}

export function mergeTabs(
  layout: DockLayout,
  id: string,
  targetId: string,
  place: "before" | "after" | "end" = "end",
) {
  const panel = layout.panels[id]
  const target = layout.panels[targetId]
  if (!panel || !target || id === targetId || target.placement === "float") return false
  removePanel(layout, id)
  const loc = findCell(layout, targetId)
  if (!loc) return false
  const cell = layout.lanes[loc.edge][loc.laneIndex].cells[loc.cellIndex]
  const tabs = tabsOf(cell).filter((tab) => tab !== id)
  const at = tabs.indexOf(targetId)
  if (place === "before" && at >= 0) tabs.splice(at, 0, id)
  else if (place === "after" && at >= 0) tabs.splice(at + 1, 0, id)
  else tabs.push(id)
  cell.tabs = tabs
  cell.id = id
  const size = layout.lanes[loc.edge][loc.laneIndex].size
  panel.placement = loc.edge
  panel.lastEdge = loc.edge
  panel.size = size
  return true
}

export function mergeFloatTabs(
  layout: DockLayout,
  id: string,
  targetId: string,
  place: "before" | "after" | "end" = "end",
) {
  const panel = layout.panels[id]
  const target = layout.panels[targetId]
  if (!panel || !target || id === targetId) return false
  removePanel(layout, id)
  const groups = (layout.floatGroups ??= [])
  let group = groups.find((item) => item.tabs.includes(targetId))
  if (!group) {
    group = { tabs: [targetId], active: targetId }
    groups.push(group)
  }
  const tabs = group.tabs.filter((tab) => tab !== id)
  const at = tabs.indexOf(targetId)
  if (place === "before" && at >= 0) tabs.splice(at, 0, id)
  else if (place === "after" && at >= 0) tabs.splice(at + 1, 0, id)
  else tabs.push(id)
  group.tabs = tabs
  group.active = id
  target.placement = "float"
  panel.placement = "float"
  panel.lastEdge = target.lastEdge
  panel.floatRect = { ...target.floatRect }
  panel.z = target.z
  return true
}

export function applyStick(layout: DockLayout, id: string, hit: DockHit, size: number) {
  if (hit.kind === "float") {
    detach(layout, id)
    return
  }
  if (hit.kind === "window") {
    dockToEdge(layout, id, hit.edge, size, "outer")
    return
  }
  if (hit.kind === "tabs") {
    const target = layout.panels[hit.panelId]
    const place = hit.place ?? "end"
    if (target?.placement === "float") {
      if (!mergeFloatTabs(layout, id, hit.panelId, place)) detach(layout, id)
      return
    }
    if (!mergeTabs(layout, id, hit.panelId, place)) {
      dockToEdge(layout, id, target?.lastEdge ?? "left", size, "outer")
    }
    return
  }
  const target = layout.panels[hit.panelId]
  if (target?.placement === "float") dockToEdge(layout, hit.panelId, target.lastEdge, target.size, "outer")
  if (!dockBeside(layout, id, hit.panelId, hit.side, size)) dockToEdge(layout, id, hit.side, size, "outer")
}

function restoreGroupOrder(layout: DockLayout, ordered: readonly string[], anchorId: string, active: string) {
  const others = ordered.filter((tab) => tab !== anchorId && layout.panels[tab])
  const anchor = layout.panels[anchorId]
  if (!anchor || others.length === 0) return
  const floating = anchor.placement === "float" || !!floatGroupFor(layout, anchorId)
  for (const tab of others) {
    if (floating) mergeFloatTabs(layout, tab, anchorId, "end")
    else if (!mergeTabs(layout, tab, anchorId, "end")) dockToEdge(layout, tab, anchor.lastEdge, anchor.size, "outer")
  }
  if (floating) {
    const group = floatGroupFor(layout, anchorId)
    if (!group) return
    const block = ordered.filter((tab) => group.tabs.includes(tab))
    const foreign = group.tabs.filter((tab) => !others.includes(tab))
    const insertAt = Math.max(0, foreign.indexOf(anchorId))
    const next = group.tabs.filter((tab) => !block.includes(tab))
    next.splice(insertAt, 0, ...block)
    group.tabs = next
    group.active = next.includes(active) ? active : anchorId
    syncFloatGroup(layout, group.active)
    return
  }
  const loc = findCell(layout, anchorId)
  if (!loc) return
  const lane = layout.lanes[loc.edge][loc.laneIndex]
  const cell = lane.cells[loc.cellIndex]
  const tabs = tabsOf(cell)
  const block = ordered.filter((tab) => tabs.includes(tab))
  const foreign = tabs.filter((tab) => !others.includes(tab))
  const insertAt = Math.max(0, foreign.indexOf(anchorId))
  const next = tabs.filter((tab) => !block.includes(tab))
  next.splice(insertAt, 0, ...block)
  cell.tabs = next
  cell.id = next.includes(active) ? active : anchorId
  for (const tab of next) {
    const panel = layout.panels[tab]
    if (!panel) continue
    panel.placement = loc.edge
    panel.lastEdge = loc.edge
    panel.size = lane.size
  }
}

export function stickGroup(layout: DockLayout, id: string, hit: DockHit, size: number) {
  const group = floatGroupFor(layout, id)
  const ordered = (group?.tabs ?? [id]).filter((tab) => layout.panels[tab])
  if (!group || ordered.length < 2) {
    applyStick(layout, id, hit, size)
    return
  }
  const active = ordered.includes(group.active) ? group.active : id
  if (hit.kind === "float") {
    const panel = layout.panels[id]
    if (panel && panel.placement !== "float") detach(layout, id)
    syncFloatGroup(layout, id)
    const kept = floatGroupFor(layout, id)
    if (kept) kept.active = kept.tabs.includes(active) ? active : id
    return
  }
  applyStick(layout, id, hit, size)
  restoreGroupOrder(layout, ordered, id, active)
}

export function normalize(layout: DockLayout) {
  const seen = new Set<string>()
  for (const edge of DOCK_EDGES) {
    const next: DockLane[] = []
    for (const lane of layout.lanes[edge]) {
      const cells: DockCell[] = []
      for (const cell of lane.cells ?? []) {
        const tabs = tabsOf(cell).filter((id) => {
          const panel = layout.panels[id]
          if (!panel || panel.placement === "float" || seen.has(id)) return false
          if (panel.placement === edge) return true
          for (const other of DOCK_EDGES) {
            if (other === edge) continue
            const livesThere = layout.lanes[other].some((lane) =>
              lane.cells.some((item) => tabsOf(item).includes(id) && panel.placement === other),
            )
            if (livesThere) return false
          }
          return true
        })
        if (tabs.length === 0) continue
        for (const id of tabs) seen.add(id)
        cells.push({
          id: tabs.includes(cell.id) ? cell.id : tabs[0],
          tabs,
          weight: finite(cell.weight, 1) > 0 ? cell.weight : 1,
        })
      }
      if (cells.length === 0) continue
      const size = finite(lane.size, isVertical(edge) ? DOCK_DEFAULT_H : DOCK_DEFAULT_W)
      next.push({ size, cells })
      for (const cell of cells) {
        for (const id of tabsOf(cell)) {
          const panel = layout.panels[id]
          if (!panel) continue
          panel.placement = edge
          panel.lastEdge = edge
          panel.size = size
        }
      }
    }
    layout.lanes[edge] = next
  }
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (panel.placement === "float") {
      stripFromLanes(layout, id)
      continue
    }
    if (!seen.has(id)) {
      layout.lanes[panel.placement].push({ size: panel.size, cells: [{ id, tabs: [id], weight: 1 }] })
      seen.add(id)
    }
  }
  const groups: DockTabGroup[] = []
  const grouped = new Set<string>()
  for (const group of layout.floatGroups ?? []) {
    const tabs: string[] = []
    for (const id of group.tabs) {
      const panel = layout.panels[id]
      if (!panel || panel.placement !== "float" || grouped.has(id) || seen.has(id)) continue
      grouped.add(id)
      tabs.push(id)
    }
    if (tabs.length < 2) continue
    groups.push({ tabs, active: tabs.includes(group.active) ? group.active : tabs[0] })
  }
  layout.floatGroups = groups
  layout.version = 3
}

export function mergeSpecs(layout: DockLayout, specs: readonly DockSpec[]) {
  let changed = false
  const next = copyLayout(layout)
  for (const spec of specs) {
    if (next.panels[spec.id]) continue
    next.panels[spec.id] = defaultRecord(spec)
    const record = next.panels[spec.id]
    if (record.placement !== "float") {
      next.lanes[record.placement].push({ size: record.size, cells: [{ id: spec.id, weight: 1 }] })
    }
    changed = true
  }
  if (!changed) return layout
  normalize(next)
  return next
}

type SavedV1 = {
  version?: number
  agentSized?: boolean
  order?: Partial<Record<DockEdge, string[]>>
  lanes?: Partial<Record<DockEdge, DockLane[]>>
  panels?: Record<string, Partial<DockPanelRecord>>
  floatGroups?: { tabs?: unknown; active?: unknown }[]
}

function readPanel(_id: string, raw: Partial<DockPanelRecord> | undefined): DockPanelRecord | null {
  if (!raw) return null
  const placement = raw.placement
  if (placement !== "left" && placement !== "right" && placement !== "top" && placement !== "bottom" && placement !== "float") {
    return null
  }
  const rect = raw.floatRect
  return {
    placement,
    lastEdge: raw.lastEdge === "right" || raw.lastEdge === "top" || raw.lastEdge === "bottom" ? raw.lastEdge : "left",
    size: finite(raw.size, DOCK_DEFAULT_W),
    z: finite(raw.z, 1),
    floatRect:
      rect && [rect.x, rect.y, rect.w, rect.h].every((value) => typeof value === "number" && Number.isFinite(value))
        ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
        : { x: 72, y: 48, w: 360, h: 420 },
  }
}

function savedTabOrder(activeId: string, raw: unknown) {
  const listed = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : []
  const unique: string[] = []
  for (const id of listed) {
    if (!unique.includes(id)) unique.push(id)
  }
  if (activeId && !unique.includes(activeId)) unique.unshift(activeId)
  return unique.length > 0 ? unique : activeId ? [activeId] : []
}

function lanesFromOrder(order: string[] | undefined, panels: Record<string, DockPanelRecord>, edge: DockEdge): DockLane[] {
  const lanes: DockLane[] = []
  for (const id of order ?? []) {
    const panel = panels[id]
    if (!panel || panel.placement !== edge) continue
    lanes.push({ size: panel.size, cells: [{ id, weight: 1 }] })
  }
  return lanes
}

export function layoutFromSaved(saved: unknown): DockLayout | null {
  if (!saved || typeof saved !== "object") return null
  const raw = saved as SavedV1
  if (!raw.panels || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3)) return null
  const panels: Record<string, DockPanelRecord> = {}
  for (const [id, panel] of Object.entries(raw.panels)) {
    const record = readPanel(id, panel)
    if (record) panels[id] = record
  }
  const layout: DockLayout = { version: 3, agentSized: Boolean(raw.agentSized), lanes: emptyLanes(), panels, floatGroups: [] }
  if ((raw.version === 2 || raw.version === 3) && raw.lanes) {
    for (const edge of DOCK_EDGES) {
      layout.lanes[edge] = (raw.lanes[edge] ?? []).map((lane) => ({
        size: finite(lane?.size, isVertical(edge) ? DOCK_DEFAULT_H : DOCK_DEFAULT_W),
        cells: (lane?.cells ?? [])
          .filter((cell) => cell && typeof cell.id === "string")
          .map((cell) => ({
            id: cell.id,
            tabs: savedTabOrder(cell.id, cell.tabs),
            weight: finite(cell.weight, 1),
          })),
      }))
    }
  } else {
    for (const edge of DOCK_EDGES) layout.lanes[edge] = lanesFromOrder(raw.order?.[edge], panels, edge)
  }
  layout.floatGroups = Array.isArray(raw.floatGroups)
    ? raw.floatGroups.flatMap((group) => {
        if (!group || typeof group !== "object") return []
        const tabs = Array.isArray(group.tabs) ? group.tabs.filter((id): id is string => typeof id === "string") : []
        if (tabs.length < 2) return []
        const active = typeof group.active === "string" && tabs.includes(group.active) ? group.active : tabs[0]
        return [{ tabs, active }]
      })
    : []
  normalize(layout)
  return layout
}

function visibleLanes(lanes: DockLane[], visible: ReadonlySet<string>) {
  return lanes.flatMap((lane, laneIndex) => {
    const cells = lane.cells.flatMap((cell, cellIndex) => {
      const id = bandId(cell, visible)
      if (!id) return []
      const tabs = tabsOf(cell).filter((tab) => visible.has(tab))
      return [{ id, tabs, weight: cell.weight, cellIndex }]
    })
    return cells.length > 0 ? [{ ...lane, laneIndex, cells }] : []
  })
}

function share(total: number, weights: number[]) {
  const sum = weights.reduce((value, weight) => value + weight, 0) || 1
  const raw = weights.map((weight) => (total * weight) / sum)
  const sizes = raw.map((value) => Math.floor(value))
  let leftover = total - sizes.reduce((value, size) => value + size, 0)
  for (let index = 0; leftover > 0; index += 1, leftover -= 1) sizes[index % sizes.length] += 1
  return sizes
}

function scaleSizes(sizes: number[], available: number) {
  const sum = sizes.reduce((value, size) => value + size, 0)
  if (sum <= available || sum <= 0) return sizes
  const scaled = sizes.map((size) => (available * size) / sum)
  const floors = scaled.map((size) => Math.floor(size))
  let leftover = available - floors.reduce((value, size) => value + size, 0)
  for (let index = 0; leftover > 0; index += 1, leftover -= 1) floors[index % floors.length] += 1
  return floors
}

function placeCells(
  edge: DockEdge,
  laneIndex: number,
  cells: { id: string; tabs?: string[]; weight: number; cellIndex: number }[],
  rect: DockRect,
  bands: Record<string, DockRect>,
  slots: Record<string, DockRect>,
  sashes: DockSash[],
  tabBars: DockTabBar[],
) {
  const verticalLane = edge === "left" || edge === "right"
  const gaps = Math.max(0, cells.length - 1) * DOCK_SASH
  const inner = Math.max(0, (verticalLane ? rect.h : rect.w) - gaps)
  const sizes = share(inner, cells.map((cell) => cell.weight))
  let cursor = verticalLane ? rect.y : rect.x
  cells.forEach((cell, index) => {
    const size = sizes[index] ?? 0
    const full = verticalLane
      ? { x: rect.x, y: cursor, w: rect.w, h: size }
      : { x: cursor, y: rect.y, w: size, h: rect.h }
    const tabs = tabsOf(cell)
    const tabH = tabs.length > 1 ? Math.min(DOCK_TAB_H, full.h) : 0
    slots[cell.id] = full
    if (tabH > 0) {
      tabBars.push({
        key: "tabs:" + edge + ":" + laneIndex + ":" + cell.cellIndex,
        rect: { x: full.x, y: full.y, w: full.w, h: tabH },
        tabs: tabs.map((id) => ({ id, active: id === cell.id })),
      })
    }
    bands[cell.id] = { x: full.x, y: full.y + tabH, w: full.w, h: Math.max(0, full.h - tabH) }
    cursor += size
    if (index === cells.length - 1) return
    const sashRect = verticalLane
      ? { x: rect.x, y: cursor, w: rect.w, h: DOCK_SASH }
      : { x: cursor, y: rect.y, w: DOCK_SASH, h: rect.h }
    sashes.push({
      key: "cell:" + edge + ":" + laneIndex + ":" + cell.cellIndex,
      axis: verticalLane ? "y" : "x",
      invert: false,
      edge,
      laneIndex,
      cellIndex: cell.cellIndex,
      panelId: cell.id,
      rect: sashRect,
    })
    cursor += DOCK_SASH
  })
}

export function layoutFrame(layout: DockLayout, root: { width: number; height: number }, visible: ReadonlySet<string>): DockFrame {
  const bands: Record<string, DockRect> = {}
  const slots: Record<string, DockRect> = {}
  const sashes: DockSash[] = []
  const tabBars: DockTabBar[] = []
  const left = visibleLanes(layout.lanes.left, visible)
  const right = visibleLanes(layout.lanes.right, visible)
  const sideSash = (left.length + right.length) * DOCK_SASH
  const sideRoom = Math.max(0, root.width - MIN_CENTER_W - sideSash)
  const sideSizes = scaleSizes([...left.map((lane) => lane.size), ...right.map((lane) => lane.size)], sideRoom)
  const leftSizes = sideSizes.slice(0, left.length)
  const rightSizes = sideSizes.slice(left.length)
  let x = 0
  left.forEach((lane, index) => {
    const width = leftSizes[index] ?? 0
    placeCells("left", lane.laneIndex, lane.cells, { x, y: 0, w: width, h: root.height }, bands, slots, sashes, tabBars)
    x += width
    sashes.push({
      key: `lane:left:${lane.laneIndex}`,
      axis: "x",
      invert: false,
      edge: "left",
      laneIndex: lane.laneIndex,
      cellIndex: null,
      panelId: lane.cells[0]?.id ?? "",
      rect: { x, y: 0, w: DOCK_SASH, h: root.height },
    })
    x += DOCK_SASH
  })
  let rightCursor = root.width
  right.forEach((lane, index) => {
    const width = rightSizes[index] ?? 0
    rightCursor -= width
    placeCells("right", lane.laneIndex, lane.cells, { x: rightCursor, y: 0, w: width, h: root.height }, bands, slots, sashes, tabBars)
    rightCursor -= DOCK_SASH
    sashes.push({
      key: `lane:right:${lane.laneIndex}`,
      axis: "x",
      invert: true,
      edge: "right",
      laneIndex: lane.laneIndex,
      cellIndex: null,
      panelId: lane.cells[0]?.id ?? "",
      rect: { x: rightCursor, y: 0, w: DOCK_SASH, h: root.height },
    })
  })
  const centerX = x
  const centerW = Math.max(0, rightCursor - centerX)
  const top = visibleLanes(layout.lanes.top, visible)
  const bottom = visibleLanes(layout.lanes.bottom, visible)
  const endSash = (top.length + bottom.length) * DOCK_SASH
  const endRoom = Math.max(0, root.height - MIN_CENTER_H - endSash)
  const endSizes = scaleSizes([...top.map((lane) => lane.size), ...bottom.map((lane) => lane.size)], endRoom)
  const topSizes = endSizes.slice(0, top.length)
  const bottomSizes = endSizes.slice(top.length)
  let y = 0
  top.forEach((lane, index) => {
    const height = topSizes[index] ?? 0
    placeCells("top", lane.laneIndex, lane.cells, { x: centerX, y, w: centerW, h: height }, bands, slots, sashes, tabBars)
    y += height
    sashes.push({
      key: `lane:top:${lane.laneIndex}`,
      axis: "y",
      invert: false,
      edge: "top",
      laneIndex: lane.laneIndex,
      cellIndex: null,
      panelId: lane.cells[0]?.id ?? "",
      rect: { x: centerX, y, w: centerW, h: DOCK_SASH },
    })
    y += DOCK_SASH
  })
  let bottomCursor = root.height
  bottom.forEach((lane, index) => {
    const height = bottomSizes[index] ?? 0
    bottomCursor -= height
    placeCells("bottom", lane.laneIndex, lane.cells, { x: centerX, y: bottomCursor, w: centerW, h: height }, bands, slots, sashes, tabBars)
    bottomCursor -= DOCK_SASH
    sashes.push({
      key: `lane:bottom:${lane.laneIndex}`,
      axis: "y",
      invert: true,
      edge: "bottom",
      laneIndex: lane.laneIndex,
      cellIndex: null,
      panelId: lane.cells[0]?.id ?? "",
      rect: { x: centerX, y: bottomCursor, w: centerW, h: DOCK_SASH },
    })
  })
  return {
    bands,
    slots,
    sashes,
    tabBars,
    main: { x: centerX, y, w: centerW, h: Math.max(0, bottomCursor - y) },
  }
}

function lineSide(side: DockEdge) {
  return side === "top" || side === "bottom"
}

function sideBoxWidth(span: number, preferred?: number) {
  const room = Math.max(24, span)
  const wanted = preferred && preferred > 48 ? preferred : Math.min(DOCK_DEFAULT_W, room)
  return Math.max(24, Math.min(wanted, room, Math.max(24, Math.round(room * 0.5))))
}

function windowPreview(root: { width: number; height: number }, edge: DockEdge, mover?: DockRect): DockRect {
  if (edge === "left" || edge === "right") {
    const w = sideBoxWidth(root.width, mover?.w)
    if (edge === "left") return { x: 0, y: 0, w, h: root.height }
    return { x: Math.max(0, root.width - w), y: 0, w, h: root.height }
  }
  if (edge === "top") return { x: 0, y: 0, w: root.width, h: DOCK_LINE_PREVIEW }
  return { x: 0, y: Math.max(0, root.height - DOCK_LINE_PREVIEW), w: root.width, h: DOCK_LINE_PREVIEW }
}

function panelPreview(root: { width: number; height: number }, rect: DockRect, side: DockEdge, mover?: DockRect): DockRect {
  if (side === "left" || side === "right") {
    const w = sideBoxWidth(rect.w, mover?.w)
    if (side === "left") return { x: rect.x, y: rect.y, w, h: rect.h }
    return { x: rect.x + rect.w - w, y: rect.y, w, h: rect.h }
  }
  if (side === "top") return { x: rect.x, y: rect.y, w: rect.w, h: DOCK_LINE_PREVIEW }
  return { x: rect.x, y: Math.min(root.height - DOCK_LINE_PREVIEW, rect.y + rect.h - DOCK_LINE_PREVIEW), w: rect.w, h: DOCK_LINE_PREVIEW }
}

type HitCandidate = { gap: number; rank: number; hit: DockHit }

const MIN_CROSS = 16

export type DockHitProbe = {
  mover?: DockRect
  ignoreId?: string
  floats?: Record<string, DockRect>
}

function windowEdgeGap(mover: DockRect, root: { width: number; height: number }, edge: DockEdge) {
  if (edge === "left") return mover.x < 0 && mover.x + mover.w > 8 ? 0 : mover.x
  if (edge === "right") {
    const gap = root.width - (mover.x + mover.w)
    return gap < 0 && mover.x < root.width - 8 ? 0 : gap
  }
  if (edge === "top") return mover.y < 0 && mover.y + mover.h > 8 ? 0 : mover.y
  const gap = root.height - (mover.y + mover.h)
  return gap < 0 && mover.y < root.height - 8 ? 0 : gap
}

function containsPoint(rect: DockRect, x: number, y: number) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

function pointerWindowGap(pointer: { x: number; y: number }, root: { width: number; height: number }, edge: DockEdge) {
  if (edge === "left") return pointer.x
  if (edge === "right") return root.width - pointer.x
  if (edge === "top") return pointer.y
  return root.height - pointer.y
}

const TAB_BAND = DOCK_TAB_H + 6
const EDGE_REACH = 28
const EDGE_MARGIN = 36
const WINDOW_REACH = 28

function axisOverlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

function pushTabBody(
  candidates: HitCandidate[],
  pointer: { x: number; y: number },
  panelId: string,
  rect: DockRect,
) {
  if (rect.w < 8 || rect.h < 8) return
  if (!containsPoint(rect, pointer.x, pointer.y)) return
  const inTab = pointer.y <= rect.y + TAB_BAND
  const inCenter =
    pointer.x > rect.x + Math.min(EDGE_MARGIN, rect.w * 0.22) &&
    pointer.x < rect.x + rect.w - Math.min(EDGE_MARGIN, rect.w * 0.22) &&
    pointer.y > rect.y + TAB_BAND &&
    pointer.y < rect.y + rect.h - Math.min(EDGE_MARGIN, rect.h * 0.2)
  if (!inTab && !inCenter) return
  candidates.push({
    gap: 0,
    rank: 0,
    hit: {
      kind: "tabs",
      panelId,
      preview: inTab
        ? { x: rect.x, y: rect.y, w: rect.w, h: Math.min(rect.h, TAB_BAND) }
        : { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      line: false,
    },
  })
}

function moverSideGap(mover: DockRect, rect: DockRect, side: DockEdge): number | null {
  const cross =
    side === "left" || side === "right"
      ? axisOverlap(mover.y, mover.y + mover.h, rect.y, rect.y + rect.h)
      : axisOverlap(mover.x, mover.x + mover.w, rect.x, rect.x + rect.w)
  if (cross < MIN_CROSS) return null
  const reach = EDGE_REACH
  const overlap = 36
  if (side === "left") {
    const facing = rect.x - (mover.x + mover.w)
    const same = Math.abs(mover.x - rect.x)
    if (facing <= reach && facing >= -overlap) return Math.abs(facing)
    if (same <= reach && mover.x <= rect.x + overlap && mover.x + mover.w > rect.x) return same
    return null
  }
  if (side === "right") {
    const facing = mover.x - (rect.x + rect.w)
    const same = Math.abs(mover.x + mover.w - (rect.x + rect.w))
    if (facing <= reach && facing >= -overlap) return Math.abs(facing)
    if (same <= reach && mover.x + mover.w >= rect.x + rect.w - overlap && mover.x < rect.x + rect.w) return same
    return null
  }
  if (side === "top") {
    const facing = rect.y - (mover.y + mover.h)
    const same = Math.abs(mover.y - rect.y)
    if (facing <= reach && facing >= -overlap) return Math.abs(facing)
    if (same <= reach && mover.y <= rect.y + overlap && mover.y + mover.h > rect.y) return same
    return null
  }
  const facing = mover.y - (rect.y + rect.h)
  const same = Math.abs(mover.y + mover.h - (rect.y + rect.h))
  if (facing <= reach && facing >= -overlap) return Math.abs(facing)
  if (same <= reach && mover.y + mover.h >= rect.y + rect.h - overlap && mover.y < rect.y + rect.h) return same
  return null
}

function pushPanelEdges(
  candidates: HitCandidate[],
  root: { width: number; height: number },
  mover: DockRect,
  pointer: { x: number; y: number },
  panelId: string,
  rect: DockRect,
) {
  const marginX = Math.min(EDGE_MARGIN, rect.w * 0.22)
  const marginY = Math.min(EDGE_MARGIN, rect.h * 0.2)
  const pointerInside = containsPoint(rect, pointer.x, pointer.y)
  const pointerInCenter =
    pointerInside &&
    pointer.x > rect.x + marginX &&
    pointer.x < rect.x + rect.w - marginX &&
    pointer.y > rect.y + TAB_BAND &&
    pointer.y < rect.y + rect.h - marginY
  if (pointerInCenter) return
  for (const side of DOCK_EDGES) {
    const gap = moverSideGap(mover, rect, side)
    if (gap == null) continue
    candidates.push({
      gap,
      rank: 1,
      hit: {
        kind: "panel",
        panelId,
        side,
        preview: panelPreview(root, rect, side, mover),
        line: lineSide(side),
      },
    })
  }
}

function pushWindowEdges(
  candidates: HitCandidate[],
  root: { width: number; height: number },
  probe: DockRect | { x: number; y: number },
  fromPointer: boolean,
  pointer: { x: number; y: number },
) {
  if (fromPointer || !("w" in probe)) {
    for (const edge of DOCK_EDGES) {
      const gap = pointerWindowGap(pointer, root, edge)
      if (gap > DOCK_HIT || gap < 0) continue
      candidates.push({
        gap,
        rank: 2,
        hit: { kind: "window", edge, preview: windowPreview(root, edge, "w" in probe ? probe : undefined), line: lineSide(edge) },
      })
    }
    return
  }
  const mover = probe
  for (const edge of DOCK_EDGES) {
    const gap = windowEdgeGap(mover, root, edge)
    if (gap > WINDOW_REACH || gap < -12) continue
    const cross =
      edge === "left" || edge === "right"
        ? axisOverlap(mover.y, mover.y + mover.h, 0, root.height)
        : axisOverlap(mover.x, mover.x + mover.w, 0, root.width)
    if (cross < MIN_CROSS) continue
    candidates.push({
      gap: Math.max(0, gap),
      rank: 2,
      hit: { kind: "window", edge, preview: windowPreview(root, edge, "w" in probe ? probe : undefined), line: lineSide(edge) },
    })
  }
}

export function hitDock(
  root: { width: number; height: number },
  pointer: { x: number; y: number },
  bands: Record<string, DockRect>,
  probe?: DockHitProbe,
): DockHit {
  const candidates: HitCandidate[] = []
  const mover = probe?.mover
  pushWindowEdges(candidates, root, mover ?? pointer, !mover, pointer)
  const targets: [string, DockRect][] = [
    ...Object.entries(bands),
    ...Object.entries(probe?.floats ?? {}),
  ]
  for (const [panelId, rect] of targets) {
    if (panelId === probe?.ignoreId) continue
    pushTabBody(candidates, pointer, panelId, rect)
    if (mover) {
      pushPanelEdges(candidates, root, mover, pointer, panelId, rect)
      continue
    }
    const withinX = pointer.x >= rect.x - DOCK_HIT && pointer.x <= rect.x + rect.w + DOCK_HIT
    const withinY = pointer.y >= rect.y - DOCK_HIT && pointer.y <= rect.y + rect.h + DOCK_HIT
    const edges: { side: DockEdge; gap: number }[] = []
    if (withinY) {
      edges.push({ side: "left", gap: Math.abs(pointer.x - rect.x) })
      edges.push({ side: "right", gap: Math.abs(pointer.x - (rect.x + rect.w)) })
    }
    if (withinX) {
      edges.push({ side: "top", gap: Math.abs(pointer.y - rect.y) })
      edges.push({ side: "bottom", gap: Math.abs(pointer.y - (rect.y + rect.h)) })
    }
    for (const edge of edges) {
      if (edge.gap > DOCK_HIT) continue
      candidates.push({
        gap: edge.gap,
        rank: 1,
        hit: {
          kind: "panel",
          panelId,
          side: edge.side,
          preview: panelPreview(root, rect, edge.side),
          line: lineSide(edge.side),
        },
      })
    }
  }
  if (candidates.length === 0) return { kind: "float", preview: null, line: false }
  candidates.sort((a, b) => a.rank - b.rank || a.gap - b.gap || Number(a.hit.line) - Number(b.hit.line))
  return candidates[0].hit
}

export function resizeLane(layout: DockLayout, edge: DockEdge, laneIndex: number, size: number, min: number, max: number) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  lane.size = clamp(size, min, Math.max(min, max))
  syncLaneSize(layout, edge, laneIndex)
}


export function setCellPixels(
  layout: DockLayout,
  edge: DockEdge,
  laneIndex: number,
  cellIndex: number,
  aPx: number,
  _bPx: number,
  cross: number,
  visible: ReadonlySet<string>,
) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  const shown = lane.cells
    .map((cell, index) => ({ cell, index }))
    .filter((item) => tabsOf(item.cell).some((id) => visible.has(id)))
  const pairAt = shown.findIndex((item) => item.index === cellIndex)
  const a = shown[pairAt]
  const b = shown[pairAt + 1]
  if (!a || !b) return
  const gaps = Math.max(0, shown.length - 1) * DOCK_SASH
  const inner = Math.max(0, cross - gaps)
  const sizes = share(inner, shown.map((item) => item.cell.weight))
  const pair = (sizes[pairAt] ?? 0) + (sizes[pairAt + 1] ?? 0)
  if (pair <= 0) return
  const nextA = clamp(aPx, Math.min(MIN_CELL, pair), Math.max(0, pair - Math.min(MIN_CELL, pair)))
  sizes[pairAt] = nextA
  sizes[pairAt + 1] = pair - nextA
  shown.forEach((item, index) => {
    item.cell.weight = Math.max(1, sizes[index] ?? 1)
  })
}

export function resizeCell(layout: DockLayout, edge: DockEdge, laneIndex: number, cellIndex: number, delta: number, cross: number) {
  const lane = layout.lanes[edge][laneIndex]
  const a = lane?.cells[cellIndex]
  const b = lane?.cells[cellIndex + 1]
  if (!lane || !a || !b) return
  const gaps = Math.max(0, lane.cells.length - 1) * DOCK_SASH
  const inner = Math.max(0, cross - gaps)
  const weights = lane.cells.map((cell) => cell.weight)
  const sizes = share(inner, weights)
  const pair = (sizes[cellIndex] ?? 0) + (sizes[cellIndex + 1] ?? 0)
  if (pair <= 0) return
  const nextA = clamp((sizes[cellIndex] ?? 0) + delta, Math.min(MIN_CELL, pair), Math.max(MIN_CELL, pair - MIN_CELL))
  const nextB = pair - nextA
  a.weight = nextA
  b.weight = nextB
}

export function resetCellWeights(layout: DockLayout, edge: DockEdge, laneIndex: number) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  for (const cell of lane.cells) cell.weight = 1
}

export function sizeForDock(panel: DockPanelRecord, edge: DockEdge, spec: DockSpec | undefined) {
  const vertical = isVertical(edge)
  const sizedVertical = isVertical(panel.lastEdge)
  const { min, max } = limitsFor(spec, edge)
  if (sizedVertical !== vertical) return clamp(spec?.defaultSize ?? (vertical ? DOCK_DEFAULT_H : DOCK_DEFAULT_W), min, max)
  return clamp(panel.size || (vertical ? DOCK_DEFAULT_H : DOCK_DEFAULT_W), min, max)
}
