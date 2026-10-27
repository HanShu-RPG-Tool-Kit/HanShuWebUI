import { randomId } from '../../project/crypto'
import { nextProgressIdentifier, nextObjectiveIdentifier, clone, getCanvasNote, getEndNode, getPredicateNode, getObjectiveNode, getProgressNode, getTransitionNode, hasCanvasItem, hasContentNode, NOTE_COLORS, text, removeNode, type FlowCanvasNote, type FlowPort, type FlowPosition, type ProgressFlow } from './model'

export const NODE_WIDTH = 216
export const NODE_HEIGHT = 118
export const PREDICATE_WIDTH = 200
export const PREDICATE_HEIGHT = 84
export const TRANSITION_WIDTH = 180
export const TRANSITION_HEIGHT = 96
export const END_WIDTH = 168
export const END_HEIGHT = 112
const COLUMN_WIDTH = 276
const ROW_HEIGHT = 150
const PADDING = 64

export function nodeMetrics(flow: ProgressFlow, id: string) {
  const note = getCanvasNote(flow, id)
  if (note) return { width: note.width, height: note.height, socketY: 0 }
  if (getTransitionNode(flow, id)) return { width: TRANSITION_WIDTH, height: TRANSITION_HEIGHT, socketY: 48 }
  if (getEndNode(flow, id)) return { width: END_WIDTH, height: END_HEIGHT, socketY: 0 }
  if (getPredicateNode(flow, id)) return { width: PREDICATE_WIDTH, height: PREDICATE_HEIGHT, socketY: 68 }
  return { width: NODE_WIDTH, height: NODE_HEIGHT, socketY: 86 }
}

export function socketOffset(flow: ProgressFlow, id: string, port: FlowPort): FlowPosition {
  const metrics = nodeMetrics(flow, id)
  const right = port === 'output' || port === 'output2'
  if (getProgressNode(flow, id) || getObjectiveNode(flow, id)) return { x: right ? metrics.width : 0, y: port === 'output2' ? 104 : 86 }
  if (getTransitionNode(flow, id)) {
    if (port === 'input2') return { x: 0, y: 70 }
    return { x: right ? metrics.width : 0, y: 42 }
  }
  if (getEndNode(flow, id)) return { x: 0, y: port === 'input2' ? 98 : 76 }
  return { x: right ? metrics.width : 0, y: 68 }
}

/** Initial arrangement only. Once edited, saved positions keep unrelated nodes still. */
export function layoutCanvas(flow: ProgressFlow) {
  const ids = [...Object.keys(flow.progress), ...Object.keys(flow.predicates ?? {}), ...Object.keys(flow.objectives ?? {}), ...Object.keys(flow.transitions ?? {}), ...Object.keys(flow.ends ?? {}), ...Object.keys(flow.layout?.notes ?? {})], known = new Set(ids)
  const edges: { parent: string; target: string }[] = []
  for (const link of flow.logic?.links ?? []) edges.push({ parent: link.from, target: link.to })
  const outgoing = new Map(ids.map((id) => [id, [] as number[]]))
  const incoming = new Map(ids.map((id) => [id, 0]))
  edges.forEach(({ parent, target }, index) => {
    outgoing.get(parent)?.push(index)
    if (known.has(target)) incoming.set(target, incoming.get(target)! + 1)
  })
  const roots: string[] = [], depth = new Map<string, number>()
  const children = new Map(ids.map((id) => [id, [] as string[]]))
  for (const root of [...ids.filter((id) => incoming.get(id) === 0), ...ids]) {
    if (!known.has(root) || depth.has(root)) continue
    roots.push(root); depth.set(root, 0)
    const queue = [root]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]
      for (const index of outgoing.get(id) ?? []) {
        const target = edges[index].target
        if (!known.has(target) || depth.has(target)) continue
        depth.set(target, depth.get(id)! + 1); children.get(id)!.push(target); queue.push(target)
      }
    }
  }
  const positions = new Map<string, FlowPosition>()
  let row = 0
  for (const root of roots) {
    const stack = [{ id: root, expanded: false }]
    while (stack.length) {
      const entry = stack.pop()!, childIds = children.get(entry.id)!
      if (!entry.expanded && childIds.length) {
        stack.push({ ...entry, expanded: true })
        for (let i = childIds.length - 1; i >= 0; i--) stack.push({ id: childIds[i], expanded: false })
        continue
      }
      positions.set(entry.id, {
        x: PADDING + depth.get(entry.id)! * COLUMN_WIDTH,
        y: childIds.length ? (positions.get(childIds[0])!.y + positions.get(childIds.at(-1)!)!.y) / 2 : PADDING + row++ * ROW_HEIGHT,
      })
    }
    row++
  }
  let width = 1200, height = 760
  for (const id of ids) {
    const saved = flow.layout?.positions
    if (saved && Object.hasOwn(saved, id)) positions.set(id, { ...saved[id] })
    const p = positions.get(id)!
    width = Math.max(width, p.x + nodeMetrics(flow, id).width + 160)
    height = Math.max(height, p.y + nodeMetrics(flow, id).height + 160)
  }
  return { ids, positions, outgoing, width, height }
}

export function withCanvasPositions(flow: ProgressFlow): ProgressFlow {
  const next = clone(flow)
  next.layout = { ...next.layout, positions: Object.fromEntries(layoutCanvas(flow).positions) }
  return next
}

function requirePosition(position: FlowPosition) {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('节点位置必须是有效的画布坐标。')
}

/** 进度节点：非本地化标识符、日志与内嵌 goal 元素；状态只在模拟器里。 */
export function createProgressNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `progress_${randomId()}` } while (hasCanvasItem(next, id) || id === next.start)
  next.progress[id] = {
    identifier: nextProgressIdentifier(next),
    runningLog: text(`progress.${id}.runningLog`),
    completedLog: text(`progress.${id}.completedLog`),
    goals: [],
    completion: 'all',
  }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id, localeSeeds: { [`progress.${id}.runningLog`]: '', [`progress.${id}.completedLog`]: '' } }
}

export function createPredicateNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `predicate_${randomId()}` } while (hasCanvasItem(next, id) || id === next.start)
  next.predicates ??= {}
  next.predicates[id] = {
    conditions: [],
  }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createObjectiveNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `objective_${randomId()}` } while (hasCanvasItem(next, id))
  next.objectives ??= {}
  next.objectives[id] = { identifier: nextObjectiveIdentifier(next), goal: { kind: '', params: {} } }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createTransitionNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `transition_${randomId()}` } while (hasCanvasItem(next, id) || id === next.start)
  next.transitions ??= {}
  next.transitions[id] = {}
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createEndNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `end_${randomId()}` } while (hasCanvasItem(next, id) || id === next.start)
  next.ends ??= {}
  next.ends[id] = { title: text(`ends.${id}.title`), rewardKits: [] }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id, localeSeeds: { [`ends.${id}.title`]: '新结局' } }
}

/** Notes belong only to the canvas layout; they never expose graph ports. */
export function createCanvasNote(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `note_${randomId()}` } while (hasCanvasItem(next, id) || id === next.start)
  next.layout!.notes ??= {}
  next.layout!.notes[id] = { title: '注释', text: '', width: 280, height: 160, color: 'slate' }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function updateCanvasNote(flow: ProgressFlow, id: string, patch: Partial<FlowCanvasNote>): ProgressFlow {
  const current = getCanvasNote(flow, id)
  if (!current) return flow
  const next = clone(flow), note = { ...current, ...patch }
  if (!Number.isFinite(note.width) || note.width < 160 || !Number.isFinite(note.height) || note.height < 96) throw new Error('注释尺寸不能小于 160×96。')
  if (!Object.hasOwn(NOTE_COLORS, note.color)) throw new Error('注释颜色无效。')
  next.layout!.notes![id] = note
  return next
}

export function removeCanvasNote(flow: ProgressFlow, id: string): ProgressFlow {
  if (!getCanvasNote(flow, id)) return flow
  const next = clone(flow)
  delete next.layout!.notes![id]
  delete next.layout!.positions[id]
  if (next.layout!.groups) next.layout!.groups = Object.fromEntries(Object.entries(next.layout!.groups).map(([key, group]) => [key, { ...group, nodes: group.nodes.filter(node => node !== id) }] as const).filter(([, group]) => group.nodes.length >= 2))
  return next
}

export function removeCanvasItems(flow: ProgressFlow, ids: string[]) {
  const removable = [...new Set(ids)].filter(id => id !== flow.start && hasCanvasItem(flow, id))
  if (!removable.length) return flow
  return removable.reduce((next, id) => getCanvasNote(next, id) ? removeCanvasNote(next, id) : removeNode(next, id), withCanvasPositions(flow))
}

export function moveCanvasNodes(flow: ProgressFlow, positions: Record<string, FlowPosition>) {
  const next = withCanvasPositions(flow)
  for (const [id, position] of Object.entries(positions)) {
    requirePosition(position)
    if (id === flow.start || hasCanvasItem(flow, id)) next.layout!.positions[id] = { ...position }
  }
  return next
}

export function groupCanvasNodes(flow: ProgressFlow, ids: string[]) {
  const nodes = [...new Set(ids)].filter(id => id === flow.start || hasCanvasItem(flow, id))
  if (nodes.length < 2) throw new Error('请选择至少两个节点。')
  const next = withCanvasPositions(flow), selected = new Set(nodes)
  next.layout!.groups = Object.fromEntries(Object.entries(next.layout!.groups ?? {}).map(([id, group]) => [id, { ...group, nodes: group.nodes.filter(node => !selected.has(node)) }] as const).filter(([, group]) => group.nodes.length >= 2))
  const id = `group_${randomId()}`
  const names = new Set(Object.values(next.layout!.groups).map((group, index) => group.name || `Group ${index + 1}`))
  let number = 1
  while (names.has(`Group ${number}`)) number++
  next.layout!.groups[id] = { name: `Group ${number}`, nodes }
  return { flow: next, id }
}

export function renameCanvasGroup(flow: ProgressFlow, id: string, name: string): ProgressFlow {
  const group = flow.layout?.groups?.[id], value = name.trim()
  if (!group || !value || value.length > 80) return flow
  const next = clone(flow)
  next.layout!.groups![id].name = value
  return next
}

export function ungroupCanvasNodes(flow: ProgressFlow, id: string): ProgressFlow {
  if (!flow.layout?.groups || !Object.hasOwn(flow.layout.groups, id)) return flow
  const next = clone(flow)
  delete next.layout!.groups![id]
  return next
}

export function hasNodeContent(flow: ProgressFlow, id: string) { return hasContentNode(flow, id) }
