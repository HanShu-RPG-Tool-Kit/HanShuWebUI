import { parseJsonValue } from '../../utils/strictJson'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Data = { [key: string]: Json }
/** Author text stays separate from a localization key. Rendering belongs to the consumer. */
export type FlowText = { text: string; key?: string }
export type FlowCondition = {
  id: string
  kind: 'manual' | 'counter' | 'signal' | 'nodes' | 'external'
  title: FlowText
  params: Data
  nodeRefs: string[]
  extensions?: Data
}
export type FlowResource = { id: string; reference: string; params: Data; extensions?: Data }
export type FlowBranch = {
  id: string
  target: string
  title: FlowText
  trigger: 'automatic' | 'confirm'
  conditions: { mode: 'all' | 'any'; items: FlowCondition[] }
  extensions?: Data
}
export type FlowNode = {
  title: FlowText
  description: FlowText
  branching: 'parallel' | 'choice' | 'priority'
  completion: 'continue' | 'finish'
  children: FlowBranch[]
  onEnter: FlowResource[]
  onFinish: FlowResource[]
  rewards: FlowResource[]
  extensions?: Data
}
export type FlowPosition = { x: number; y: number }
export type FlowEntry = { id: string; target: string | null; port?: FlowInputPort }
export type LogicOperator = 'and' | 'or'
export type FlowInputPort = 'input' | 'input2'
export type FlowPort = FlowInputPort | 'output'
export type FlowLogicNode = { operator: LogicOperator; title: FlowText; description: FlowText }
export type FlowLogicLink = { id: string; from: string; to: string; port: FlowInputPort }
export type FlowTransitionNode = { title: FlowText; description: FlowText }
export type FlowGoalNode = Omit<FlowCondition, 'id'> & { description: FlowText }
export const NOTE_COLORS = { slate: '灰蓝', sand: '暖灰', sage: '灰绿', mauve: '灰紫' } as const
export type FlowCanvasNote = { title: string; text: string; width: number; height: number; color: keyof typeof NOTE_COLORS }
export type CanvasNodeType = LogicOperator | 'goal' | 'note' | 'transition'
export const GOAL_NAMES: Record<FlowCondition['kind'], string> = { manual: '人工标记', counter: '累计事件', signal: '等待信号', nodes: '等待阶段', external: '外部条件' }
export const LOGIC_NAMES: Record<LogicOperator, string> = { and: '合取', or: '析取' }
export const LOGIC_SYMBOLS: Record<LogicOperator, string> = { and: '∧', or: '∨' }
export const LOGIC_CODES: Record<LogicOperator, string> = { and: 'AND', or: 'OR' }
/** Provisional authoring data. Canvas layout is independent of node content and connections. */
export type ProgressFlow = {
  format: 'hanshu.progress-tree'
  version: 1
  id: string
  kind: 'task' | 'chapter' | 'exploration' | 'custom'
  title: FlowText
  description: FlowText
  entry: FlowEntry
  nodes: Record<string, FlowNode>
  logic?: { nodes: Record<string, FlowLogicNode>; links: FlowLogicLink[] }
  goals?: Record<string, FlowGoalNode>
  transitions?: Record<string, FlowTransitionNode>
  layout?: { positions: Record<string, FlowPosition>; notes?: Record<string, FlowCanvasNote>; groups?: Record<string, { name?: string; nodes: string[] }> }
  extensions?: Data
}
export type FlowSelection = { kind: 'flow' } | { kind: 'entry' } | { kind: 'entry-link' } | { kind: 'node'; id: string } | { kind: 'logic'; id: string } | { kind: 'goal'; id: string } | { kind: 'logic-link'; id: string } | { kind: 'note'; id: string } | { kind: 'transition'; id: string } | { kind: 'branch'; parent: string; id: string }
export type FlowIssue = { severity: 'error' | 'warning'; path: string; message: string }
export const text = (value = ''): FlowText => ({ text: value })
export const displayText = (value: FlowText) => value.text || value.key || ''
export const clone = <T,>(value: T): T => structuredClone(value)
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = (value: string) => value.trim().length > 0 && value.length <= 200 && !['__proto__', 'prototype', 'constructor'].includes(value)
export const getNode = (flow: ProgressFlow, id: string | null) => id !== null && Object.hasOwn(flow.nodes, id) ? flow.nodes[id] : undefined
export const getLogicNode = (flow: ProgressFlow, id: string) => flow.logic && Object.hasOwn(flow.logic.nodes, id) ? flow.logic.nodes[id] : undefined
export const getGoalNode = (flow: ProgressFlow, id: string) => flow.goals && Object.hasOwn(flow.goals, id) ? flow.goals[id] : undefined
export const getTransitionNode = (flow: ProgressFlow, id: string) => flow.transitions && Object.hasOwn(flow.transitions, id) ? flow.transitions[id] : undefined
export const hasContentNode = (flow: ProgressFlow, id: string) => !!getNode(flow, id) || !!getLogicNode(flow, id) || !!getGoalNode(flow, id) || !!getTransitionNode(flow, id)
export const getCanvasNote = (flow: ProgressFlow, id: string) => flow.layout?.notes && Object.hasOwn(flow.layout.notes, id) ? flow.layout.notes[id] : undefined
export const hasCanvasItem = (flow: ProgressFlow, id: string) => hasContentNode(flow, id) || !!getCanvasNote(flow, id)
export const inputPorts = (flow: ProgressFlow, id: string): FlowInputPort[] => id === flow.entry.id ? [] : getTransitionNode(flow, id) ? ['input', 'input2'] : hasContentNode(flow, id) ? ['input'] : []
export const canConnectNodes = (flow: ProgressFlow, from: string, to: string, port: FlowInputPort) => inputPorts(flow, to).includes(port) && (from === flow.entry.id || !!getLogicNode(flow, from) || !!getGoalNode(flow, from) || !!getTransitionNode(flow, from) || (!!getNode(flow, from) && flow.nodes[from].completion !== 'finish'))
export const branches = (flow: ProgressFlow) => Object.entries(flow.nodes).flatMap(([parent, node]) => node.children.map((branch) => ({ parent, branch })))
export const makeNode = (title = '新阶段'): FlowNode => ({ title: text(title), description: text(), branching: 'parallel', completion: 'continue', children: [], onEnter: [], onFinish: [], rewards: [] })
export function createFlow(id = crypto.randomUUID(), title = '新的进度流程'): ProgressFlow {
  return { format: 'hanshu.progress-tree', version: 1, id, kind: 'task', title: text(title), description: text(), entry: { id: 'entry', target: null }, nodes: {} }
}

/** Shape checks protect views; semantic errors remain editable and appear in validation. */
export function parseFlow(source: string): ProgressFlow {
  const v = parseJsonValue(source)
  const require = (ok: unknown, path: string): void => { if (!ok) throw new Error(`${path}：树图文档结构不正确`) }
  const checkExtensions = (v: Record<string, unknown>, path: string) => require(v.extensions === undefined || isObject(v.extensions), `${path}.extensions`)
  const checkText = (v: unknown, path: string) => require(isObject(v) && typeof v.text === 'string' && (v.key === undefined || typeof v.key === 'string'), path)
  const checkResources = (v: unknown, path: string) => {
    require(Array.isArray(v), path)
    for (const r of v as unknown[]) {
      require(isObject(r) && typeof r.id === 'string' && typeof r.reference === 'string' && isObject(r.params), path)
      checkExtensions(r as Record<string, unknown>, path)
    }
  }
  require(isObject(v), '$')
  const f = v as Record<string, unknown>
  checkExtensions(f, '$')
  if (f.format !== 'hanshu.progress-tree' || f.version !== 1) throw new Error('不支持的树图文档格式或版本；需要 hanshu.progress-tree v1')
  for (const key of ['id', 'kind']) require(typeof f[key] === 'string', key)
  require(isObject(f.entry) && typeof f.entry.id === 'string' && safeId(f.entry.id) && (f.entry.target === null || typeof f.entry.target === 'string') && (f.entry.port === undefined || f.entry.port === 'input' || f.entry.port === 'input2'), 'entry')
  require(!Object.hasOwn(f, 'root'), 'entry（起点现在是独立节点）')
  if (f.layout !== undefined) {
    require(isObject(f.layout) && isObject(f.layout.positions), 'layout.positions')
    for (const [id, p] of Object.entries((f.layout as { positions: Record<string, unknown> }).positions)) {
      require(safeId(id) && isObject(p) && typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y), `layout.positions.${id}`)
    }
  }
  checkText(f.title, 'title'); checkText(f.description, 'description')
  const groups = (f.layout as ProgressFlow['layout'])?.groups
  if (groups !== undefined) {
    require(isObject(groups), 'layout.groups')
    for (const [id, group] of Object.entries(groups)) require(safeId(id) && isObject(group) && (group.name === undefined || typeof group.name === 'string') && Array.isArray(group.nodes) && group.nodes.every(node => typeof node === 'string'), `layout.groups.${id}`)
  }
  require(isObject(f.nodes), 'nodes')
  require(!Object.hasOwn(f.nodes as object, (f.entry as FlowEntry).id), 'entry.id（不能与 checkpoint 重复）')
  if (f.logic !== undefined) {
    require(isObject(f.logic) && isObject(f.logic.nodes) && Array.isArray(f.logic.links), 'logic')
    const logic = f.logic as { nodes: Record<string, unknown>; links: unknown[] }
    for (const [id, node] of Object.entries(logic.nodes)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !Object.hasOwn(f.nodes as object, id) && isObject(node), `logic.nodes.${id}`)
      require(['and', 'or'].includes((node as FlowLogicNode).operator), `logic.nodes.${id}.operator`)
      checkText((node as FlowLogicNode).title, `logic.nodes.${id}.title`); checkText((node as FlowLogicNode).description, `logic.nodes.${id}.description`)
    }
    for (const link of logic.links) require(isObject(link) && typeof link.id === 'string' && typeof link.from === 'string' && typeof link.to === 'string' && (link.port === 'input' || link.port === 'input2'), 'logic.links')
  }
  if (f.goals !== undefined) {
    require(isObject(f.goals), 'goals')
    for (const [id, value] of Object.entries(f.goals as Record<string, unknown>)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !Object.hasOwn(f.nodes as object, id) && !(f.logic && Object.hasOwn((f.logic as ProgressFlow['logic'])!.nodes, id)) && isObject(value), `goals.${id}`)
      const goal = value as FlowGoalNode
      require(Object.hasOwn(GOAL_NAMES, goal.kind) && isObject(goal.params) && Array.isArray(goal.nodeRefs) && goal.nodeRefs.every(ref => typeof ref === 'string'), `goals.${id}`)
      checkText(goal.title, `goals.${id}.title`); checkText(goal.description, `goals.${id}.description`)
    }
  }
  if (f.transitions !== undefined) {
    require(isObject(f.transitions), 'transitions')
    for (const [id, value] of Object.entries(f.transitions as Record<string, unknown>)) {
      require(safeId(id) && id !== (f.entry as FlowEntry).id && !Object.hasOwn(f.nodes as object, id) && !(f.logic && Object.hasOwn((f.logic as ProgressFlow['logic'])!.nodes, id)) && !(f.goals && Object.hasOwn(f.goals as object, id)) && isObject(value), `transitions.${id}`)
      const transition = value as FlowTransitionNode
      checkText(transition.title, `transitions.${id}.title`); checkText(transition.description, `transitions.${id}.description`)
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
    require(typeof node.branching === 'string' && typeof node.completion === 'string' && Array.isArray(node.children), id)
    for (const key of ['onEnter', 'onFinish', 'rewards']) checkResources(node[key], `${id}.${key}`)
    for (const b of node.children as unknown[]) {
      require(isObject(b), `${id}.children`)
      const branch = b as Record<string, unknown>
      checkExtensions(branch, `${id}.children`)
      require(typeof branch.id === 'string' && typeof branch.target === 'string' && typeof branch.trigger === 'string', `${id}.children`)
      checkText(branch.title, `${id}.branch.title`)
      require(isObject(branch.conditions) && typeof branch.conditions.mode === 'string' && Array.isArray(branch.conditions.items), `${id}.conditions`)
      for (const c of (branch.conditions as { items: unknown[] }).items) {
        require(isObject(c) && typeof c.id === 'string' && typeof c.kind === 'string' && isObject(c.params) && Array.isArray(c.nodeRefs) && c.nodeRefs.every((r) => typeof r === 'string'), `${id}.conditions.items`)
        checkText((c as Record<string, unknown>).title, `${id}.condition.title`)
        checkExtensions(c as Record<string, unknown>, `${id}.condition`)
      }
    }
  }
  return v as ProgressFlow
}

export function validateFlow(flow: ProgressFlow): FlowIssue[] {
  const issues: FlowIssue[] = []
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message })
  const warning = (path: string, message: string) => issues.push({ severity: 'warning', path, message })
  if (!safeId(flow.id)) error('id', '请填写稳定的文档 ID。')
  if (!['task', 'chapter', 'exploration', 'custom'].includes(flow.kind)) error('kind', '未知的流程类别。')
  if (!displayText(flow.title).trim()) warning('title', '还没有为流程命名。')
  if (flow.entry.target !== null && !inputPorts(flow, flow.entry.target).includes(flow.entry.port ?? 'input')) error('entry.target', '起点连接的节点不存在或没有输入端口。')
  const ids = new Set<string>()
  const grouped = new Set<string>()
  for (const [id, group] of Object.entries(flow.layout?.groups ?? {})) {
    for (const node of group.nodes) {
      if (node !== flow.entry.id && !hasCanvasItem(flow, node)) error(`layout.groups.${id}`, 'Group 中的节点不存在。')
      if (grouped.has(node)) error(`layout.groups.${id}`, '同一节点不能重复分组。')
      grouped.add(node)
    }
  }
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (!['parallel', 'choice', 'priority'].includes(node.branching)) error(id, '未知的分支方式。')
    if (!['continue', 'finish'].includes(node.completion)) error(id, '未知的完成方式。')
    if (node.completion === 'finish' && node.children.length) error(id, '结束节点不能再有后续分支。')
    for (const key of ['onEnter', 'onFinish', 'rewards'] as const) {
      const resourceIds = new Set<string>()
      for (const resource of node[key]) {
        if (!safeId(resource.id) || resourceIds.has(resource.id)) error(`${id}.${key}`, '资源项 ID 必须有效且在列表内唯一。')
        resourceIds.add(resource.id)
        if (!resource.reference.trim()) error(`${id}.${key}`, '资源引用不能为空。')
      }
    }
    for (const branch of node.children) {
      const path = `${id}.children.${branch.id}`
      if (!safeId(branch.id) || ids.has(branch.id)) error(path, '分支 ID 必须有效且在文档内唯一。')
      ids.add(branch.id)
      if (!getNode(flow, branch.target)) error(path, `后续节点「${branch.target}」不存在。`)
      if (!['automatic', 'confirm'].includes(branch.trigger)) error(path, '未知的推进方式。')
      if (!['all', 'any'].includes(branch.conditions.mode)) error(path, '条件组合应为全部或任一满足。')
      const conditionIds = new Set<string>()
      for (const c of branch.conditions.items) {
        if (!safeId(c.id) || conditionIds.has(c.id)) error(path, '条件 ID 必须有效且在分支内唯一。')
        conditionIds.add(c.id)
        if (!['manual', 'counter', 'signal', 'nodes', 'external'].includes(c.kind)) error(path, `未知条件类型「${c.kind}」。`)
        if (c.kind === 'counter' && (typeof c.params.target !== 'number' || !Number.isFinite(c.params.target) || c.params.target <= 0)) error(path, '计数条件的目标值必须大于零。')
        if (['counter', 'signal'].includes(c.kind) && (typeof c.params.event !== 'string' || !c.params.event.trim())) error(path, '请指定事件引用。')
        if (c.kind === 'external' && (typeof c.params.reference !== 'string' || !c.params.reference.trim() || !isObject(c.params.args))) error(path, '外部条件需要引用和参数对象。')
        if (c.kind === 'nodes' && !c.nodeRefs.length) error(path, '请选择至少一个要等待的节点。')
        for (const ref of c.nodeRefs) if (!getNode(flow, ref)) error(path, `引用的节点「${ref}」不存在。`)
      }
    }
  }
  for (const link of flow.logic?.links ?? []) {
    if (!safeId(link.id) || ids.has(link.id)) error(`logic.links.${link.id}`, '连接 ID 必须有效且在文档内唯一。')
    ids.add(link.id)
    if (!hasContentNode(flow, link.from) || !hasContentNode(flow, link.to)) error(`logic.links.${link.id}`, '连接端点不存在。')
    else if (!canConnectNodes(flow, link.from, link.to, link.port) || (!getLogicNode(flow, link.from) && !getLogicNode(flow, link.to) && !getGoalNode(flow, link.from) && !getGoalNode(flow, link.to) && !getTransitionNode(flow, link.from) && !getTransitionNode(flow, link.to))) error(`logic.links.${link.id}`, '连接的端口不正确。')
  }
  for (const [id, goal] of Object.entries(flow.goals ?? {})) {
    for (const ref of goal.nodeRefs) if (!getNode(flow, ref)) error(`goals.${id}`, `引用的阶段「${ref}」不存在。`)
  }
  return issues
}

export function descendants(flow: ProgressFlow, id: string): Set<string> {
  const found = new Set<string>(), queue = [id]
  for (let i = 0; i < queue.length; i++) {
    if (found.has(queue[i])) continue
    found.add(queue[i]); queue.push(...(getNode(flow, queue[i])?.children.map((b) => b.target) ?? []))
  }
  return found
}
export function addNode(flow: ProgressFlow, parent: string): { flow: ProgressFlow; id: string } {
  const node = getNode(flow, parent)
  const isEntry = parent === flow.entry.id
  if (isEntry ? flow.entry.target !== null : !node || node.completion === 'finish') throw new Error('请选择没有连接的起点，或可继续推进的 checkpoint。')
  const next = clone(flow), existing = new Set(branches(flow).map(({ branch }) => branch.id))
  let n = 1
  while (hasCanvasItem(flow, `node_${n}`) || flow.entry.id === `node_${n}` || existing.has(`branch_${n}`) || flow.logic?.links.some(link => link.id === `branch_${n}`)) n++
  const id = `node_${n}`
  next.nodes[id] = makeNode(`阶段 ${n}`)
  if (isEntry) { next.entry.target = id; delete next.entry.port }
  else next.nodes[parent].children.push({ id: `branch_${n}`, target: id, title: text('继续'), trigger: 'automatic', conditions: { mode: 'all', items: [] } })
  return { flow: next, id }
}
export function renameNode(flow: ProgressFlow, id: string, name: string): ProgressFlow {
  if (id === name) return flow
  if (!safeId(name) || name === flow.entry.id || hasCanvasItem(flow, name) || !getNode(flow, id)) throw new Error('节点 ID 不能为空、重复或使用保留名称。')
  const next = clone(flow)
  next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([key, node]) => [key === id ? name : key, node]))
  if (next.entry.target === id) next.entry.target = name
  if (next.layout && Object.hasOwn(next.layout.positions, id)) {
    next.layout.positions = Object.fromEntries(Object.entries(next.layout.positions).map(([key, position]) => [key === id ? name : key, position]))
  }
  for (const { branch } of branches(next)) {
    if (branch.target === id) branch.target = name
    for (const c of branch.conditions.items) c.nodeRefs = c.nodeRefs.map((ref) => ref === id ? name : ref)
  }
  for (const link of next.logic?.links ?? []) { if (link.from === id) link.from = name; if (link.to === id) link.to = name }
  for (const goal of Object.values(next.goals ?? {})) goal.nodeRefs = goal.nodeRefs.map(ref => ref === id ? name : ref)
  for (const group of Object.values(next.layout?.groups ?? {})) group.nodes = group.nodes.map(ref => ref === id ? name : ref)
  return next
}
export function removeNode(flow: ProgressFlow, id: string): ProgressFlow {
  if (id === flow.entry.id) return flow
  if (!hasContentNode(flow, id)) return flow
  const next = clone(flow)
  delete next.nodes[id]
  if (next.goals) delete next.goals[id]
  if (next.transitions) delete next.transitions[id]
  if (next.logic) { delete next.logic.nodes[id]; next.logic.links = next.logic.links.filter(link => link.from !== id && link.to !== id) }
  if (next.entry.target === id) { next.entry.target = null; delete next.entry.port }
  if (next.layout) delete next.layout.positions[id]
  if (next.layout?.groups) next.layout.groups = Object.fromEntries(Object.entries(next.layout.groups).map(([key, group]) => [key, { ...group, nodes: group.nodes.filter(ref => ref !== id) }] as const).filter(([, group]) => group.nodes.length >= 2))
  for (const goal of Object.values(next.goals ?? {})) goal.nodeRefs = goal.nodeRefs.filter(ref => ref !== id)
  for (const node of Object.values(next.nodes)) {
    node.children = node.children.filter((b) => b.target !== id)
    for (const b of node.children) for (const c of b.conditions.items) c.nodeRefs = c.nodeRefs.filter((r) => r !== id)
  }
  return next
}
export function moveNode(flow: ProgressFlow, id: string, parent: string): ProgressFlow {
  if (!getNode(flow, id) || !getNode(flow, parent) || descendants(flow, id).has(parent)) throw new Error('不能将节点移到自身或自己的后代下。')
  if (flow.nodes[parent].completion === 'finish') throw new Error('结束节点不能添加后续分支。')
  const matches = branches(flow).filter(({ branch }) => branch.target === id)
  if (matches.length !== 1) throw new Error('请先修复该节点的父子关系。')
  const next = clone(flow), old = matches[0]
  const index = next.nodes[old.parent].children.findIndex((b) => b.id === old.branch.id)
  const [branch] = next.nodes[old.parent].children.splice(index, 1)
  next.nodes[parent].children.push(branch)
  return next
}
export function connectEntry(flow: ProgressFlow, target: string | null, port: FlowInputPort = 'input'): ProgressFlow {
  if (target !== null && !inputPorts(flow, target).includes(port)) throw new Error('请选择已有节点的输入端口。')
  if (target === flow.entry.target && (target === null || (flow.entry.port ?? 'input') === port)) return flow
  const next = clone(flow); next.entry.target = target
  if (target !== null && port !== 'input') next.entry.port = port
  else delete next.entry.port
  return next
}
/** Checkpoint branches retain their content; other connections record endpoints and input ports. */
export function connectNodes(flow: ProgressFlow, from: string, to: string, port: FlowInputPort = 'input'): { flow: ProgressFlow; selection: FlowSelection } {
  if (!hasContentNode(flow, to)) throw new Error('连接目标必须是已有节点。')
  if (!canConnectNodes(flow, from, to, port)) throw new Error('请选择可连接的输入、输出端口。')
  if (from === flow.entry.id) return { flow: connectEntry(flow, to, port), selection: { kind: 'entry-link' } }
  if (getLogicNode(flow, from) || getLogicNode(flow, to) || getGoalNode(flow, from) || getGoalNode(flow, to) || getTransitionNode(flow, from) || getTransitionNode(flow, to)) {
    const existing = flow.logic?.links.find(link => link.from === from && link.to === to && link.port === port)
    if (existing) return { flow, selection: { kind: 'logic-link', id: existing.id } }
    const next = clone(flow), ids = new Set([...branches(flow).map(({ branch }) => branch.id), ...(flow.logic?.links.map(link => link.id) ?? [])])
    let n = 1; while (ids.has(`link_${n}`)) n++
    next.logic ??= { nodes: {}, links: [] }
    next.logic.links.push({ id: `link_${n}`, from, to, port })
    return { flow: next, selection: { kind: 'logic-link', id: `link_${n}` } }
  }
  const node = getNode(flow, from)
  if (!node || node.completion === 'finish') throw new Error('请选择可继续推进的 checkpoint 输出端口。')
  const existing = node.children.find(branch => branch.target === to)
  if (existing) return { flow, selection: { kind: 'branch', parent: from, id: existing.id } }
  const next = clone(flow), ids = new Set([...branches(flow).map(({ branch }) => branch.id), ...(flow.logic?.links.map(link => link.id) ?? [])])
  let n = 1
  while (ids.has(`branch_${n}`)) n++
  const id = `branch_${n}`
  next.nodes[from].children.push({ id, target: to, title: text('继续'), trigger: 'automatic', conditions: { mode: 'all', items: [] } })
  return { flow: next, selection: { kind: 'branch', parent: from, id } }
}
export function disconnectLink(flow: ProgressFlow, selection: FlowSelection): ProgressFlow {
  if (selection.kind === 'entry-link') return connectEntry(flow, null)
  if (selection.kind === 'logic-link') {
    if (!flow.logic?.links.some(link => link.id === selection.id)) return flow
    const next = clone(flow); next.logic!.links = next.logic!.links.filter(link => link.id !== selection.id)
    return next
  }
  if (selection.kind !== 'branch' || !getNode(flow, selection.parent)?.children.some(branch => branch.id === selection.id)) return flow
  const next = clone(flow)
  next.nodes[selection.parent].children = next.nodes[selection.parent].children.filter(branch => branch.id !== selection.id)
  return next
}
export function reorderBranch(flow: ProgressFlow, parent: string, id: string, delta: number): ProgressFlow {
  const next = clone(flow), children = getNode(next, parent)?.children
  if (!children) return flow
  const index = children.findIndex((b) => b.id === id), target = index + delta
  if (index < 0 || target < 0 || target >= children.length) return flow
  const [branch] = children.splice(index, 1); children.splice(target, 0, branch)
  return next
}
