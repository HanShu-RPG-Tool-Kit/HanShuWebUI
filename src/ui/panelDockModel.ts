export type DockEdge = "left" | "right" | "top" | "bottom"
export type DockPlacement = DockEdge | "float"
export type DockRect = { x: number; y: number; w: number; h: number }
export type FloatRect = DockRect

export type DockCell = { id: string; weight: number }
export type DockLane = { size: number; cells: DockCell[] }

export type DockPanelRecord = {
  placement: DockPlacement
  lastEdge: DockEdge
  size: number
  floatRect: FloatRect
  z: number
}

export type DockLayout = {
  version: 2
  agentSized: boolean
  lanes: Record<DockEdge, DockLane[]>
  panels: Record<string, DockPanelRecord>
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

export type DockFrame = {
  bands: Record<string, DockRect>
  sashes: DockSash[]
  main: DockRect
}

export const DOCK_EDGES = ["left", "right", "top", "bottom"] as const
export const DOCK_SASH = 6
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

export function copyLayout(layout: DockLayout): DockLayout {
  return {
    version: 2,
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
  }
}

function copyLane(lane: DockLane): DockLane {
  return { size: lane.size, cells: lane.cells.map((cell) => ({ ...cell })) }
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
    const laneIndex = layout.lanes[edge].findIndex((lane) => lane.cells.some((cell) => cell.id === id))
    if (laneIndex < 0) continue
    const cellIndex = layout.lanes[edge][laneIndex].cells.findIndex((cell) => cell.id === id)
    return { edge, laneIndex, cellIndex }
  }
  return null
}

export function removePanel(layout: DockLayout, id: string) {
  for (const edge of DOCK_EDGES) {
    layout.lanes[edge] = layout.lanes[edge]
      .map((lane) => ({ ...lane, cells: lane.cells.filter((cell) => cell.id !== id) }))
      .filter((lane) => lane.cells.length > 0)
  }
}

function syncLaneSize(layout: DockLayout, edge: DockEdge, laneIndex: number) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  for (const cell of lane.cells) {
    const panel = layout.panels[cell.id]
    if (panel) panel.size = lane.size
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

export function applyStick(layout: DockLayout, id: string, hit: DockHit, size: number) {
  if (hit.kind === "float") {
    detach(layout, id)
    return
  }
  if (hit.kind === "window") {
    dockToEdge(layout, id, hit.edge, size, "outer")
    return
  }
  const target = layout.panels[hit.panelId]
  if (target?.placement === "float") dockToEdge(layout, hit.panelId, target.lastEdge, target.size, "outer")
  if (!dockBeside(layout, id, hit.panelId, hit.side, size)) dockToEdge(layout, id, hit.side, size, "outer")
}

export function normalize(layout: DockLayout) {
  const seen = new Set<string>()
  for (const edge of DOCK_EDGES) {
    const next: DockLane[] = []
    for (const lane of layout.lanes[edge]) {
      const cells = lane.cells.filter((cell) => {
        const panel = layout.panels[cell.id]
        if (!panel || panel.placement !== edge || seen.has(cell.id)) return false
        seen.add(cell.id)
        cell.weight = finite(cell.weight, 1) > 0 ? cell.weight : 1
        return true
      })
      if (cells.length === 0) continue
      const size = finite(lane.size, isVertical(edge) ? DOCK_DEFAULT_H : DOCK_DEFAULT_W)
      next.push({ size, cells })
      for (const cell of cells) layout.panels[cell.id].size = size
    }
    layout.lanes[edge] = next
  }
  for (const [id, panel] of Object.entries(layout.panels)) {
    if (panel.placement === "float") {
      removePanel(layout, id)
      continue
    }
    if (!seen.has(id)) {
      layout.lanes[panel.placement].push({ size: panel.size, cells: [{ id, weight: 1 }] })
      seen.add(id)
    }
  }
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
}

function readPanel(id: string, raw: Partial<DockPanelRecord> | undefined): DockPanelRecord | null {
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
  if (!raw.panels || (raw.version !== 1 && raw.version !== 2)) return null
  const panels: Record<string, DockPanelRecord> = {}
  for (const [id, panel] of Object.entries(raw.panels)) {
    const record = readPanel(id, panel)
    if (record) panels[id] = record
  }
  const layout: DockLayout = { version: 2, agentSized: Boolean(raw.agentSized), lanes: emptyLanes(), panels }
  if (raw.version === 2 && raw.lanes) {
    for (const edge of DOCK_EDGES) {
      layout.lanes[edge] = (raw.lanes[edge] ?? []).map((lane) => ({
        size: finite(lane?.size, isVertical(edge) ? DOCK_DEFAULT_H : DOCK_DEFAULT_W),
        cells: (lane?.cells ?? [])
          .filter((cell) => cell && typeof cell.id === "string")
          .map((cell) => ({ id: cell.id, weight: finite(cell.weight, 1) })),
      }))
    }
  } else {
    for (const edge of DOCK_EDGES) layout.lanes[edge] = lanesFromOrder(raw.order?.[edge], panels, edge)
  }
  normalize(layout)
  return layout
}

function visibleLanes(lanes: DockLane[], visible: ReadonlySet<string>) {
  return lanes.flatMap((lane, laneIndex) => {
    const cells = lane.cells.flatMap((cell, cellIndex) =>
      visible.has(cell.id) ? [{ ...cell, cellIndex }] : [],
    )
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
  cells: { id: string; weight: number; cellIndex: number }[],
  rect: DockRect,
  bands: Record<string, DockRect>,
  sashes: DockSash[],
) {
  const verticalLane = edge === "left" || edge === "right"
  const gaps = Math.max(0, cells.length - 1) * DOCK_SASH
  const inner = Math.max(0, (verticalLane ? rect.h : rect.w) - gaps)
  const sizes = share(inner, cells.map((cell) => cell.weight))
  let cursor = verticalLane ? rect.y : rect.x
  cells.forEach((cell, index) => {
    const size = sizes[index] ?? 0
    bands[cell.id] = verticalLane
      ? { x: rect.x, y: cursor, w: rect.w, h: size }
      : { x: cursor, y: rect.y, w: size, h: rect.h }
    cursor += size
    if (index === cells.length - 1) return
    const sashRect = verticalLane
      ? { x: rect.x, y: cursor, w: rect.w, h: DOCK_SASH }
      : { x: cursor, y: rect.y, w: DOCK_SASH, h: rect.h }
    sashes.push({
      key: `cell:${edge}:${laneIndex}:${cell.cellIndex}`,
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
  const sashes: DockSash[] = []
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
    placeCells("left", lane.laneIndex, lane.cells, { x, y: 0, w: width, h: root.height }, bands, sashes)
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
    placeCells("right", lane.laneIndex, lane.cells, { x: rightCursor, y: 0, w: width, h: root.height }, bands, sashes)
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
    placeCells("top", lane.laneIndex, lane.cells, { x: centerX, y, w: centerW, h: height }, bands, sashes)
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
    placeCells("bottom", lane.laneIndex, lane.cells, { x: centerX, y: bottomCursor, w: centerW, h: height }, bands, sashes)
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
    sashes,
    main: { x: centerX, y, w: centerW, h: Math.max(0, bottomCursor - y) },
  }
}

function lineSide(side: DockEdge) {
  return side === "top" || side === "bottom"
}

function windowPreview(root: { width: number; height: number }, edge: DockEdge): DockRect {
  if (edge === "left") return { x: 0, y: 0, w: DOCK_SIDE_PREVIEW, h: root.height }
  if (edge === "right") return { x: Math.max(0, root.width - DOCK_SIDE_PREVIEW), y: 0, w: DOCK_SIDE_PREVIEW, h: root.height }
  if (edge === "top") return { x: 0, y: 0, w: root.width, h: DOCK_LINE_PREVIEW }
  return { x: 0, y: Math.max(0, root.height - DOCK_LINE_PREVIEW), w: root.width, h: DOCK_LINE_PREVIEW }
}

function panelPreview(root: { width: number; height: number }, rect: DockRect, side: DockEdge): DockRect {
  if (side === "left") return { x: rect.x, y: rect.y, w: Math.min(DOCK_SIDE_PREVIEW, rect.w), h: rect.h }
  if (side === "right") {
    return { x: Math.max(rect.x, rect.x + rect.w - DOCK_SIDE_PREVIEW), y: rect.y, w: Math.min(DOCK_SIDE_PREVIEW, rect.w), h: rect.h }
  }
  if (side === "top") return { x: rect.x, y: rect.y, w: rect.w, h: DOCK_LINE_PREVIEW }
  return { x: rect.x, y: Math.min(root.height - DOCK_LINE_PREVIEW, rect.y + rect.h - DOCK_LINE_PREVIEW), w: rect.w, h: DOCK_LINE_PREVIEW }
}

type HitCandidate = { gap: number; rank: number; hit: DockHit }

const PANEL_REACH = 24
const PANEL_INSET = 40
const PANEL_CROSS = 20

export type DockHitProbe = {
  mover?: DockRect
  ignoreId?: string
  floats?: Record<string, DockRect>
}

function spanOverlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

function pushPanelEdges(
  candidates: HitCandidate[],
  root: { width: number; height: number },
  mover: DockRect,
  panelId: string,
  rect: DockRect,
) {
  const vertical = spanOverlap(mover.y, mover.y + mover.h, rect.y, rect.y + rect.h)
  const horizontal = spanOverlap(mover.x, mover.x + mover.w, rect.x, rect.x + rect.w)
  const sides: { side: DockEdge; gap: number; cross: number }[] = [
    { side: "left", gap: rect.x - (mover.x + mover.w), cross: vertical },
    { side: "right", gap: mover.x - (rect.x + rect.w), cross: vertical },
    { side: "top", gap: rect.y - (mover.y + mover.h), cross: horizontal },
    { side: "bottom", gap: mover.y - (rect.y + rect.h), cross: horizontal },
  ]
  for (const item of sides) {
    if (item.cross < PANEL_CROSS || item.gap > PANEL_REACH || item.gap < -PANEL_INSET) continue
    candidates.push({
      gap: Math.abs(item.gap),
      rank: 0,
      hit: {
        kind: "panel",
        panelId,
        side: item.side,
        preview: panelPreview(root, rect, item.side),
        line: lineSide(item.side),
      },
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
  const windowGaps: { edge: DockEdge; gap: number }[] = [
    { edge: "left", gap: pointer.x },
    { edge: "right", gap: root.width - pointer.x },
    { edge: "top", gap: pointer.y },
    { edge: "bottom", gap: root.height - pointer.y },
  ]
  for (const item of windowGaps) {
    if (item.gap > DOCK_HIT) continue
    candidates.push({
      gap: item.gap,
      rank: 2,
      hit: { kind: "window", edge: item.edge, preview: windowPreview(root, item.edge), line: lineSide(item.edge) },
    })
  }
  const mover = probe?.mover
  const targets: [string, DockRect][] = [
    ...Object.entries(bands),
    ...Object.entries(probe?.floats ?? {}),
  ]
  for (const [panelId, rect] of targets) {
    if (panelId === probe?.ignoreId) continue
    if (mover) {
      pushPanelEdges(candidates, root, mover, panelId, rect)
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
  bPx: number,
  cross: number,
  visible: ReadonlySet<string>,
) {
  const lane = layout.lanes[edge][laneIndex]
  if (!lane) return
  const shown = lane.cells
    .map((cell, index) => ({ cell, index }))
    .filter((item) => visible.has(item.cell.id))
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
