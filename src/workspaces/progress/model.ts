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
/** Flat node storage plus ordered child references: one tree, without recursive JSON nesting. */
export type ProgressFlow = {
  format: 'hanshu.progress-tree'
  version: 1
  id: string
  kind: 'task' | 'chapter' | 'exploration' | 'custom'
  title: FlowText
  description: FlowText
  root: string
  nodes: Record<string, FlowNode>
  extensions?: Data
}
export type FlowSelection = { kind: 'flow' } | { kind: 'node'; id: string } | { kind: 'branch'; parent: string; id: string }
export type FlowIssue = { severity: 'error' | 'warning'; path: string; message: string }
export const text = (value = ''): FlowText => ({ text: value })
export const displayText = (value: FlowText) => value.text || value.key || ''
export const clone = <T,>(value: T): T => structuredClone(value)
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = (value: string) => value.trim().length > 0 && value.length <= 200 && !['__proto__', 'prototype', 'constructor'].includes(value)
export const getNode = (flow: ProgressFlow, id: string) => Object.hasOwn(flow.nodes, id) ? flow.nodes[id] : undefined
export const branches = (flow: ProgressFlow) => Object.entries(flow.nodes).flatMap(([parent, node]) => node.children.map((branch) => ({ parent, branch })))
export const makeNode = (title = '新阶段'): FlowNode => ({ title: text(title), description: text(), branching: 'parallel', completion: 'continue', children: [], onEnter: [], onFinish: [], rewards: [] })
export function createFlow(id = crypto.randomUUID(), title = '新的进度流程'): ProgressFlow {
  return { format: 'hanshu.progress-tree', version: 1, id, kind: 'task', title: text(title), description: text(), root: 'start', nodes: { start: makeNode('开始') } }
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
  for (const key of ['id', 'kind', 'root']) require(typeof f[key] === 'string', key)
  checkText(f.title, 'title'); checkText(f.description, 'description')
  require(isObject(f.nodes), 'nodes')
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
  if (!getNode(flow, flow.root)) error('root', '起点节点不存在。')
  const incoming = new Map(Object.keys(flow.nodes).map((id) => [id, 0]))
  const ids = new Set<string>()
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
    if (!node.children.length && node.completion === 'continue') warning(id, '这是尚未标记结束的叶节点，可继续补充后续内容。')
    for (const branch of node.children) {
      const path = `${id}.children.${branch.id}`
      if (!safeId(branch.id) || ids.has(branch.id)) error(path, '分支 ID 必须有效且在文档内唯一。')
      ids.add(branch.id)
      if (!getNode(flow, branch.target)) error(path, `后续节点「${branch.target}」不存在。`)
      else incoming.set(branch.target, incoming.get(branch.target)! + 1)
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
  for (const [id, count] of incoming) {
    if (id === flow.root ? count !== 0 : count !== 1) error(id, id === flow.root ? '起点不能有父节点。' : '每个非起点节点必须恰好有一个父节点。')
  }
  const visited = new Set<string>(), queue = [flow.root]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (visited.has(id)) continue
    visited.add(id)
    for (const b of getNode(flow, id)?.children ?? []) queue.push(b.target)
  }
  for (const id of Object.keys(flow.nodes)) if (!visited.has(id)) error(id, '节点没有连接到起点（可能存在孤立分支或环）。')
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
  if (!node || node.completion === 'finish') throw new Error('请先选择可继续推进的父节点。')
  const next = clone(flow), existing = new Set(branches(flow).map(({ branch }) => branch.id))
  let n = 1
  while (getNode(flow, `node_${n}`) || existing.has(`branch_${n}`)) n++
  const id = `node_${n}`
  next.nodes[id] = makeNode(`阶段 ${n}`)
  next.nodes[parent].children.push({ id: `branch_${n}`, target: id, title: text('继续'), trigger: 'automatic', conditions: { mode: 'all', items: [] } })
  return { flow: next, id }
}
export function renameNode(flow: ProgressFlow, id: string, name: string): ProgressFlow {
  if (id === name) return flow
  if (!safeId(name) || getNode(flow, name) || !getNode(flow, id)) throw new Error('节点 ID 不能为空、重复或使用保留名称。')
  const next = clone(flow)
  next.nodes = Object.fromEntries(Object.entries(next.nodes).map(([key, node]) => [key === id ? name : key, node]))
  if (next.root === id) next.root = name
  for (const { branch } of branches(next)) {
    if (branch.target === id) branch.target = name
    for (const c of branch.conditions.items) c.nodeRefs = c.nodeRefs.map((ref) => ref === id ? name : ref)
  }
  return next
}
export function removeNode(flow: ProgressFlow, id: string): ProgressFlow {
  if (id === flow.root) throw new Error('起点不能删除。')
  const removed = descendants(flow, id)
  if (removed.has(flow.root)) throw new Error('此分支含有起点，请先修复环。')
  const next = clone(flow)
  for (const key of removed) delete next.nodes[key]
  for (const node of Object.values(next.nodes)) {
    node.children = node.children.filter((b) => !removed.has(b.target))
    for (const b of node.children) for (const c of b.conditions.items) c.nodeRefs = c.nodeRefs.filter((r) => !removed.has(r))
  }
  return next
}
export function moveNode(flow: ProgressFlow, id: string, parent: string): ProgressFlow {
  if (id === flow.root || !getNode(flow, id) || !getNode(flow, parent) || descendants(flow, id).has(parent)) throw new Error('不能将节点移到自身或自己的后代下。')
  if (flow.nodes[parent].completion === 'finish') throw new Error('结束节点不能添加后续分支。')
  const matches = branches(flow).filter(({ branch }) => branch.target === id)
  if (matches.length !== 1) throw new Error('请先修复该节点的父子关系。')
  const next = clone(flow), old = matches[0]
  const index = next.nodes[old.parent].children.findIndex((b) => b.id === old.branch.id)
  const [branch] = next.nodes[old.parent].children.splice(index, 1)
  next.nodes[parent].children.push(branch)
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
