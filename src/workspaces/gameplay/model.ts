import { randomId } from '../../project/crypto'
import { parseJsonValue } from '../../utils/strictJson'
import { parseCompletionGraph, type CompletionGraph } from './completionGraph'
import { parseConditionRules, type ProgressConditionRule } from './conditions'
import { matchInjectLine } from '../../hanshu/hsSyntaxRules'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Data = { [key: string]: Json }
/** Localizable player-facing text; author-only progress identifiers are strings. */
export type FlowText = { text: string }
export type FlowPosition = { x: number; y: number }
export type FlowInputPort = 'input' | 'input2'
export type FlowOutputPort = 'output' | 'output2'
export type FlowPort = FlowInputPort | FlowOutputPort
/** fromPort distinguishes progress/objective outputs (成功 / 失败); otherwise inferred as `output`. */
export type FlowLogicLink = { id: string; from: string; to: string; port: FlowInputPort; fromPort?: FlowOutputPort; order?: number; reverseOrder?: number }
/** Wire order is executable data; coordinates only author it. UTF-16 comparison is locale independent. */
export const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const FLOW_LIMITS = { nodes: 512, links: 4096, fanout: 128, deliveries: 250000 } as const
export function normalizeLinkOrder(flow: ProgressFlow, reposition = false): ProgressFlow {
  if (!flow.logic?.links.length) return flow
  const links = flow.logic.links.map(link => ({ ...link }))
  for (const reverse of [false, true]) {
    const groups = new Map<string, FlowLogicLink[]>()
    for (const link of links) {
      const key = reverse ? `${link.to}\0${link.port}` : `${link.from}\0${linkSourcePort(flow, link.from, link.fromPort)}`
      const group = groups.get(key) ?? []; group.push(link); groups.set(key, group)
    }
    const field = reverse ? 'reverseOrder' : 'order'
    for (const group of groups.values()) {
      if (!reposition && group.every(link => Number.isSafeInteger(link[field]) && link[field]! >= 0)) continue
      const point = (link: FlowLogicLink) => flow.layout?.positions[reverse ? link.from : link.to] ?? { x: 0, y: 0 }
      group.sort((a, b) => point(a).y - point(b).y || point(a).x - point(b).x || compareIds(a.id, b.id))
      group.forEach((link, index) => { link[field] = index })
    }
  }
  return { ...flow, logic: { ...flow.logic, links } }
}
export function orderedLinks(flow: ProgressFlow, reverse = false): FlowLogicLink[] {
  const field = reverse ? 'reverseOrder' : 'order'
  return [...(normalizeLinkOrder(flow).logic?.links ?? [])].sort((a, b) => (a[field]! - b[field]!) || compareIds(a.id, b.id))
}

/** 进度节点内的 goal 元素。 */
export type FlowProgressGoal = {
  id: string
  /** Goal 类型 id（goalDefinitions 的 kind）；空串表示尚未选择。 */
  kind: string
  params: Data
}
/**
 * 进度节点：持有阶段运行状态（未激活 / 运行中 / 已成功 / 已失败 / 已取消）。
 * 开始进度节点是其中特例：没有左端口，任务开始时直接进入运行中，且承载任务元信息。
 */
export type FlowProgressNode = {
  /** Author-facing identifier, unique within this quest; never localized. */
  identifier: string
  /** 进行时日志：该阶段运行中显示给玩家的任务日志 */
  runningLog: FlowText
  /** 完成时日志：该阶段结算时显示的任务日志 */
  completedLog: FlowText
  goals: FlowProgressGoal[]
  completion: 'all' | 'any' | 'custom'
  completionGraph?: CompletionGraph
  /** One submission entry for the whole progress, never per embedded goal. */
  submission?: FlowSubmission
  /** 仅开始进度节点：任务标题 */
  questTitle?: FlowText
  /** 仅开始进度节点：任务说明 */
  description?: FlowText
  extensions?: Data
}
/** 条件节点：无左端口，条件全部成立时发 A；对 Q 回报真 / N。空条件恒假。 */
export type FlowPredicateNode = {
  identifier?: string
  conditions: ProgressConditionRule[]
  extensions?: Data
}
/** Node-level entry. Neither the type nor its parameter is localized. */
export type FlowSubmission = { submit_type: 'ui'; param: null } | { submit_type: 'dialogue_injection'; param: string }
export function parseFlowSubmission(value: unknown, path = 'submission'): FlowSubmission {
  if (!isObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'submit_type') || !Object.hasOwn(value, 'param')
    || !(value.submit_type === 'ui' && value.param === null || value.submit_type === 'dialogue_injection' && typeof value.param === 'string')) {
    throw new Error(`${path}：提交只支持 submit_type 与 param；ui 的 param 为 null，dialogue_injection 的 param 为注入点名文本。`)
  }
  return value as FlowSubmission
}
export function flowSubmissionIssue(submission: FlowSubmission): string | null {
  try { parseFlowSubmission(submission) } catch (error) { return error instanceof Error ? error.message : String(error) }
  if (submission.submit_type === 'dialogue_injection' && (!submission.param.trim() || submission.param !== submission.param.trim() || !matchInjectLine(`@${submission.param}`))) return '请填写有效的对话注入点名（不带 @，不含空白）。'
  return null
}
/** Quest 级后台目标：随任务启动，不维持存活；C 关闭整个节点。 */
export type FlowObjectiveNode = { identifier: string; goal: Omit<FlowProgressGoal, 'id'>; submission?: FlowSubmission; extensions?: Data }
/** 逻辑节点：左端口 并且 / 或者 收 A，右端口发 A；无内容。 */
export type FlowTransitionNode = { extensions?: Data }
/** 结束节点：成功入 / 失败入，决定任务终局；携带结局标题与奖励礼包。 */
export type FlowEndNode = {
  title: FlowText
  rewardKits: string[]
  extensions?: Data
}
export const NOTE_COLORS = { slate: '灰蓝', sand: '暖灰', sage: '灰绿', mauve: '灰紫' } as const
export type FlowCanvasNote = { title: string; text: string; width: number; height: number; color: keyof typeof NOTE_COLORS }
export type CanvasNodeType = 'progress' | 'predicate' | 'objective' | 'transition' | 'end' | 'note'

export const isOutputPort = (port: FlowPort): port is FlowOutputPort => port === 'output' || port === 'output2'
export const isInputPort = (port: FlowPort): port is FlowInputPort => port === 'input' || port === 'input2'

/** Provisional authoring data. Canvas layout is independent of node content and connections. */
export type ProgressFlow = {
  format: 'hanshu.progress-tree'
  version: 1
  id: string
  /** 开始进度节点 ID（唯一）；任务开始时它直接进入运行中。 */
  start: string
  progress: Record<string, FlowProgressNode>
  predicates?: Record<string, FlowPredicateNode>
  objectives?: Record<string, FlowObjectiveNode>
  transitions?: Record<string, FlowTransitionNode>
  ends?: Record<string, FlowEndNode>
  logic?: { links: FlowLogicLink[] }
  layout?: { positions: Record<string, FlowPosition>; notes?: Record<string, FlowCanvasNote>; groups?: Record<string, { name?: string; nodes: string[] }> }
  extensions?: Data
}
/** `flow` = 整个任务（画布 / 多选）；其余为单个节点。 */
export type FlowSelection =
  | { kind: 'flow' }
  | { kind: 'progress'; id: string }
  | { kind: 'predicate'; id: string }
  | { kind: 'objective'; id: string }
  | { kind: 'transition'; id: string }
  | { kind: 'end'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'logic-link'; id: string }
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
export const getProgressNode = (flow: ProgressFlow, id: string) => flow.progress && Object.hasOwn(flow.progress, id) ? flow.progress[id] : undefined
export const getPredicateNode = (flow: ProgressFlow, id: string) => flow.predicates && Object.hasOwn(flow.predicates, id) ? flow.predicates[id] : undefined
export const getObjectiveNode = (flow: ProgressFlow, id: string) => flow.objectives && Object.hasOwn(flow.objectives, id) ? flow.objectives[id] : undefined
export const getTransitionNode = (flow: ProgressFlow, id: string) => flow.transitions && Object.hasOwn(flow.transitions, id) ? flow.transitions[id] : undefined
export const getEndNode = (flow: ProgressFlow, id: string) => flow.ends && Object.hasOwn(flow.ends, id) ? flow.ends[id] : undefined
export const hasContentNode = (flow: ProgressFlow, id: string) => !!getProgressNode(flow, id) || !!getPredicateNode(flow, id) || !!getObjectiveNode(flow, id) || !!getTransitionNode(flow, id) || !!getEndNode(flow, id)
export const isStartNode = (flow: ProgressFlow, id: string) => flow.start === id
export const getCanvasNote = (flow: ProgressFlow, id: string) => flow.layout?.notes && Object.hasOwn(flow.layout.notes, id) ? flow.layout.notes[id] : undefined
export const hasCanvasItem = (flow: ProgressFlow, id: string) => hasContentNode(flow, id) || !!getCanvasNote(flow, id)

/** 左端口：开始进度节点没有；普通进度一个；逻辑两个（并且 / 或者）；结束两个（成功入 / 失败入）。 */
export const inputPorts = (flow: ProgressFlow, id: string): FlowInputPort[] => {
  if (getProgressNode(flow, id)) return isStartNode(flow, id) ? [] : ['input']
  if (getTransitionNode(flow, id) || getEndNode(flow, id)) return ['input', 'input2']
  return []
}
/** 右端口：进度、目标两个（成功 / 失败）；条件、逻辑各一个；结束没有。 */
export const outputPorts = (flow: ProgressFlow, id: string): FlowOutputPort[] => {
  if (getProgressNode(flow, id) || getObjectiveNode(flow, id)) return ['output', 'output2']
  if (getPredicateNode(flow, id) || getTransitionNode(flow, id)) return ['output']
  return []
}
/** Which output socket a stored link leaves from. Progress/objectives store 成功 / 失败. */
export const linkSourcePort = (flow: ProgressFlow, from: string, fromPort?: FlowOutputPort): FlowOutputPort => fromPort && (getProgressNode(flow, from) || getObjectiveNode(flow, from)) ? fromPort : 'output'

/**
 * 与开始进度节点**联通**的节点集合（把连线视为无向边）。
 * 条件只有出边，若按有向可达会永远判成草稿，所以这里必须忽略方向。
 */
export function connectedToStart(flow: ProgressFlow): Set<string> {
  const adjacency = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, [])
    if (!adjacency.has(b)) adjacency.set(b, [])
    adjacency.get(a)!.push(b)
    adjacency.get(b)!.push(a)
  }
  for (const edge of flow.logic?.links ?? []) link(edge.from, edge.to)
  const seen = new Set<string>([flow.start])
  const queue = [flow.start]
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** `to` 是否可以从 `from` 顺向到达（用于拒绝成环）。 */
function reachable(flow: ProgressFlow, from: string, target: string): boolean {
  const seen = new Set<string>([from])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    for (const link of flow.logic?.links ?? []) {
      if (link.from !== queue[i]) continue
      if (link.to === target) return true
      if (seen.has(link.to)) continue
      seen.add(link.to)
      queue.push(link.to)
    }
  }
  return false
}

/** 唯一连接约束：右端口 → 左端口，且不得成环（含自环）。 */
export const canConnectNodes = (flow: ProgressFlow, from: string, to: string, port: FlowInputPort, fromPort: FlowPort = 'output') => {
  if (!hasContentNode(flow, from) || !hasContentNode(flow, to)) return false
  if (!outputPorts(flow, from).includes(fromPort as FlowOutputPort)) return false
  if (!inputPorts(flow, to).includes(port)) return false
  if (from === to) return false
  return !reachable(flow, to, from)
}

export function createFlow(id = randomId(), questTitle = '新的进度流程'): ProgressFlow {
  const start = 'progress_start'
  return {
    format: 'hanshu.progress-tree',
    version: 1,
    id,
    start,
    progress: {
      [start]: {
        identifier: 'start',
        questTitle: text(questTitle),
        description: text('description'),
        runningLog: text(`progress.${start}.runningLog`),
        completedLog: text(`progress.${start}.completedLog`),
        goals: [],
        completion: 'all',
      },
    },
  }
}

/** Document id is author-owned identity inside the .quest; changing it does not rewrite graph refs. */
export function setFlowId(flow: ProgressFlow, id: string): ProgressFlow {
  const nextId = id.trim()
  if (!safeId(nextId)) throw new Error('文档 ID 不能为空，长度不超过 200，且不可使用保留名称。')
  if (nextId === flow.id) return flow
  const next = clone(flow)
  next.id = nextId
  return next
}

const LEGACY_KEYS = ['name', 'description', 'nodes', 'goals', 'conditionals', 'diffs', 'merges', 'swaps', 'entry', 'root', 'title', 'kind', 'hubs', 'gateways'] as const

export function nextProgressIdentifier(flow: ProgressFlow): string {
  return nextNodeIdentifier(flow, 'progress')
}
export function nextObjectiveIdentifier(flow: ProgressFlow): string {
  return nextNodeIdentifier(flow, 'objective')
}
function nextNodeIdentifier(flow: ProgressFlow, prefix: string): string {
  const used = new Set([...Object.values(flow.progress), ...Object.values(flow.predicates ?? {}), ...Object.values(flow.objectives ?? {})].map(node => node.identifier))
  let index = 1
  while (used.has(`${prefix}_${index}`)) index++
  return `${prefix}_${index}`
}

export function progressIdentifierIssue(flow: ProgressFlow, id: string, value: string): string | null {
  if (!value.trim()) return '进度标识符不能为空。'
  return nodeIdentifierIssue(flow, id, value)
}
export function nodeIdentifierIssue(flow: ProgressFlow, id: string, value: string): string | null {
  if (!value) return null
  if (value !== value.trim() || /[\r\n\t]/.test(value) || value.length > 200) return '标识符不能含首尾空白或换行，且长度不超过 200。'
  if ([...Object.entries(flow.progress), ...Object.entries(flow.predicates ?? {}), ...Object.entries(flow.objectives ?? {})].some(([otherId, node]) => otherId !== id && node.identifier === value)) return '非空标识符在当前 Quest 内必须唯一。'
  return null
}
export function objectiveIdentifierIssue(flow: ProgressFlow, id: string, value: string): string | null {
  if (!value.trim()) return '目标标识符不能为空。'
  return nodeIdentifierIssue(flow, id, value)
}

/** All authoring and debugger labels share the same nonlocalized progress name. */
export function flowNodeLabel(flow: ProgressFlow, id: string, resolveText?: (key: string) => string | null): string {
  const progress = getProgressNode(flow, id)
  if (progress) return progress.identifier || '未填写进度标识符'
  const predicate = getPredicateNode(flow, id)
  if (predicate) return predicate.identifier || `条件 · ${predicate.conditions.length} 个条件`
  const objective = getObjectiveNode(flow, id)
  if (objective) return objective.identifier || '未填写目标标识符'
  const end = getEndNode(flow, id)
  if (end) return displayText(end.title, resolveText) || '未命名结局'
  return getTransitionNode(flow, id) ? '逻辑' : id
}

/** Shape checks protect views; semantic errors remain editable and appear in validation. */
export function parseFlow(source: string): ProgressFlow {
  const v = parseJsonValue(source)
  const require = (ok: unknown, path: string): void => { if (!ok) throw new Error(`${path}：树图文档结构不正确`) }
  const checkExtensions = (v: Record<string, unknown>, path: string) => require(v.extensions === undefined || isObject(v.extensions), `${path}.extensions`)
  const checkText = (v: unknown, path: string) => require(isObject(v) && typeof v.text === 'string' && !Object.hasOwn(v, 'key'), path)
  const checkKits = (v: unknown, path: string) => require(Array.isArray(v) && v.every(item => typeof item === 'string' && item.trim()) && new Set(v).size === v.length, path)
  require(isObject(v), '$')
  const f = v as Record<string, unknown>
  checkExtensions(f, '$')
  if (f.format !== 'hanshu.progress-tree' || f.version !== 1) throw new Error('不支持的树图文档格式或版本；需要 hanshu.progress-tree v1')
  for (const key of LEGACY_KEYS) require(!Object.hasOwn(f, key), `$（不支持旧草稿字段：${key}）`)
  require(typeof f.id === 'string' && safeId(f.id), 'id')
  require(typeof f.start === 'string' && safeId(f.start), 'start')

  const progressFamily = f.progress as Record<string, unknown>
  require(isObject(progressFamily), 'progress')
  require(Object.hasOwn(progressFamily, f.start as string), 'start（开始进度节点不存在）')
  const usedIdentifiers = new Set([progressFamily, f.predicates, f.objectives].filter(isObject).flatMap(family => Object.values(family)).filter(isObject).map(node => node.identifier).filter(value => typeof value === 'string'))
  for (const [id, value] of Object.entries(progressFamily)) {
    require(safeId(id), `progress.${id}`)
    require(isObject(value), `progress.${id}`)
    const node = value as FlowProgressNode
    const raw = value as Record<string, unknown>
    const start = id === f.start
    checkExtensions(raw, `progress.${id}`)
    if (raw.submission !== undefined) parseFlowSubmission(raw.submission, `progress.${id}.submission`)
    if (!Object.hasOwn(raw, 'identifier')) {
      // Read previous v1 authoring documents without rewriting stable node IDs.
      checkText(raw.title, `progress.${id}.title`)
      const oldTitle = (raw.title as FlowText).text.trim()
      const base = oldTitle && oldTitle !== `progress.${id}.title` ? oldTitle.slice(0, 200).replace(/[\r\n\t]/g, '_') : start ? 'start' : 'progress'
      let identifier = base, suffix = 2
      while (usedIdentifiers.has(identifier)) identifier = `${base.slice(0, 190)}_${suffix++}`
      raw.identifier = identifier; usedIdentifiers.add(identifier)
    }
    require(typeof raw.identifier === 'string', `progress.${id}.identifier`)
    delete raw.title
    checkText(node.runningLog, `progress.${id}.runningLog`)
    checkText(node.completedLog, `progress.${id}.completedLog`)
    if (start) {
      checkText(node.questTitle, `progress.${id}.questTitle`)
      checkText(node.description, `progress.${id}.description`)
    } else {
      require(!Object.hasOwn(raw, 'questTitle') && !Object.hasOwn(raw, 'description'), `progress.${id}（只有开始进度节点可以带 questTitle / description）`)
    }
    require(node.completion === 'all' || node.completion === 'any' || node.completion === 'custom', `progress.${id}.completion`)
    const graph = raw.completionGraph === undefined ? undefined : parseCompletionGraph(raw.completionGraph)
    require(node.completion !== 'custom' || graph, `progress.${id}.completion（自定义完成需要 completionGraph）`)
    require(Array.isArray(node.goals), `progress.${id}.goals`)
    for (const item of node.goals as unknown[]) {
      require(isObject(item) && typeof item.id === 'string' && safeId(item.id) && typeof item.kind === 'string' && isObject(item.params), `progress.${id}.goals`)
      require(Object.keys(item as Record<string, unknown>).every(key => ['id', 'kind', 'params'].includes(key)), `progress.${id}.goals（goal 不描述提交；请在进度节点上配置 submission）`)
      const goal = item as FlowProgressGoal
      for (const [key, data] of Object.entries(goal.params)) {
        require(typeof data === 'string' || typeof data === 'boolean' || (typeof data === 'number' && Number.isFinite(data)), `progress.${id}.goals.${goal.id}.params.${key}`)
      }
    }
  }
  const seenNodeIds = new Set(Object.keys(progressFamily))
  if (f.objectives !== undefined) {
    require(isObject(f.objectives), 'objectives')
    for (const [id, value] of Object.entries(f.objectives as Record<string, unknown>)) {
      require(safeId(id) && !seenNodeIds.has(id) && isObject(value), `objectives.${id}`)
      seenNodeIds.add(id)
      const raw = value as Record<string, unknown>
      require(Object.keys(raw).every(key => ['identifier', 'goal', 'submission', 'extensions'].includes(key)), `objectives.${id}`)
      require(raw.identifier === undefined || typeof raw.identifier === 'string', `objectives.${id}.identifier`)
      // Keep old anonymous nodes editable, but invalid until the author names them.
      raw.identifier ??= ''
      if (raw.submission !== undefined) {
        parseFlowSubmission(raw.submission, `objectives.${id}.submission`)
      }
      checkExtensions(raw, `objectives.${id}`)
      const goal = raw.goal
      require(isObject(goal) && Object.keys(goal).every(key => ['kind', 'params'].includes(key)) && typeof goal.kind === 'string' && isObject(goal.params), `objectives.${id}.goal`)
      for (const data of Object.values((goal as { params: Data }).params)) {
        require(typeof data === 'string' || typeof data === 'boolean' || (typeof data === 'number' && Number.isFinite(data)), `objectives.${id}.goal.params`)
      }
    }
  }
  if (f.predicates !== undefined) {
    require(isObject(f.predicates), 'predicates')
    for (const [id, value] of Object.entries(f.predicates as Record<string, unknown>)) {
      require(safeId(id) && !seenNodeIds.has(id) && isObject(value), `predicates.${id}`)
      seenNodeIds.add(id)
      const node = value as FlowPredicateNode
      const raw = value as Record<string, unknown>
      require(Object.keys(raw).every(key => ['identifier', 'title', 'conditions', 'extensions'].includes(key)), `predicates.${id}（不支持旧草稿字段）`)
      require(raw.identifier === undefined || typeof raw.identifier === 'string', `predicates.${id}.identifier`)
      checkExtensions(raw, `predicates.${id}`)
      if (Object.hasOwn(raw, 'title')) { checkText(raw.title, `predicates.${id}.title`); delete raw.title }
      node.conditions = parseConditionRules(raw.conditions, '条件节点', true)
    }
  }
  if (f.transitions !== undefined) {
    require(isObject(f.transitions), 'transitions')
    for (const [id, value] of Object.entries(f.transitions as Record<string, unknown>)) {
      require(safeId(id) && !seenNodeIds.has(id) && isObject(value), `transitions.${id}`)
      seenNodeIds.add(id)
      const raw = value as Record<string, unknown>
      require(Object.keys(raw).every(key => key === 'extensions'), `transitions.${id}（不支持旧草稿字段）`)
      checkExtensions(raw, `transitions.${id}`)
    }
  }
  if (f.ends !== undefined) {
    require(isObject(f.ends), 'ends')
    for (const [id, value] of Object.entries(f.ends as Record<string, unknown>)) {
      require(safeId(id) && !seenNodeIds.has(id) && isObject(value), `ends.${id}`)
      seenNodeIds.add(id)
      const node = value as FlowEndNode
      const raw = value as Record<string, unknown>
      require(Object.keys(raw).every(key => ['title', 'rewardKits', 'extensions'].includes(key)), `ends.${id}（不支持旧草稿字段）`)
      checkExtensions(raw, `ends.${id}`)
      checkText(node.title, `ends.${id}.title`)
      checkKits(node.rewardKits, `ends.${id}.rewardKits`)
    }
  }
  if (f.logic !== undefined) {
    require(isObject(f.logic) && Array.isArray(f.logic.links) && !Object.hasOwn(f.logic, 'nodes'), 'logic')
    for (const link of (f.logic as { links: unknown[] }).links) {
      require(isObject(link) && typeof link.id === 'string' && typeof link.from === 'string' && typeof link.to === 'string'
        && (link.port === 'input' || link.port === 'input2')
        && (link.fromPort === undefined || link.fromPort === 'output' || link.fromPort === 'output2')
        && [link.order, link.reverseOrder].every(value => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)), 'logic.links')
    }
  }
  if (f.layout !== undefined) {
    require(isObject(f.layout) && isObject(f.layout.positions), 'layout.positions')
    for (const [id, p] of Object.entries((f.layout as { positions: Record<string, unknown> }).positions)) {
      require(safeId(id) && isObject(p) && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y), `layout.positions.${id}`)
    }
    const groups = (f.layout as ProgressFlow['layout'])?.groups
    if (groups !== undefined) {
      require(isObject(groups), 'layout.groups')
      for (const [id, group] of Object.entries(groups)) require(safeId(id) && isObject(group) && (group.name === undefined || typeof group.name === 'string') && Array.isArray(group.nodes) && group.nodes.every(node => typeof node === 'string'), `layout.groups.${id}`)
    }
    const notes = (f.layout as ProgressFlow['layout'])?.notes
    if (notes !== undefined) {
      require(isObject(notes), 'layout.notes')
      for (const [id, note] of Object.entries(notes)) {
        require(safeId(id) && !hasContentNode(v as ProgressFlow, id) && isObject(note), `layout.notes.${id}`)
        require(typeof note.title === 'string' && typeof note.text === 'string' && Object.hasOwn(NOTE_COLORS, note.color), `layout.notes.${id}`)
        require(Number.isFinite(note.width) && note.width >= 160 && Number.isFinite(note.height) && note.height >= 96, `layout.notes.${id}.size`)
      }
    }
  }
  return normalizeLinkOrder(v as ProgressFlow)
}

export function validateFlow(flow: ProgressFlow, definitions: readonly { kind: string; requiresDelivery?: boolean; error?: string }[] = []): FlowIssue[] {
  const issues: FlowIssue[] = []
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message })
  const warning = (path: string, message: string) => issues.push({ severity: 'warning', path, message })
  if (!safeId(flow.id)) error('id', '请填写稳定的文档 ID。')
  const count = Object.keys(flow.progress).length + Object.keys(flow.predicates ?? {}).length + Object.keys(flow.objectives ?? {}).length + Object.keys(flow.transitions ?? {}).length + Object.keys(flow.ends ?? {}).length
  if (count > FLOW_LIMITS.nodes || (flow.logic?.links.length ?? 0) > FLOW_LIMITS.links) {
    error('graph', `运行图最多 ${FLOW_LIMITS.nodes} 个节点、${FLOW_LIMITS.links} 条连接。`); return issues
  }
  const ports = new Map<string, number>(), signatures = new Set<string>()
  for (const link of flow.logic?.links ?? []) {
    const signature = JSON.stringify([link.from, linkSourcePort(flow, link.from, link.fromPort), link.to, link.port])
    if (signatures.has(signature)) error('logic.links', '不允许重复连接。')
    signatures.add(signature)
    for (const key of [`o:${link.from}:${linkSourcePort(flow, link.from, link.fromPort)}`, `i:${link.to}:${link.port}`]) {
      ports.set(key, (ports.get(key) ?? 0) + 1)
      if (ports.get(key) === FLOW_LIMITS.fanout + 1) error('logic.links', `每个端口最多 ${FLOW_LIMITS.fanout} 条连接。`)
    }
  }
  const start = getProgressNode(flow, flow.start)
  if (!start) error('start', '开始进度节点不存在。')
  else if (!displayText(start.questTitle ?? { text: '' }).trim()) warning('start', '还没有为任务命名。')
  const connected = connectedToStart(flow)
  const drafts = new Set([...Object.keys(flow.progress ?? {}), ...Object.keys(flow.predicates ?? {}), ...Object.keys(flow.objectives ?? {}), ...Object.keys(flow.transitions ?? {}), ...Object.keys(flow.ends ?? {})].filter(id => !connected.has(id)))
  for (const id of drafts) warning(id, '未与开始进度节点联通，属于草稿节点。')
  const grouped = new Set<string>()
  for (const [id, group] of Object.entries(flow.layout?.groups ?? {})) {
    for (const node of group.nodes) {
      if (!hasCanvasItem(flow, node)) error(`layout.groups.${id}`, 'Group 中的节点不存在。')
      if (grouped.has(node)) error(`layout.groups.${id}`, '同一节点不能重复分组。')
      grouped.add(node)
    }
  }
  // Only logic nodes are transparent to this advisory; a progress is a lifecycle boundary.
  const logicInputs = new Map<string, string[]>()
  for (const link of flow.logic?.links ?? []) {
    if (!getTransitionNode(flow, link.to) || !inputPorts(flow, link.to).includes(link.port) || !outputPorts(flow, link.from).includes(linkSourcePort(flow, link.from, link.fromPort))) continue
    const sources = logicInputs.get(link.to) ?? []
    sources.push(link.from); logicInputs.set(link.to, sources)
  }
  const backgroundDependency = (from: string): boolean => {
    const queue = [from], seen = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]
      if (seen.has(id)) continue
      seen.add(id)
      if (getObjectiveNode(flow, id) || getPredicateNode(flow, id)) return true
      if (getTransitionNode(flow, id)) queue.push(...(logicInputs.get(id) ?? []))
    }
    return false
  }
  const ids = new Set<string>()
  for (const link of flow.logic?.links ?? []) {
    if (!safeId(link.id) || ids.has(link.id)) error(`logic.links.${link.id}`, '连接 ID 必须有效且在文档内唯一。')
    ids.add(link.id)
    if (!hasContentNode(flow, link.from) || !hasContentNode(flow, link.to)) error(`logic.links.${link.id}`, '连接端点不存在。')
    else if (!canConnectNodes(flow, link.from, link.to, link.port, linkSourcePort(flow, link.from, link.fromPort))) error(`logic.links.${link.id}`, '连接的端口不正确或会成环。')
    else if (getTransitionNode(flow, link.to) && link.port === 'input' && backgroundDependency(link.from)) {
      warning(`logic.links.${link.id}`, '目标或条件节点直接或经过嵌套逻辑接入“并且”端口，属于非建议用法，可能导致任务挂起。这类节点不维持任务存活，请检查等待期间是否仍有能够到达结束节点的运行中进度。')
    }
  }
  const cycle = findCanvasCycle(flow)
  if (cycle) error('graph', `画布连线不能成环：${cycle.join(' → ')}。`)
  for (const [id, node] of Object.entries(flow.progress ?? {})) {
    const identifierIssue = progressIdentifierIssue(flow, id, node.identifier)
    if (identifierIssue) error(`progress.${id}.identifier`, identifierIssue)
    if (node.submission) {
      const issue = flowSubmissionIssue(node.submission)
      if (issue) error(`progress.${id}.submission`, issue)
    }
    if (!node.submission && node.goals.some(goal => definitions.find(definition => definition.kind === goal.kind)?.requiresDelivery)) error(`progress.${id}.submission`, '进度含需要交付的 goal，请在进度节点上配置统一提交方式。')
    const seen = new Set<string>()
    node.goals.forEach((goal, index) => {
      const definition = definitions.find(item => item.kind === goal.kind)
      if (definition?.error) error(`progress.${id}.goals.${goal.id}`, definition.error)
      if (!goal.id.trim() || seen.has(goal.id)) error(`progress.${id}`, `第 ${index + 1} 个目标缺少有效 ID 或与其他目标重复。`)
      seen.add(goal.id)
      if (!goal.kind.trim() && !drafts.has(id)) warning(`progress.${id}`, `第 ${index + 1} 个目标还没有选择类型。`)
    })
  }
  for (const [id, node] of Object.entries(flow.predicates ?? {})) {
    const issue = nodeIdentifierIssue(flow, id, node.identifier ?? '')
    if (issue) error(`predicates.${id}.identifier`, issue)
    if (!node.conditions.length && !drafts.has(id)) warning(`predicates.${id}`, '没有配置条件（恒假）。')
    node.conditions.forEach((rule, index) => {
      if (rule.kind !== 'repeat' && !rule.target.trim() && !drafts.has(id)) warning(`predicates.${id}`, `第 ${index + 1} 个条件还没有填写对象。`)
    })
  }
  for (const [id, node] of Object.entries(flow.objectives ?? {})) {
    const issue = objectiveIdentifierIssue(flow, id, node.identifier ?? '')
    if (issue) error(`objectives.${id}.identifier`, issue)
    const definition = definitions.find(item => item.kind === node.goal.kind)
    if (definition?.error) error(`objectives.${id}.goal`, definition.error)
    if (definition?.requiresDelivery && !node.submission) error(`objectives.${id}.submission`, '此目标定义需要交付，请显式配置提交方式。')
    if (node.submission) {
      const issue = flowSubmissionIssue(node.submission)
      if (issue) error(`objectives.${id}.submission`, issue)
    }
    if (!node.goal.kind.trim() && !drafts.has(id)) warning(`objectives.${id}.goal`, '目标还没有选择类型。')
  }
  if (!Object.keys(flow.ends ?? {}).some(id => connected.has(id))) warning('ends', '没有任何与开始联通的结束节点，任务开始并完成首轮信号结算后将自动失败。')
  return issues
}

/** Directed canvas wires only. */
export function canvasWireEdges(flow: ProgressFlow): { from: string; to: string }[] {
  return (flow.logic?.links ?? []).map(link => ({ from: link.from, to: link.to }))
}

/** Returns one directed cycle as node ids (closed, first === last), or null when acyclic. */
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

export function connectNodes(flow: ProgressFlow, from: string, to: string, port: FlowInputPort = 'input', fromPort: FlowOutputPort = 'output'): { flow: ProgressFlow; selection: FlowSelection } {
  if (!canConnectNodes(flow, from, to, port, fromPort)) throw new Error('只能从右端口连到左端口，且不能成环。')
  const next = clone(flow)
  next.logic ??= { links: [] }
  const source = linkSourcePort(flow, from, fromPort)
  const existing = next.logic.links.find(link => link.from === from && link.to === to && link.port === port && linkSourcePort(next, link.from, link.fromPort) === source)
  if (existing) return { flow, selection: { kind: 'logic-link', id: existing.id } }
  let n = 1
  const used = new Set(next.logic.links.map(link => link.id))
  while (used.has(`link_${n}`)) n++
  const record: FlowLogicLink = { id: `link_${n}`, from, to, port }
  if (getProgressNode(flow, from) || getObjectiveNode(flow, from)) record.fromPort = source
  next.logic.links.push(record)
  return { flow: normalizeLinkOrder(next, true), selection: { kind: 'logic-link', id: record.id } }
}

export function disconnectLink(flow: ProgressFlow, selection: FlowSelection): ProgressFlow {
  if (selection.kind !== 'logic-link') return flow
  const link = flow.logic?.links.find(item => item.id === selection.id)
  if (!link) return flow
  const next = clone(flow); next.logic!.links = next.logic!.links.filter(item => item.id !== selection.id)
  return next
}

export function removeNode(flow: ProgressFlow, id: string): ProgressFlow {
  if (!hasContentNode(flow, id) || id === flow.start) return flow
  const next = clone(flow)
  delete next.progress[id]
  if (next.predicates) delete next.predicates[id]
  if (next.objectives) delete next.objectives[id]
  if (next.transitions) delete next.transitions[id]
  if (next.ends) delete next.ends[id]
  if (next.logic) next.logic.links = next.logic.links.filter(link => link.from !== id && link.to !== id)
  if (next.layout) delete next.layout.positions[id]
  if (next.layout?.groups) next.layout.groups = Object.fromEntries(Object.entries(next.layout.groups).map(([key, group]) => [key, { ...group, nodes: group.nodes.filter(ref => ref !== id) }] as const).filter(([, group]) => group.nodes.length >= 2))
  return next
}
