import { parseJsonValue } from '../../utils/strictJson'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Data = { [key: string]: Json }
/** Plain author-facing copy on the canvas / forms. No localization keys. */
export type FlowText = { text: string }
export type FlowCondition = {
  id: string
  kind: 'manual' | 'counter' | 'signal' | 'nodes' | 'external'
  title: FlowText
  params: Data
  nodeRefs: string[]
  extensions?: Data
}
export type FlowPosition = { x: number; y: number }
export type FlowEntry = {
  id: string
  target: string | null
  port?: FlowInputPort
  title: FlowText
  description: FlowText
}
export type FlowInputPort = 'input' | 'input2' | `in${number}`
export type FlowOutputPort = 'output' | 'output2' | `out${number}`
export type FlowPort = FlowInputPort | FlowOutputPort
export type FlowPortKind = 'goal' | 'checkpoint'
/** fromPort is required for swap outs (outN); otherwise inferred by linkSourcePort. */
export type FlowLogicLink = { id: string; from: string; to: string; port: FlowInputPort; fromPort?: FlowOutputPort }
export type FlowTransitionNode = { title: FlowText; description: FlowText }
export type FlowConditionalNode = { title: FlowText; description: FlowText }
export type FlowDiffNode = { title: FlowText; description: FlowText }
export type FlowMergeNode = { title: FlowText; description: FlowText }
/** entries = visible slots (min 1); auto-expands to keep one spare after the highest used index. */
export type FlowSwapNode = { title: FlowText; description: FlowText; entries: number }
export type FlowGoalNode = Omit<FlowCondition, 'id'> & { description: FlowText }
export type FlowPredicateNode = Omit<FlowCondition, 'id'> & { description: FlowText }
export type FlowNode = {
  title: FlowText
  description: FlowText
  extensions?: Data
}
/** Terminal sink: one input, unlimited fan-in from checkpoint outputs. */
export type FlowEndNode = { extensions?: Data }
export const NOTE_COLORS = { slate: '灰蓝', sand: '暖灰', sage: '灰绿', mauve: '灰紫' } as const
export type FlowCanvasNote = { title: string; text: string; width: number; height: number; color: keyof typeof NOTE_COLORS }
export type CanvasNodeType = 'goal' | 'predicate' | 'note' | 'transition' | 'conditional' | 'diff' | 'merge' | 'swap' | 'end'
export const GOAL_NAMES: Record<FlowCondition['kind'], string> = { manual: '人工标记', counter: '累计事件', signal: '等待信号', nodes: '等待阶段', external: '外部条件' }
export const PREDICATE_NAMES = GOAL_NAMES
export const isOutputPort = (port: FlowPort): port is FlowOutputPort => port === 'output' || port === 'output2' || /^out\d+$/.test(port)
export const isInputPort = (port: FlowPort): port is FlowInputPort => port === 'input' || port === 'input2' || /^in\d+$/.test(port)
export const swapInPort = (index: number): FlowInputPort => `in${index}`
export const swapOutPort = (index: number): FlowOutputPort => `out${index}`
export const parseSwapInIndex = (port: string): number | null => { const m = /^in(\d+)$/.exec(port); return m ? Number(m[1]) : null }
export const parseSwapOutIndex = (port: string): number | null => { const m = /^out(\d+)$/.exec(port); return m ? Number(m[1]) : null }
/** Provisional authoring data. Canvas layout is independent of node content and connections. */
export type ProgressFlow = {
  format: 'hanshu.progress-tree'
  version: 1
  id: string
  entry: FlowEntry
  nodes: Record<string, FlowNode>
  /** Canvas wires among Goal / Predicate / transitions (not checkpoint branches). */
  logic?: { links: FlowLogicLink[] }
  goals?: Record<string, FlowGoalNode>
  predicates?: Record<string, FlowPredicateNode>
  transitions?: Record<string, FlowTransitionNode>
  conditionals?: Record<string, FlowConditionalNode>
  diffs?: Record<string, FlowDiffNode>
  merges?: Record<string, FlowMergeNode>
  swaps?: Record<string, FlowSwapNode>
  ends?: Record<string, FlowEndNode>
  layout?: { positions: Record<string, FlowPosition>; notes?: Record<string, FlowCanvasNote>; groups?: Record<string, { name?: string; nodes: string[] }> }
  extensions?: Data
}
/** `flow` = canvas / multi-select (no dedicated document form). Graph metadata lives on `entry`. */
export type FlowSelection = { kind: 'flow' } | { kind: 'entry' } | { kind: 'entry-link' } | { kind: 'node'; id: string } | { kind: 'goal'; id: string } | { kind: 'predicate'; id: string } | { kind: 'logic-link'; id: string } | { kind: 'note'; id: string } | { kind: 'transition'; id: string } | { kind: 'conditional'; id: string } | { kind: 'diff'; id: string } | { kind: 'merge'; id: string } | { kind: 'swap'; id: string } | { kind: 'end'; id: string }
export type FlowIssue = { severity: 'error' | 'warning'; path: string; message: string }
export const text = (value = ''): FlowText => ({ text: value })
export const displayText = (
  value: FlowText,
  resolve?: ((key: string) => string | null) | null,
) => {
  if (!resolve) return value.text
  const hit = resolve(value.text)
  if (hit !== null) return hit
  // 语义键尚未写入 .lang 时显示空；遗留明文仍原样显示
  return /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i.test(value.text) ? '' : value.text
}
export const clone = <T,>(value: T): T => structuredClone(value)
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = (value: string) => value.trim().length > 0 && value.length <= 200 && !['__proto__', 'prototype', 'constructor'].includes(value)
export const getNode = (flow: ProgressFlow, id: string | null) => id !== null && Object.hasOwn(flow.nodes, id) ? flow.nodes[id] : undefined
export const getGoalNode = (flow: ProgressFlow, id: string) => flow.goals && Object.hasOwn(flow.goals, id) ? flow.goals[id] : undefined
export const getPredicateNode = (flow: ProgressFlow, id: string) => flow.predicates && Object.hasOwn(flow.predicates, id) ? flow.predicates[id] : undefined
export const getTransitionNode = (flow: ProgressFlow, id: string) => flow.transitions && Object.hasOwn(flow.transitions, id) ? flow.transitions[id] : undefined
export const getConditionalNode = (flow: ProgressFlow, id: string) => flow.conditionals && Object.hasOwn(flow.conditionals, id) ? flow.conditionals[id] : undefined
export const getDiffNode = (flow: ProgressFlow, id: string) => flow.diffs && Object.hasOwn(flow.diffs, id) ? flow.diffs[id] : undefined
export const getMergeNode = (flow: ProgressFlow, id: string) => flow.merges && Object.hasOwn(flow.merges, id) ? flow.merges[id] : undefined
export const getSwapNode = (flow: ProgressFlow, id: string) => flow.swaps && Object.hasOwn(flow.swaps, id) ? flow.swaps[id] : undefined
export const getEndNode = (flow: ProgressFlow, id: string) => flow.ends && Object.hasOwn(flow.ends, id) ? flow.ends[id] : undefined
export const hasContentNode = (flow: ProgressFlow, id: string) => !!getNode(flow, id) || !!getGoalNode(flow, id) || !!getPredicateNode(flow, id) || !!getTransitionNode(flow, id) || !!getConditionalNode(flow, id) || !!getDiffNode(flow, id) || !!getMergeNode(flow, id) || !!getSwapNode(flow, id) || !!getEndNode(flow, id)
export const getCanvasNote = (flow: ProgressFlow, id: string) => flow.layout?.notes && Object.hasOwn(flow.layout.notes, id) ? flow.layout.notes[id] : undefined
export const hasCanvasItem = (flow: ProgressFlow, id: string) => hasContentNode(flow, id) || !!getCanvasNote(flow, id)
export const inputPorts = (flow: ProgressFlow, id: string): FlowInputPort[] => {
  if (id === flow.entry.id || getGoalNode(flow, id) || getPredicateNode(flow, id)) return []
  if (getSwapNode(flow, id)) return Array.from({ length: getSwapNode(flow, id)!.entries }, (_, i) => swapInPort(i))
  if (getTransitionNode(flow, id) || getConditionalNode(flow, id) || getDiffNode(flow, id)) return ['input', 'input2']
  return hasContentNode(flow, id) ? ['input'] : []
}
export const outputPorts = (flow: ProgressFlow, id: string): FlowOutputPort[] => {
  if (getEndNode(flow, id)) return []
  if (getSwapNode(flow, id)) return Array.from({ length: getSwapNode(flow, id)!.entries }, (_, i) => swapOutPort(i))
  if (getDiffNode(flow, id)) return ['output', 'output2']
  if (id === flow.entry.id || getGoalNode(flow, id) || getPredicateNode(flow, id) || getTransitionNode(flow, id) || getConditionalNode(flow, id) || getMergeNode(flow, id) || getNode(flow, id)) return ['output']
  return []
}
/** Which output socket a stored link leaves from (差分失败口 / swap 存 fromPort). */
export const linkSourcePort = (_flow: ProgressFlow, _from: string, _to: string, _port: FlowInputPort, fromPort?: FlowOutputPort): FlowOutputPort => {
  if (fromPort) return fromPort
  return 'output'
}
/** Highest used swap entry index from links, or -1 when unused. */
export const usedSwapEntryIndex = (flow: ProgressFlow, id: string) => {
  let max = -1
  for (const link of flow.logic?.links ?? []) {
    if (link.to === id) {
      const i = parseSwapInIndex(link.port)
      if (i !== null) max = Math.max(max, i)
    }
    if (link.from === id) {
      const i = parseSwapOutIndex(link.fromPort ?? '')
      if (i !== null) max = Math.max(max, i)
    }
  }
  return max
}
/** Keep one spare empty slot after the highest used entry; minimum 1. */
export function syncSwapEntries(flow: ProgressFlow, id: string) {
  const swap = getSwapNode(flow, id)
  if (!swap) return
  const used = usedSwapEntryIndex(flow, id)
  swap.entries = used < 0 ? 1 : used + 2
}
/** Socket colors: Goal/Predicate gold, ckpt/Parent/Next blue. */
export const portKind = (flow: ProgressFlow, id: string, port: FlowPort): FlowPortKind => {
  if (getGoalNode(flow, id) || getPredicateNode(flow, id)) return 'goal'
  if (getTransitionNode(flow, id) || getConditionalNode(flow, id) || getDiffNode(flow, id)) return port === 'input' ? 'goal' : 'checkpoint'
  return 'checkpoint'
}
/**
 * Connection rules:
 * - 线性变迁: Goal←goal(多, 合取); Parent←ckpt(1); Next→ckpt(1)
 * - 条件变迁: Predicate←predicate(1); Parent←ckpt(1); Next→ckpt(1)
 * - 差分变迁: Goal←goal(1); Parent←ckpt(1); 成功/失败→ckpt(各1)
 * - 合并变迁: 入←ckpt A(多); Next→ckpt S(1)
 * - 交换变迁: 每条目 inN←ckpt A(1); outN→ckpt S(1); 用尽末槽自动扩容
 * - Entry ≡ Next → ckpt
 * - End ← ckpt output only (multi)
 * - Goal / Predicate: single outgoing wire
 */
export const canConnectNodes = (flow: ProgressFlow, from: string, to: string, port: FlowInputPort, fromPort: FlowPort = 'output') => {
  if (!inputPorts(flow, to).includes(port)) return false
  if (from === flow.entry.id) return fromPort === 'output' && port === 'input' && !!getNode(flow, to)
  if (getEndNode(flow, to)) return port === 'input' && fromPort === 'output' && !!getNode(flow, from)
  if (getEndNode(flow, from)) return false
  if (getSwapNode(flow, to)) {
    const index = parseSwapInIndex(port)
    return index !== null && fromPort === 'output' && !!getNode(flow, from)
  }
  if (getSwapNode(flow, from)) {
    const index = parseSwapOutIndex(fromPort)
    return index !== null && !!getNode(flow, to) && port === 'input'
  }
  if (getMergeNode(flow, to)) {
    return port === 'input' && fromPort === 'output' && !!getNode(flow, from)
  }
  if (getMergeNode(flow, from)) return fromPort === 'output' && !!getNode(flow, to) && port === 'input'
  if (getDiffNode(flow, to)) {
    if (port === 'input') return !!getGoalNode(flow, from) && fromPort === 'output'
    return fromPort === 'output' && !!getNode(flow, from)
  }
  if (getDiffNode(flow, from)) return (fromPort === 'output' || fromPort === 'output2') && !!getNode(flow, to) && port === 'input'
  if (getConditionalNode(flow, to)) {
    if (port === 'input') return !!getPredicateNode(flow, from) && fromPort === 'output'
    return fromPort === 'output' && !!getNode(flow, from)
  }
  if (getConditionalNode(flow, from)) return fromPort === 'output' && !!getNode(flow, to) && port === 'input'
  if (getTransitionNode(flow, to)) {
    if (port === 'input') return !!getGoalNode(flow, from) && fromPort === 'output'
    return fromPort === 'output' && !!getNode(flow, from)
  }
  if (getTransitionNode(flow, from)) return fromPort === 'output' && !!getNode(flow, to) && port === 'input'
  if (getNode(flow, from) && getNode(flow, to)) return false
  // Goal may connect into 线性/差分变迁 Goal 入点
  if (getGoalNode(flow, from)) return fromPort === 'output' && (!!getTransitionNode(flow, to) || !!getDiffNode(flow, to)) && port === 'input'
  // Predicate may connect into 条件变迁 Predicate 入点
  if (getPredicateNode(flow, from)) return fromPort === 'output' && !!getConditionalNode(flow, to) && port === 'input'
  return false
}
const usesLogicLink = (flow: ProgressFlow, from: string, to: string) => !!(getGoalNode(flow, from) || getGoalNode(flow, to) || getPredicateNode(flow, from) || getPredicateNode(flow, to) || getTransitionNode(flow, from) || getTransitionNode(flow, to) || getConditionalNode(flow, from) || getConditionalNode(flow, to) || getDiffNode(flow, from) || getDiffNode(flow, to) || getMergeNode(flow, from) || getMergeNode(flow, to) || getSwapNode(flow, from) || getSwapNode(flow, to) || getEndNode(flow, from) || getEndNode(flow, to))
const freeCanvasId = (f: Record<string, unknown>, entryId: string, id: string, skip?: 'transitions' | 'conditionals' | 'diffs' | 'merges' | 'swaps' | 'ends') => safeId(id) && id !== entryId && !Object.hasOwn(f.nodes as object, id) && !(f.goals && Object.hasOwn(f.goals as object, id)) && !(f.predicates && Object.hasOwn(f.predicates as object, id)) && (skip === 'transitions' || !(f.transitions && Object.hasOwn(f.transitions as object, id))) && (skip === 'conditionals' || !(f.conditionals && Object.hasOwn(f.conditionals as object, id))) && (skip === 'diffs' || !(f.diffs && Object.hasOwn(f.diffs as object, id))) && (skip === 'merges' || !(f.merges && Object.hasOwn(f.merges as object, id))) && (skip === 'swaps' || !(f.swaps && Object.hasOwn(f.swaps as object, id))) && (skip === 'ends' || !(f.ends && Object.hasOwn(f.ends as object, id)))
/** Count edges leaving a node: entry target or logic.links. */
export const outgoingCount = (flow: ProgressFlow, id: string) => {
  if (id === flow.entry.id) return flow.entry.target === null ? 0 : 1
  return flow.logic?.links.filter(link => link.from === id).length ?? 0
}
export const makeNode = (id: string, _title = '新阶段'): FlowNode => ({
  title: text(`nodes.${id}.title`),
  description: text(`nodes.${id}.description`),
})
export function createFlow(id = crypto.randomUUID(), _title = '新的进度流程'): ProgressFlow {
  return {
    format: 'hanshu.progress-tree',
    version: 1,
    id,
    entry: {
      id: 'entry',
      target: null,
      title: text('entry.title'),
      description: text('entry.description'),
    },
    nodes: {},
  }
}

/** Document id is author-owned identity inside the .hflow; changing it does not rewrite graph refs. */
export function setFlowId(flow: ProgressFlow, id: string): ProgressFlow {
  const nextId = id.trim()
  if (!safeId(nextId)) throw new Error('文档 ID 不能为空，长度不超过 200，且不可使用保留名称。')
  if (nextId === flow.id) return flow
  const next = clone(flow)
  next.id = nextId
  return next
}

/** Shape checks protect views; semantic errors remain editable and appear in validation. */
export function parseFlow(source: string): ProgressFlow {
  const v = parseJsonValue(source)
  const require = (ok: unknown, path: string): void => { if (!ok) throw new Error(`${path}：树图文档结构不正确`) }
  const checkExtensions = (v: Record<string, unknown>, path: string) => require(v.extensions === undefined || isObject(v.extensions), `${path}.extensions`)
  const checkText = (v: unknown, path: string) => require(isObject(v) && typeof v.text === 'string' && !Object.hasOwn(v, 'key'), path)
  require(isObject(v), '$')
  const f = v as Record<string, unknown>
  checkExtensions(f, '$')
  if (f.format !== 'hanshu.progress-tree' || f.version !== 1) throw new Error('不支持的树图文档格式或版本；需要 hanshu.progress-tree v1')
  require(typeof f.id === 'string', 'id')
  require(isObject(f.entry) && typeof f.entry.id === 'string' && safeId(f.entry.id) && (f.entry.target === null || typeof f.entry.target === 'string') && (f.entry.port === undefined || f.entry.port === 'input' || f.entry.port === 'input2'), 'entry')
  require(!Object.hasOwn(f, 'root') && !Object.hasOwn(f, 'title') && !Object.hasOwn(f, 'description') && !Object.hasOwn(f, 'kind') && !Object.hasOwn(f, 'hubs') && !Object.hasOwn(f, 'gateways'), '$（不支持旧草稿字段）')
  const entry = f.entry as Record<string, unknown>
  require(!Object.hasOwn(entry, 'kind'), 'entry（不支持旧草稿字段）')
  checkText(entry.title, 'entry.title'); checkText(entry.description, 'entry.description')
  if (f.layout !== undefined) {
    require(isObject(f.layout) && isObject(f.layout.positions), 'layout.positions')
    for (const [id, p] of Object.entries((f.layout as { positions: Record<string, unknown> }).positions)) {
      require(safeId(id) && isObject(p) && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y), `layout.positions.${id}`)
    }
  }
  const groups = (f.layout as ProgressFlow['layout'])?.groups
  if (groups !== undefined) {
    require(isObject(groups), 'layout.groups')
    for (const [id, group] of Object.entries(groups)) require(safeId(id) && isObject(group) && (group.name === undefined || typeof group.name === 'string') && Array.isArray(group.nodes) && group.nodes.every(node => typeof node === 'string'), `layout.groups.${id}`)
  }
  require(isObject(f.nodes), 'nodes')
  require(!Object.hasOwn(f.nodes as object, (f.entry as FlowEntry).id), 'entry.id（不能与 checkpoint 重复）')
  if (f.logic !== undefined) {
    require(isObject(f.logic) && Array.isArray(f.logic.links) && !Object.hasOwn(f.logic, 'nodes'), 'logic')
    for (const link of (f.logic as { links: unknown[] }).links) {
      require(isObject(link) && typeof link.id === 'string' && typeof link.from === 'string' && typeof link.to === 'string'
        && (link.port === 'input' || link.port === 'input2' || (typeof link.port === 'string' && /^in\d+$/.test(link.port)))
        && (link.fromPort === undefined || link.fromPort === 'output' || link.fromPort === 'output2' || (typeof link.fromPort === 'string' && /^out\d+$/.test(link.fromPort))), 'logic.links')
    }
  }
  if (f.goals !== undefined) {
    require(isObject(f.goals), 'goals')
    for (const [id, value] of Object.entries(f.goals as Record<string, unknown>)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !Object.hasOwn(f.nodes as object, id) && isObject(value), `goals.${id}`)
      const goal = value as FlowGoalNode
      require(Object.hasOwn(GOAL_NAMES, goal.kind) && isObject(goal.params) && Array.isArray(goal.nodeRefs) && goal.nodeRefs.every(ref => typeof ref === 'string'), `goals.${id}`)
      checkText(goal.title, `goals.${id}.title`); checkText(goal.description, `goals.${id}.description`)
    }
  }
  if (f.predicates !== undefined) {
    require(isObject(f.predicates), 'predicates')
    for (const [id, value] of Object.entries(f.predicates as Record<string, unknown>)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !Object.hasOwn(f.nodes as object, id) && !(f.goals && Object.hasOwn(f.goals as object, id)) && isObject(value), `predicates.${id}`)
      const predicate = value as FlowPredicateNode
      require(Object.hasOwn(PREDICATE_NAMES, predicate.kind) && isObject(predicate.params) && Array.isArray(predicate.nodeRefs) && predicate.nodeRefs.every(ref => typeof ref === 'string'), `predicates.${id}`)
      checkText(predicate.title, `predicates.${id}.title`); checkText(predicate.description, `predicates.${id}.description`)
    }
  }
  if (f.transitions !== undefined) {
    require(isObject(f.transitions), 'transitions')
    for (const [id, value] of Object.entries(f.transitions as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'transitions') && isObject(value), `transitions.${id}`)
      const transition = value as FlowTransitionNode
      checkText(transition.title, `transitions.${id}.title`); checkText(transition.description, `transitions.${id}.description`)
    }
  }
  if (f.conditionals !== undefined) {
    require(isObject(f.conditionals), 'conditionals')
    for (const [id, value] of Object.entries(f.conditionals as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'conditionals') && isObject(value), `conditionals.${id}`)
      const conditional = value as FlowConditionalNode
      checkText(conditional.title, `conditionals.${id}.title`); checkText(conditional.description, `conditionals.${id}.description`)
    }
  }
  if (f.diffs !== undefined) {
    require(isObject(f.diffs), 'diffs')
    for (const [id, value] of Object.entries(f.diffs as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'diffs') && isObject(value), `diffs.${id}`)
      const diff = value as FlowDiffNode
      checkText(diff.title, `diffs.${id}.title`); checkText(diff.description, `diffs.${id}.description`)
    }
  }
  if (f.merges !== undefined) {
    require(isObject(f.merges), 'merges')
    for (const [id, value] of Object.entries(f.merges as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'merges') && isObject(value), `merges.${id}`)
      const merge = value as FlowMergeNode
      checkText(merge.title, `merges.${id}.title`); checkText(merge.description, `merges.${id}.description`)
    }
  }
  if (f.swaps !== undefined) {
    require(isObject(f.swaps), 'swaps')
    for (const [id, value] of Object.entries(f.swaps as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'swaps') && isObject(value), `swaps.${id}`)
      const swap = value as FlowSwapNode
      require(typeof swap.entries === 'number' && Number.isInteger(swap.entries) && swap.entries >= 1, `swaps.${id}.entries`)
      checkText(swap.title, `swaps.${id}.title`); checkText(swap.description, `swaps.${id}.description`)
    }
  }
  if (f.ends !== undefined) {
    require(isObject(f.ends), 'ends')
    for (const [id, value] of Object.entries(f.ends as Record<string, unknown>)) {
      require(freeCanvasId(f, (f.entry as FlowEntry).id, id, 'ends') && isObject(value), `ends.${id}`)
      checkExtensions(value as Record<string, unknown>, `ends.${id}`)
    }
  }
  const notes = (f.layout as ProgressFlow['layout'])?.notes
  if (notes !== undefined) {
    require(isObject(notes), 'layout.notes')
    for (const [id, note] of Object.entries(notes)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !hasContentNode(v as ProgressFlow, id) && isObject(note), `layout.notes.${id}`)
      require(typeof note.title === 'string' && typeof note.text === 'string' && Object.hasOwn(NOTE_COLORS, note.color), `layout.notes.${id}`)
      require(Number.isFinite(note.width) && note.width >= 160 && Number.isFinite(note.height) && note.height >= 96, `layout.notes.${id}.size`)
    }
  }
  for (const [id, n] of Object.entries(f.nodes as Record<string, unknown>)) {
    require(safeId(id) && isObject(n), `nodes.${id}`)
    const node = n as Record<string, unknown>
    checkExtensions(node, id)
    checkText(node.title, `${id}.title`); checkText(node.description, `${id}.description`)
    require(!Object.hasOwn(node, 'completion') && !Object.hasOwn(node, 'branching') && !Object.hasOwn(node, 'children') && !Object.hasOwn(node, 'onEnter') && !Object.hasOwn(node, 'onFinish') && !Object.hasOwn(node, 'rewards'), `${id}（不支持旧草稿字段）`)
  }
  return v as ProgressFlow
}

export function validateFlow(flow: ProgressFlow): FlowIssue[] {
  const issues: FlowIssue[] = []
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message })
  const warning = (path: string, message: string) => issues.push({ severity: 'warning', path, message })
  if (!safeId(flow.id)) error('id', '请填写稳定的文档 ID。')
  if (!displayText(flow.entry.title).trim()) warning('entry.title', '还没有为流程命名。')
  if (flow.entry.target !== null && !canConnectNodes(flow, flow.entry.id, flow.entry.target, flow.entry.port ?? 'input')) error('entry.target', '起点连接的节点不存在或没有输入端口。')
  const ids = new Set<string>()
  const grouped = new Set<string>()
  for (const [id, group] of Object.entries(flow.layout?.groups ?? {})) {
    for (const node of group.nodes) {
      if (node !== flow.entry.id && !hasCanvasItem(flow, node)) error(`layout.groups.${id}`, 'Group 中的节点不存在。')
      if (grouped.has(node)) error(`layout.groups.${id}`, '同一节点不能重复分组。')
      grouped.add(node)
    }
  }
  for (const id of Object.keys(flow.ends ?? {})) {
    if ((flow.logic?.links ?? []).some(link => link.from === id)) error(id, '结束节点不能有出线。')
  }
  for (const link of flow.logic?.links ?? []) {
    if (!safeId(link.id) || ids.has(link.id)) error(`logic.links.${link.id}`, '连接 ID 必须有效且在文档内唯一。')
    ids.add(link.id)
    if (link.from === flow.entry.id) error(`logic.links.${link.id}`, '起点出口只能有一条连接，请使用入口目标。')
    if (!hasContentNode(flow, link.from) || !hasContentNode(flow, link.to)) error(`logic.links.${link.id}`, '连接端点不存在。')
    else if (!canConnectNodes(flow, link.from, link.to, link.port, linkSourcePort(flow, link.from, link.to, link.port, link.fromPort)) || !usesLogicLink(flow, link.from, link.to)) error(`logic.links.${link.id}`, '连接的端口不正确。')
  }
  for (const id of Object.keys(flow.transitions ?? {})) {
    const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
    const parents = incoming.filter(link => link.port === 'input2')
    const nexts = (flow.logic?.links ?? []).filter(link => link.from === id)
    if (parents.length > 1) error(`transitions.${id}`, 'Parent 端口只能连接一条线。')
    if (nexts.length > 1) error(`transitions.${id}`, 'Next 端口只能连接一条线。')
  }
  for (const id of Object.keys(flow.conditionals ?? {})) {
    const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
    const predicates = incoming.filter(link => link.port === 'input')
    const parents = incoming.filter(link => link.port === 'input2')
    const nexts = (flow.logic?.links ?? []).filter(link => link.from === id)
    if (predicates.length > 1) error(`conditionals.${id}`, '条件变迁 Predicate 端口只能连接一条线。')
    if (parents.length > 1) error(`conditionals.${id}`, '条件变迁 Parent 端口只能连接一条线。')
    if (nexts.length > 1) error(`conditionals.${id}`, '条件变迁 Next 端口只能连接一条线。')
  }
  for (const id of Object.keys(flow.diffs ?? {})) {
    const incoming = (flow.logic?.links ?? []).filter(link => link.to === id)
    const goals = incoming.filter(link => link.port === 'input')
    const parents = incoming.filter(link => link.port === 'input2')
    const success = (flow.logic?.links ?? []).filter(link => link.from === id && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === 'output')
    const fail = (flow.logic?.links ?? []).filter(link => link.from === id && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === 'output2')
    if (goals.length > 1) error(`diffs.${id}`, '差分变迁 Goal 端口只能连接一条线。')
    if (parents.length > 1) error(`diffs.${id}`, '差分变迁 Parent 端口只能连接一条线。')
    if (success.length > 1) error(`diffs.${id}`, '差分变迁成功出点只能连接一条线。')
    if (fail.length > 1) error(`diffs.${id}`, '差分变迁失败出点只能连接一条线。')
  }
  for (const id of Object.keys(flow.merges ?? {})) {
    if ((flow.logic?.links ?? []).filter(link => link.from === id).length > 1) error(`merges.${id}`, '合并变迁 Next 只能连接一条线。')
  }
  for (const id of Object.keys(flow.swaps ?? {})) {
    const swap = flow.swaps![id]
    if (!Number.isInteger(swap.entries) || swap.entries < 1) error(`swaps.${id}`, '交换变迁条目数至少为 1。')
    const ins = new Map<string, number>(), outs = new Map<string, number>()
    for (const link of flow.logic?.links ?? []) {
      if (link.to === id) {
        const index = parseSwapInIndex(link.port)
        if (index === null || index >= swap.entries) error(`logic.links.${link.id}`, '交换变迁入点索引无效。')
        else ins.set(link.port, (ins.get(link.port) ?? 0) + 1)
      }
      if (link.from === id) {
        const source = link.fromPort ?? 'output'
        const index = parseSwapOutIndex(source)
        if (index === null || index >= swap.entries) error(`logic.links.${link.id}`, '交换变迁出点索引无效。')
        else outs.set(source, (outs.get(source) ?? 0) + 1)
      }
    }
    for (const [port, count] of ins) if (count > 1) error(`swaps.${id}`, `交换变迁 ${port} 只能连接一条线。`)
    for (const [port, count] of outs) if (count > 1) error(`swaps.${id}`, `交换变迁 ${port} 只能连接一条线。`)
  }
  for (const id of Object.keys(flow.goals ?? {})) {
    if ((flow.logic?.links ?? []).filter(link => link.from === id).length > 1) error(`goals.${id}`, 'Goal 出口只能连接一条线。')
  }
  for (const id of Object.keys(flow.predicates ?? {})) {
    if ((flow.logic?.links ?? []).filter(link => link.from === id).length > 1) error(`predicates.${id}`, 'Predicate 出口只能连接一条线。')
  }
  for (const [id, goal] of Object.entries(flow.goals ?? {})) {
    for (const ref of goal.nodeRefs) if (!getNode(flow, ref)) error(`goals.${id}`, `引用的阶段「${ref}」不存在。`)
  }
  for (const [id, predicate] of Object.entries(flow.predicates ?? {})) {
    for (const ref of predicate.nodeRefs) if (!getNode(flow, ref)) error(`predicates.${id}`, `引用的阶段「${ref}」不存在。`)
  }
  const cycle = findCanvasCycle(flow)
  if (cycle) warning('graph', `画布连线存在环：${cycle.join(' → ')}。`)
  return issues
}

/** Directed canvas wires only: entry 出口 + logic.links（不含信号回灌）。 */
export function canvasWireEdges(flow: ProgressFlow): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = []
  if (flow.entry.target !== null) edges.push({ from: flow.entry.id, to: flow.entry.target })
  for (const link of flow.logic?.links ?? []) edges.push({ from: link.from, to: link.to })
  return edges
}

/** Returns one directed cycle as node ids (closed, first === last), or null when the canvas wires form a DAG. */
export function findCanvasCycle(flow: ProgressFlow): string[] | null {
  const adj = new Map<string, string[]>()
  for (const { from, to } of canvasWireEdges(flow)) {
    if (!adj.has(from)) adj.set(from, [])
    adj.get(from)!.push(to)
    if (!adj.has(to)) adj.set(to, [])
  }
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()
  for (const id of adj.keys()) color.set(id, WHITE)

  let cycle: string[] | null = null
  const dfs = (u: string): boolean => {
    color.set(u, GRAY)
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        const path: string[] = []
        let cur: string | null = u
        while (cur !== null) {
          path.push(cur)
          if (cur === v) break
          cur = parent.get(cur) ?? null
        }
        path.reverse()
        path.push(v)
        cycle = path
        return true
      }
      if (color.get(v) === WHITE) {
        parent.set(v, u)
        if (dfs(v)) return true
      }
    }
    color.set(u, BLACK)
    return false
  }
  for (const id of adj.keys()) {
    if (color.get(id) !== WHITE) continue
    parent.set(id, null)
    if (dfs(id)) break
  }
  return cycle
}

export function addNode(flow: ProgressFlow, parent: string): {
  flow: ProgressFlow
  id: string
  localeSeeds: Record<string, string>
} {
  if (parent !== flow.entry.id) throw new Error('Checkpoint 之间不能直连，请经线性变迁连接。')
  if (flow.entry.target !== null) throw new Error('请选择没有连接的起点。')
  const next = clone(flow), ids = new Set(flow.logic?.links.map(link => link.id) ?? [])
  let n = 1
  while (hasCanvasItem(flow, `node_${n}`) || flow.entry.id === `node_${n}` || ids.has(`branch_${n}`) || flow.logic?.links.some(link => link.id === `branch_${n}`)) n++
  const id = `node_${n}`
  next.nodes[id] = makeNode(id, `阶段 ${n}`)
  next.entry.target = id
  delete next.entry.port
  return {
    flow: next,
    id,
    localeSeeds: {
      [`nodes.${id}.title`]: `阶段 ${n}`,
      [`nodes.${id}.description`]: '',
    },
  }
}
export function renameNode(flow: ProgressFlow, id: string, name: string): ProgressFlow {
  if (id === name) return flow
  if (!safeId(name) || name === flow.entry.id || hasCanvasItem(flow, name) || !getNode(flow, id)) throw new Error('节点 ID 不能为空、重复或使用保留名称。')
  const next = clone(flow)
  next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([key, node]) => {
    if (key !== id) return [key, node]
    return [name, {
      ...node,
      title: text(`nodes.${name}.title`),
      description: text(`nodes.${name}.description`),
    }]
  }))
  if (next.entry.target === id) next.entry.target = name
  if (next.layout && Object.hasOwn(next.layout.positions, id)) {
    next.layout.positions = Object.fromEntries(Object.entries(next.layout.positions).map(([key, position]) => [key === id ? name : key, position]))
  }
  for (const link of next.logic?.links ?? []) { if (link.from === id) link.from = name; if (link.to === id) link.to = name }
  for (const goal of Object.values(next.goals ?? {})) goal.nodeRefs = goal.nodeRefs.map(ref => ref === id ? name : ref)
  for (const predicate of Object.values(next.predicates ?? {})) predicate.nodeRefs = predicate.nodeRefs.map(ref => ref === id ? name : ref)
  for (const group of Object.values(next.layout?.groups ?? {})) group.nodes = group.nodes.map(ref => ref === id ? name : ref)
  return next
}
export function removeNode(flow: ProgressFlow, id: string): ProgressFlow {
  if (id === flow.entry.id) return flow
  if (!hasContentNode(flow, id)) return flow
  const next = clone(flow)
  delete next.nodes[id]
  if (next.goals) delete next.goals[id]
  if (next.predicates) delete next.predicates[id]
  if (next.transitions) delete next.transitions[id]
  if (next.conditionals) delete next.conditionals[id]
  if (next.diffs) delete next.diffs[id]
  if (next.merges) delete next.merges[id]
  if (next.swaps) delete next.swaps[id]
  if (next.ends) delete next.ends[id]
  if (next.logic) next.logic.links = next.logic.links.filter(link => link.from !== id && link.to !== id)
  if (next.entry.target === id) { next.entry.target = null; delete next.entry.port }
  if (next.layout) delete next.layout.positions[id]
  if (next.layout?.groups) next.layout.groups = Object.fromEntries(Object.entries(next.layout.groups).map(([key, group]) => [key, { ...group, nodes: group.nodes.filter(ref => ref !== id) }] as const).filter(([, group]) => group.nodes.length >= 2))
  for (const goal of Object.values(next.goals ?? {})) goal.nodeRefs = goal.nodeRefs.filter(ref => ref !== id)
  for (const predicate of Object.values(next.predicates ?? {})) predicate.nodeRefs = predicate.nodeRefs.filter(ref => ref !== id)
  return next
}
export function connectEntry(flow: ProgressFlow, target: string | null, port: FlowInputPort = 'input'): ProgressFlow {
  if (target !== null && !canConnectNodes(flow, flow.entry.id, target, port)) throw new Error('请选择已有节点的输入端口。')
  if (target === flow.entry.target && (target === null || (flow.entry.port ?? 'input') === port)) return flow
  const next = clone(flow); next.entry.target = target
  delete next.entry.port
  return next
}
/** Logic / transition / goal / swap links record endpoints; checkpoint→checkpoint is rejected (use 线性变迁). */
export function connectNodes(flow: ProgressFlow, from: string, to: string, port: FlowInputPort = 'input', fromPort: FlowPort = 'output'): { flow: ProgressFlow; selection: FlowSelection } {
  if (!hasContentNode(flow, to)) throw new Error('连接目标必须是已有节点。')
  if (!canConnectNodes(flow, from, to, port, fromPort)) throw new Error(getNode(flow, from) && getNode(flow, to) ? 'Checkpoint 之间不能直连，请经线性变迁连接。' : '请选择可连接的输入、输出端口。')
  if (from === flow.entry.id) return { flow: connectEntry(flow, to, port), selection: { kind: 'entry-link' } }
  if (usesLogicLink(flow, from, to)) {
    const existing = flow.logic?.links.find(link => link.from === from && link.to === to && link.port === port && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === fromPort)
    if (existing) return { flow, selection: { kind: 'logic-link', id: existing.id } }
    const next = clone(flow), ids = new Set(flow.logic?.links.map(link => link.id) ?? [])
    let n = 1; while (ids.has(`link_${n}`)) n++
    next.logic ??= { links: [] }
    // 线性变迁 Parent / Next 单线；Goal 口允许多线合取。
    if (getTransitionNode(flow, to) && port === 'input2') next.logic.links = next.logic.links.filter(link => !(link.to === to && link.port === port))
    if (getTransitionNode(flow, from)) next.logic.links = next.logic.links.filter(link => link.from !== from)
    // 条件变迁 Predicate / Parent / Next 均为单线。
    if (getConditionalNode(flow, to) && (port === 'input' || port === 'input2')) next.logic.links = next.logic.links.filter(link => !(link.to === to && link.port === port))
    if (getConditionalNode(flow, from)) next.logic.links = next.logic.links.filter(link => link.from !== from)
    // 差分变迁 Goal / Parent / 成功 / 失败 均为单线。
    if (getDiffNode(flow, to) && (port === 'input' || port === 'input2')) next.logic.links = next.logic.links.filter(link => !(link.to === to && link.port === port))
    if (getDiffNode(flow, from)) next.logic.links = next.logic.links.filter(link => !(link.from === from && linkSourcePort(flow, link.from, link.to, link.port, link.fromPort) === fromPort))
    if (getMergeNode(flow, from)) next.logic.links = next.logic.links.filter(link => link.from !== from)
    if (getGoalNode(flow, from)) next.logic.links = next.logic.links.filter(link => link.from !== from)
    if (getPredicateNode(flow, from)) next.logic.links = next.logic.links.filter(link => link.from !== from)
    if (getSwapNode(flow, to) && parseSwapInIndex(port) !== null) next.logic.links = next.logic.links.filter(link => !(link.to === to && link.port === port))
    if (getSwapNode(flow, from) && parseSwapOutIndex(fromPort) !== null) next.logic.links = next.logic.links.filter(link => !(link.from === from && (link.fromPort ?? '') === fromPort))
    const record: FlowLogicLink = { id: `link_${n}`, from, to, port }
    if (getSwapNode(flow, from) || getDiffNode(flow, from)) record.fromPort = fromPort as FlowOutputPort
    next.logic.links.push(record)
    if (getSwapNode(next, from)) syncSwapEntries(next, from)
    if (getSwapNode(next, to)) syncSwapEntries(next, to)
    return { flow: next, selection: { kind: 'logic-link', id: `link_${n}` } }
  }
  throw new Error('Checkpoint 之间不能直连，请经线性变迁连接。')
}
export function disconnectLink(flow: ProgressFlow, selection: FlowSelection): ProgressFlow {
  if (selection.kind === 'entry-link') return connectEntry(flow, null)
  if (selection.kind !== 'logic-link') return flow
  const link = flow.logic?.links.find(item => item.id === selection.id)
  if (!link) return flow
  const next = clone(flow); next.logic!.links = next.logic!.links.filter(item => item.id !== selection.id)
  if (getSwapNode(next, link.from)) syncSwapEntries(next, link.from)
  if (getSwapNode(next, link.to)) syncSwapEntries(next, link.to)
  return next
}
