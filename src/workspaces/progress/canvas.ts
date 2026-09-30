import { addNode, branches, clone, connectNodes, getCanvasNote, getNode, hasCanvasItem, NOTE_COLORS, getGoalNode, getLogicNode, getTransitionNode, getHubNode, getGatewayNode, hasContentNode, makeNode, removeNode, LOGIC_SYMBOLS, text, type FlowCanvasNote, type FlowPort, type FlowPosition, type LogicOperator, type ProgressFlow } from './model'

export const NODE_WIDTH = 216
export const NODE_HEIGHT = 108
export const ENTRY_HEIGHT = 62
export const SOCKET_Y = 59
const COLUMN_WIDTH = 276
const ROW_HEIGHT = 144
const PADDING = 64

export function socketOffset(flow: ProgressFlow, id: string, port: FlowPort): FlowPosition {
  const metrics = nodeMetrics(flow, id)
  const right = port === 'output' || port === 'output2'
  let y = metrics.socketY
  if (getTransitionNode(flow, id) && !right) y = port === 'input2' ? 86 : 58
  else if (getHubNode(flow, id) && right) y = port === 'output2' ? 86 : 58
  else if (getGatewayNode(flow, id) && !right) y = port === 'input2' ? 86 : 58
  return { x: right ? metrics.width : 0, y }
}
export function nodeMetrics(flow: ProgressFlow, id: string) {
  const note = getCanvasNote(flow, id)
  if (note) return { width: note.width, height: note.height, socketY: 0 }
  if (id === flow.entry.id) return { width: 156, height: ENTRY_HEIGHT, socketY: 44 }
  if (getTransitionNode(flow, id) || getHubNode(flow, id) || getGatewayNode(flow, id)) return { width: 180, height: 108, socketY: 72 }
  if (getLogicNode(flow, id)) return { width: 156, height: 76, socketY: 57 }
  return { width: NODE_WIDTH, height: getGoalNode(flow, id) ? 94 : NODE_HEIGHT, socketY: SOCKET_Y }
}

/** Initial arrangement only. Once edited, saved positions keep unrelated nodes still. */
export function layoutCanvas(flow: ProgressFlow) {
  const ids = [flow.entry.id, ...Object.keys(flow.nodes), ...Object.keys(flow.logic?.nodes ?? {}), ...Object.keys(flow.goals ?? {}), ...Object.keys(flow.transitions ?? {}), ...Object.keys(flow.hubs ?? {}), ...Object.keys(flow.gateways ?? {}), ...Object.keys(flow.layout?.notes ?? {})], known = new Set(ids)
  const edges = branches(flow).map(({ parent, branch }) => ({ parent, target: branch.target }))
  for (const link of flow.logic?.links ?? []) edges.push({ parent: link.from, target: link.to })
  if (flow.entry.target !== null) edges.unshift({ parent: flow.entry.id, target: flow.entry.target })
  const outgoing = new Map(ids.map((id) => [id, [] as number[]]))
  const incoming = new Map(ids.map((id) => [id, 0]))
  edges.forEach(({ parent, target }, index) => {
    outgoing.get(parent)?.push(index)
    if (known.has(target)) incoming.set(target, incoming.get(target)! + 1)
  })
  const roots: string[] = [], depth = new Map<string, number>()
  const children = new Map(ids.map((id) => [id, [] as string[]]))
  for (const root of [flow.entry.id, ...ids.filter((id) => incoming.get(id) === 0), ...ids]) {
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

export function createCheckpoint(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `ckpt_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.nodes[id] = makeNode('新 checkpoint')
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createLogicNode(flow: ProgressFlow, operator: LogicOperator, position: FlowPosition) {
  requirePosition(position)
  if (!['and', 'or'].includes(operator)) throw new Error('未知的逻辑节点类型。')
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `logic_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.logic ??= { nodes: {}, links: [] }
  next.logic.nodes[id] = { operator, title: text(`A ${LOGIC_SYMBOLS[operator]} B`), description: text() }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}
export function createTransitionNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `transition_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.transitions ??= {}
  next.transitions[id] = { title: text('转移'), description: text() }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createHubNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `hub_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.hubs ??= {}
  next.hubs[id] = { title: text('集线器'), description: text() }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createGatewayNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `gateway_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.gateways ??= {}
  next.gateways[id] = { title: text('网关'), description: text() }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function createGoalNode(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `goal_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.goals ??= {}
  next.goals[id] = { kind: 'manual', title: text('新目标'), description: text(), params: {}, nodeRefs: [] }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

/** Notes belong only to the canvas layout; they never expose graph ports. */
export function createCanvasNote(flow: ProgressFlow, position: FlowPosition) {
  requirePosition(position)
  const next = withCanvasPositions(flow)
  let id: string
  do { id = `note_${crypto.randomUUID()}` } while (hasCanvasItem(next, id) || id === next.entry.id)
  next.layout!.notes ??= {}
  next.layout!.notes[id] = { title: '注释', text: '', width: 280, height: 160, color: 'slate' }
  next.layout!.positions[id] = { ...position }
  return { flow: next, id }
}

export function updateCanvasNote(flow: ProgressFlow, id: string, patch: Partial<FlowCanvasNote>) {
  const note = getCanvasNote(flow, id)
  if (!note) return flow
  const value = { ...note, ...patch }
  if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || !Object.hasOwn(NOTE_COLORS, value.color)) throw new Error('注释的尺寸或颜色不正确。')
  value.width = Math.max(160, value.width); value.height = Math.max(96, value.height)
  if (Object.keys(value).every(key => value[key as keyof FlowCanvasNote] === note[key as keyof FlowCanvasNote])) return flow
  const next = clone(flow)
  next.layout!.notes![id] = value
  return next
}

export function removeCanvasNote(flow: ProgressFlow, id: string) {
  if (!getCanvasNote(flow, id)) return flow
  const next = clone(flow)
  delete next.layout!.notes![id]
  delete next.layout!.positions[id]
  if (next.layout!.groups) next.layout!.groups = Object.fromEntries(Object.entries(next.layout!.groups).map(([key, group]) => [key, { ...group, nodes: group.nodes.filter(node => node !== id) }] as const).filter(([, group]) => group.nodes.length >= 2))
  return next
}

/** One document edit for a mixed canvas selection. The permanent entry is always retained. */
export function removeCanvasItems(flow: ProgressFlow, ids: string[]) {
  const removable = [...new Set(ids)].filter(id => id !== flow.entry.id && hasCanvasItem(flow, id))
  if (!removable.length) return flow
  return removable.reduce((next, id) => getCanvasNote(next, id) ? removeCanvasNote(next, id) : removeNode(next, id), withCanvasPositions(flow))
}

export function moveCheckpoint(flow: ProgressFlow, id: string, position: FlowPosition) {
  requirePosition(position)
  if (id !== flow.entry.id && !hasContentNode(flow, id)) return flow
  const next = withCanvasPositions(flow)
  next.layout!.positions[id] = { ...position }
  return next
}

export function addNextCheckpoint(flow: ProgressFlow, parent: string) {
  const base = withCanvasPositions(flow)
  const p = base.layout!.positions[parent] ?? { x: PADDING, y: PADDING }
  const place = (seed: FlowPosition, positions: Record<string, FlowPosition>) => {
    const position = { ...seed }
    while (Object.values(positions).some((other) => Math.abs(other.x - position.x) < NODE_WIDTH + 20 && Math.abs(other.y - position.y) < NODE_HEIGHT + 20)) position.y += ROW_HEIGHT
    return position
  }
  if (parent === flow.entry.id) {
    const result = addNode(base, parent)
    result.flow.layout!.positions[result.id] = place({ x: p.x + COLUMN_WIDTH, y: p.y }, result.flow.layout!.positions)
    return result
  }
  if (!getNode(flow, parent) || flow.nodes[parent].completion === 'finish') throw new Error('请选择可继续推进的 checkpoint。')
  const transition = createTransitionNode(base, place({ x: p.x + COLUMN_WIDTH * 0.55, y: p.y }, base.layout!.positions))
  const checkpoint = createCheckpoint(transition.flow, place({ x: p.x + COLUMN_WIDTH, y: p.y }, transition.flow.layout!.positions))
  let next = connectNodes(checkpoint.flow, parent, transition.id, 'input2').flow
  next = connectNodes(next, transition.id, checkpoint.id).flow
  return { flow: next, id: checkpoint.id }
}

export function moveCanvasNodes(flow: ProgressFlow, positions: Record<string, FlowPosition>) {
  const next = withCanvasPositions(flow)
  for (const [id, position] of Object.entries(positions)) {
    requirePosition(position)
    if (id === flow.entry.id || hasCanvasItem(flow, id)) next.layout!.positions[id] = { ...position }
  }
  return next
}

export function groupCanvasNodes(flow: ProgressFlow, ids: string[]) {
  const nodes = [...new Set(ids)].filter(id => id === flow.entry.id || hasCanvasItem(flow, id))
  if (nodes.length < 2) throw new Error('请选择至少两个节点。')
  const next = withCanvasPositions(flow), selected = new Set(nodes)
  next.layout!.groups = Object.fromEntries(Object.entries(next.layout!.groups ?? {}).map(([id, group]) => [id, { ...group, nodes: group.nodes.filter(node => !selected.has(node)) }] as const).filter(([, group]) => group.nodes.length >= 2))
  const id = `group_${crypto.randomUUID()}`
  const names = new Set(Object.values(next.layout!.groups).map((group, index) => group.name || `Group ${index + 1}`))
  let number = 1
  while (names.has(`Group ${number}`)) number++
  next.layout!.groups[id] = { name: `Group ${number}`, nodes }
  return { flow: next, id }
}

export function renameCanvasGroup(flow: ProgressFlow, id: string, name: string) {
  const group = flow.layout?.groups?.[id], value = name.trim()
  if (!group || !value || group.name === value) return flow
  const next = clone(flow)
  next.layout!.groups![id].name = value
  return next
}

export function ungroupCanvasNodes(flow: ProgressFlow, id: string) {
  if (!flow.layout?.groups || !Object.hasOwn(flow.layout.groups, id)) return flow
  const next = clone(flow)
  delete next.layout!.groups![id]
  return next
}

function requirePosition(position: FlowPosition) {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('节点位置必须是有效的画布坐标。')
}
