import type { DockEdge } from "./panelDockModel"

export type EditorRect = { x: number; y: number; w: number; h: number }

export type EditorLeaf = {
  kind: "leaf"
  id: string
  tabs: string[]
  active: string
}

export type EditorSplit = {
  kind: "split"
  id: string
  direction: "row" | "column"
  ratio: number
  first: EditorNode
  second: EditorNode
}

export type EditorNode = EditorLeaf | EditorSplit

export type EditorFloat = {
  id: string
  tabs: string[]
  active: string
  rect: EditorRect
}

export type EditorDockState = {
  version: 1
  root: EditorNode | null
  floats: EditorFloat[]
  focusId: string | null
  seq: number
  pinned?: string[]
}

export function editorDockGroups(state: EditorDockState) {
  return groups(state).map(group => ({ id: group.id, tabs: [...group.tabs], active: group.active, floating: state.floats.some(f => f.id === group.id) }))
}

export function editorDockCloseTargets(state: EditorDockState, groupId: string, tabId: string, mode: 'one' | 'others' | 'right' | 'group') {
  const group = groupOf(state, groupId)
  if (!group || !group.tabs.includes(tabId)) return []
  const pinned = new Set(state.pinned ?? [])
  return group.tabs.filter((id, index) => !pinned.has(id) && (mode === 'group' || (mode === 'one' ? id === tabId : mode === 'others' ? id !== tabId : index > group.tabs.indexOf(tabId))))
}

export function closeEditorDockTabs(state: EditorDockState, ids: string[]): EditorDockState {
  const next = clone(state), closing = new Set(ids)
  for (const group of groups(next)) {
    const activeIndex = group.tabs.indexOf(group.active)
    if (closing.has(group.active)) group.active = group.tabs.slice(activeIndex + 1).find(id => !closing.has(id)) ?? group.tabs.slice(0, activeIndex).reverse().find(id => !closing.has(id)) ?? ''
    group.tabs = group.tabs.filter(id => !closing.has(id))
  }
  return normalize(next)
}

export function toggleEditorDockPin(state: EditorDockState, id: string): EditorDockState {
  if (!allTabs(state).includes(id)) return state
  const next = clone(state), pinned = next.pinned ?? []
  next.pinned = pinned.includes(id) ? pinned.filter(key => key !== id) : [...pinned, id]
  return normalize(next)
}

export function mergeEditorDockGroups(state: EditorDockState, targetId: string): EditorDockState {
  const target = groupOf(state, targetId)
  if (!target) return state
  const next = clone(state), tabs = unique([...target.tabs, ...allTabs(state)])
  next.root = { kind: 'leaf', id: targetId, tabs, active: target.active }
  next.floats = []; next.focusId = targetId
  return normalize(next)
}

export type EditorDrag = {
  fromId: string
  tabs: string[]
}

export type EditorDrop =
  | { kind: "tabs"; targetId: string; beforeId: string | null }
  | { kind: "split"; targetId: string; side: DockEdge }
  | { kind: "window"; side: DockEdge }
  | { kind: "float"; rect: EditorRect }
  | { kind: "cancel" }

export type EditorHit =
  | { kind: "tabs"; targetId: string; preview: EditorRect }
  | { kind: "split"; targetId: string; side: DockEdge; preview: EditorRect; line: boolean }
  | { kind: "window"; side: DockEdge; preview: EditorRect; line: boolean }
  | { kind: "float" }

const REACH = 28
const MIN_CROSS = 16

export function createEditorDockState(pageIds: string[], activeId: string | null): EditorDockState {
  const tabs = unique(pageIds)
  if (!tabs.length) return { version: 1, root: null, floats: [], focusId: null, seq: 1, pinned: [] }
  const active = activeId && tabs.includes(activeId) ? activeId : tabs[0]!
  return {
    version: 1,
    pinned: [],
    root: { kind: "leaf", id: "ed-1", tabs, active },
    floats: [],
    focusId: "ed-1",
    seq: 1,
  }
}

export function readEditorDockState(raw: string | null, pageIds: string[], activeId: string | null, initialPinnedIds: readonly string[] = []): EditorDockState {
  const fallback = () => syncEditorDock({ ...createEditorDockState(pageIds, activeId), pinned: [...initialPinnedIds] }, pageIds, activeId)
  if (!raw) return fallback()
  try {
    const parsed = JSON.parse(raw) as EditorDockState
    if (!parsed || parsed.version !== 1) return fallback()
    parsed.pinned ??= [...initialPinnedIds]
    return syncEditorDock(parsed, pageIds, activeId)
  } catch {
    return fallback()
  }
}

export function syncEditorDock(state: EditorDockState, pageIds: string[], activeId: string | null): EditorDockState {
  const live = new Set(unique(pageIds))
  const next = clone(state)
  stripUnknown(next, live)
  const have = new Set(allTabs(next))
  const missing = unique(pageIds).filter((id) => !have.has(id))
  if (missing.length) insertMissing(next, missing, activeId)
  if (activeId && allTabs(next).includes(activeId)) activateInPlace(next, activeId)
  else if (!next.focusId || !groupOf(next, next.focusId)) next.focusId = firstGroupId(next)
  return normalize(next)
}

export function applyEditorDrop(state: EditorDockState, drag: EditorDrag, drop: EditorDrop): EditorDockState {
  if (drop.kind === "cancel" || !drag.tabs.length) return state
  const source = groupOf(state, drag.fromId)
  if (!source) return state
  const moving = drag.tabs.filter((id) => source.tabs.includes(id))
  if (!moving.length) return state
  if (drop.kind === "tabs" && drop.targetId === drag.fromId) {
    if (moving.length === source.tabs.length) return state
    if (moving.length !== 1) return state
    const next = clone(state)
    const group = groupOf(next, drag.fromId)
    if (!group) return state
    group.tabs = insertBefore(group.tabs, moving[0]!, drop.beforeId)
    group.active = moving[0]!
    next.focusId = group.id
    return normalize(next)
  }
  if (drop.kind === "split" && drop.targetId === drag.fromId && moving.length === source.tabs.length) {
    return state
  }
  const next = clone(state)
  const taken = take(next, drag.fromId, new Set(moving))
  if (!taken.length) return state
  place(next, taken, drop)
  return normalize(next)
}

export function setEditorSplitRatio(state: EditorDockState, splitId: string, ratio: number): EditorDockState {
  const next = clone(state)
  const split = findSplit(next.root, splitId)
  if (!split) return state
  split.ratio = clampRatio(ratio)
  return next
}

export function moveEditorFloat(state: EditorDockState, id: string, rect: EditorRect): EditorDockState {
  const next = clone(state)
  const float = next.floats.find((item) => item.id === id)
  if (!float) return state
  float.rect = rect
  next.focusId = id
  return next
}

export function redockEditorFloat(state: EditorDockState, id: string): EditorDockState {
  const float = state.floats.find((item) => item.id === id)
  if (!float) return state
  return applyEditorDrop(state, { fromId: id, tabs: [...float.tabs] }, { kind: "window", side: "right" })
}

export function hitEditorDock(
  root: { width: number; height: number },
  pointer: { x: number; y: number },
  mover: EditorRect,
  leaves: { id: string; rect: EditorRect }[],
  tabBands: { id: string; rect: EditorRect }[],
  ignoreEdgeId?: string,
): EditorHit {
  for (const band of tabBands) {
    if (band.id === ignoreEdgeId) continue
    if (pointer.x < band.rect.x || pointer.x > band.rect.x + band.rect.w) continue
    if (pointer.y < band.rect.y || pointer.y > band.rect.y + band.rect.h) continue
    return { kind: "tabs", targetId: band.id, preview: band.rect }
  }
  let bestGap = Number.POSITIVE_INFINITY
  let bestLine = true
  let bestHit: EditorHit | null = null
  const consider = (gap: number, line: boolean, hit: EditorHit) => {
    if (gap > REACH) return
    if (gap < bestGap || (gap === bestGap && bestLine && !line)) {
      bestGap = gap
      bestLine = line
      bestHit = hit
    }
  }
  for (const leaf of leaves) {
    if (leaf.id === ignoreEdgeId) continue
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const gap = sideGap(mover, leaf.rect, side)
      if (gap == null) continue
      const line = side === "top" || side === "bottom"
      consider(gap, line, {
        kind: "split",
        targetId: leaf.id,
        side,
        preview: edgePreview(leaf.rect, side, mover),
        line,
      })
    }
  }
  const rootRect = { x: 0, y: 0, w: root.width, h: root.height }
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const gap = windowGap(mover, root, side)
    if (gap == null) continue
    const line = side === "top" || side === "bottom"
    consider(gap, line, { kind: "window", side, preview: edgePreview(rootRect, side, mover), line })
  }
  return bestHit ?? { kind: "float" }
}

function place(state: EditorDockState, tabs: string[], drop: EditorDrop) {
  if (drop.kind === "float") {
    const id = alloc(state)
    state.floats.push({ id, tabs: [...tabs], active: tabs[0]!, rect: drop.rect })
    state.focusId = id
    return
  }
  if (drop.kind === "tabs") {
    const group = groupOf(state, drop.targetId)
    if (!group) {
      place(state, tabs, { kind: "float", rect: { x: 24, y: 24, w: 500, h: 300 } })
      return
    }
    insertTabs(group, tabs, drop.beforeId)
    state.focusId = group.id
    return
  }
  const fresh = makeLeaf(state, tabs)
  if (drop.kind === "split") {
    const floating = detachFloat(state, drop.targetId)
    if (floating) {
      const split = join(fresh, floating, drop.side)
      split.id = alloc(state)
      attachNode(state, split, drop.side)
      state.focusId = fresh.id
      return
    }
    if (!state.root || !findLeaf(state.root, drop.targetId)) {
      if (!state.root) state.root = fresh
      else state.floats.push({ id: fresh.id, tabs: fresh.tabs, active: fresh.active, rect: { x: 24, y: 24, w: 500, h: 300 } })
      state.focusId = fresh.id
      return
    }
    state.root = splitAround(state.root, drop.targetId, fresh, drop.side)
    state.focusId = fresh.id
    return
  }
  if (drop.kind === "window") {
    if (!state.root) state.root = fresh
    else state.root = wrap(state, state.root, fresh, drop.side)
    state.focusId = fresh.id
  }
}

function take(state: EditorDockState, fromId: string, tabIds: Set<string>): string[] {
  const taken: string[] = []
  const leaf = state.root ? findLeaf(state.root, fromId) : null
  if (leaf) {
    const keep: string[] = []
    for (const tab of leaf.tabs) (tabIds.has(tab) ? taken : keep).push(tab)
    leaf.tabs = keep
    if (!keep.includes(leaf.active)) leaf.active = keep[0] ?? ""
    state.root = collapse(state.root)
    return taken
  }
  const float = state.floats.find((item) => item.id === fromId)
  if (!float) return taken
  const keep: string[] = []
  for (const tab of float.tabs) (tabIds.has(tab) ? taken : keep).push(tab)
  float.tabs = keep
  if (!keep.length) state.floats = state.floats.filter((item) => item.id !== fromId)
  else if (!keep.includes(float.active)) float.active = keep[0]!
  return taken
}

function insertMissing(state: EditorDockState, tabs: string[], activeId: string | null) {
  const group = (state.focusId && groupOf(state, state.focusId)) || firstGroup(state)
  if (!group) {
    const leaf = makeLeaf(state, tabs)
    if (activeId && leaf.tabs.includes(activeId)) leaf.active = activeId
    state.root = leaf
    state.focusId = leaf.id
    return
  }
  insertTabs(group, tabs, null)
  if (activeId && group.tabs.includes(activeId)) group.active = activeId
  state.focusId = group.id
}

function activateInPlace(state: EditorDockState, tabId: string) {
  const located = locate(state, tabId)
  if (!located) return
  located.group.active = tabId
  state.focusId = located.group.id
}

function stripUnknown(state: EditorDockState, live: Set<string>) {
  const walk = (node: EditorNode | null): EditorNode | null => {
    if (!node) return null
    if (node.kind === "leaf") {
      node.tabs = node.tabs.filter((id) => live.has(id))
      if (!node.tabs.includes(node.active)) node.active = node.tabs[0] ?? ""
      return node.tabs.length ? node : null
    }
    node.first = walk(node.first) as EditorNode
    node.second = walk(node.second) as EditorNode
    return collapse(node)
  }
  state.root = walk(state.root)
  state.floats = state.floats.flatMap((float) => {
    float.tabs = float.tabs.filter((id) => live.has(id))
    if (!float.tabs.length) return []
    if (!float.tabs.includes(float.active)) float.active = float.tabs[0]!
    return [float]
  })
}

function normalize(state: EditorDockState): EditorDockState {
  state.root = collapse(state.root)
  state.floats = state.floats.filter((float) => float.tabs.length)
  const live = new Set(allTabs(state))
  state.pinned = unique((state.pinned ?? []).filter(id => live.has(id)))
  const pinned = new Set(state.pinned)
  for (const group of groups(state)) {
    group.tabs = unique(group.tabs)
    group.tabs = [...group.tabs.filter(id => pinned.has(id)), ...group.tabs.filter(id => !pinned.has(id))]
    if (!group.tabs.includes(group.active)) group.active = group.tabs[0] ?? ""
  }
  if (state.focusId && !groupOf(state, state.focusId)) state.focusId = firstGroupId(state)
  return state
}

function collapse(node: EditorNode | null): EditorNode | null {
  if (!node) return null
  if (node.kind === "leaf") return node.tabs.length ? node : null
  const first = collapse(node.first)
  const second = collapse(node.second)
  if (!first) return second
  if (!second) return first
  node.first = first
  node.second = second
  return node
}

function splitAround(node: EditorNode, targetId: string, fresh: EditorLeaf, side: DockEdge): EditorNode {
  if (node.kind === "leaf") {
    if (node.id !== targetId) return node
    return join(fresh, node, side)
  }
  return {
    ...node,
    first: splitAround(node.first, targetId, fresh, side),
    second: splitAround(node.second, targetId, fresh, side),
  }
}

function detachFloat(state: EditorDockState, id: string): EditorLeaf | null {
  const index = state.floats.findIndex((item) => item.id === id)
  if (index < 0) return null
  const float = state.floats[index]!
  state.floats.splice(index, 1)
  return { kind: "leaf", id: float.id, tabs: [...float.tabs], active: float.active }
}

function attachNode(state: EditorDockState, node: EditorNode, side: DockEdge) {
  if (!state.root) {
    state.root = node
    return
  }
  const before = side === "left" || side === "top"
  state.root = {
    kind: "split",
    id: alloc(state),
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: before ? 0.38 : 0.62,
    first: before ? node : state.root,
    second: before ? state.root : node,
  }
}

function wrap(state: EditorDockState, existing: EditorNode, fresh: EditorLeaf, side: DockEdge): EditorSplit {
  const split = join(fresh, existing, side)
  split.id = alloc(state)
  return split
}

function join(fresh: EditorLeaf, existing: EditorNode, side: DockEdge): EditorSplit {
  const before = side === "left" || side === "top"
  return {
    kind: "split",
    id: `split-${fresh.id}`,
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: 0.5,
    first: before ? fresh : existing,
    second: before ? existing : fresh,
  }
}

function makeLeaf(state: EditorDockState, tabs: string[]): EditorLeaf {
  return { kind: "leaf", id: alloc(state), tabs: [...tabs], active: tabs[0]! }
}

function alloc(state: EditorDockState): string {
  state.seq += 1
  return `ed-${state.seq}`
}

function insertTabs(group: { tabs: string[]; active: string }, tabs: string[], beforeId: string | null) {
  let next = group.tabs.filter((id) => !tabs.includes(id))
  for (const tab of tabs) next = insertBefore(next, tab, beforeId)
  group.tabs = next
  group.active = tabs[0]!
}

function insertBefore(list: string[], key: string, beforeId: string | null) {
  const rest = list.filter((id) => id !== key)
  const index = beforeId ? rest.indexOf(beforeId) : -1
  if (index < 0) return [...rest, key]
  return [...rest.slice(0, index), key, ...rest.slice(index)]
}

function groupOf(state: EditorDockState, id: string): { id: string; tabs: string[]; active: string } | null {
  const leaf = state.root ? findLeaf(state.root, id) : null
  if (leaf) return leaf
  return state.floats.find((item) => item.id === id) ?? null
}

function firstGroup(state: EditorDockState) {
  return (state.root ? firstLeaf(state.root) : null) ?? state.floats[0] ?? null
}

function firstGroupId(state: EditorDockState) {
  return firstGroup(state)?.id ?? null
}

function groups(state: EditorDockState) {
  const list: { id: string; tabs: string[]; active: string }[] = []
  const walk = (node: EditorNode | null) => {
    if (!node) return
    if (node.kind === "leaf") list.push(node)
    else { walk(node.first); walk(node.second) }
  }
  walk(state.root)
  list.push(...state.floats)
  return list
}

function allTabs(state: EditorDockState) {
  return groups(state).flatMap((group) => group.tabs)
}

function locate(state: EditorDockState, tabId: string) {
  for (const group of groups(state)) {
    if (group.tabs.includes(tabId)) return { group }
  }
  return null
}

function findLeaf(node: EditorNode, id: string): EditorLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null
  return findLeaf(node.first, id) ?? findLeaf(node.second, id)
}

function findSplit(node: EditorNode | null, id: string): EditorSplit | null {
  if (!node || node.kind === "leaf") return null
  if (node.id === id) return node
  return findSplit(node.first, id) ?? findSplit(node.second, id)
}

function firstLeaf(node: EditorNode): EditorLeaf | null {
  if (node.kind === "leaf") return node
  return firstLeaf(node.first) ?? firstLeaf(node.second)
}

function unique(ids: string[]) {
  return [...new Set(ids.filter(Boolean))]
}

function clampRatio(value: number) {
  return Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5
}

function clone(state: EditorDockState): EditorDockState {
  return structuredClone(state)
}

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

function sideGap(mover: EditorRect, rect: EditorRect, side: DockEdge): number | null {
  const cross = side === "left" || side === "right"
    ? overlap(mover.y, mover.y + mover.h, rect.y, rect.y + rect.h)
    : overlap(mover.x, mover.x + mover.w, rect.x, rect.x + rect.w)
  if (cross < MIN_CROSS) return null
  const near = (facing: number, same: number) => {
    if (facing <= REACH && facing >= -36) return Math.abs(facing)
    if (same <= REACH) return same
    return null
  }
  if (side === "left") return near(rect.x - (mover.x + mover.w), Math.abs(mover.x - rect.x))
  if (side === "right") return near(mover.x - (rect.x + rect.w), Math.abs(mover.x + mover.w - (rect.x + rect.w)))
  if (side === "top") return near(rect.y - (mover.y + mover.h), Math.abs(mover.y - rect.y))
  return near(mover.y - (rect.y + rect.h), Math.abs(mover.y + mover.h - (rect.y + rect.h)))
}

function windowGap(mover: EditorRect, root: { width: number; height: number }, side: DockEdge): number | null {
  const cross = side === "left" || side === "right"
    ? overlap(mover.y, mover.y + mover.h, 0, root.height)
    : overlap(mover.x, mover.x + mover.w, 0, root.width)
  if (cross < MIN_CROSS) return null
  if (side === "left") return mover.x <= REACH ? Math.max(0, mover.x) : null
  if (side === "right") {
    const gap = root.width - (mover.x + mover.w)
    return gap <= REACH ? Math.max(0, gap) : null
  }
  if (side === "top") return mover.y <= REACH ? Math.max(0, mover.y) : null
  const gap = root.height - (mover.y + mover.h)
  return gap <= REACH ? Math.max(0, gap) : null
}

function edgePreview(rect: EditorRect, side: DockEdge, mover: EditorRect): EditorRect {
  if (side === "left" || side === "right") {
    const w = Math.max(24, Math.min(mover.w > 48 ? mover.w : 280, Math.max(24, rect.w * 0.5), rect.w))
    return side === "left"
      ? { x: rect.x, y: rect.y, w, h: rect.h }
      : { x: rect.x + rect.w - w, y: rect.y, w, h: rect.h }
  }
  if (side === "top") return { x: rect.x, y: rect.y, w: rect.w, h: 2 }
  return { x: rect.x, y: rect.y + rect.h - 2, w: rect.w, h: 2 }
}
