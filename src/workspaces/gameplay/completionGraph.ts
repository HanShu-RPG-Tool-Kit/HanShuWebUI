import { randomId } from '../../project/crypto'
import type { ProgressGoal } from './progressDoc'
import type { Point } from '../../nodeEditor'

export const LOGIC_LABELS = { and: '并且', or: '或者', not: '非', xor: '二元异或' } as const
export type CompletionLogic = keyof typeof LOGIC_LABELS
export type CompletionOutcome = 'success' | 'failure'
export type CompletionPort = 'input' | 'input2' | 'output' | 'output2'
export type CompletionNode = { id: string } & ({ type: 'goal'; goalId: string } | { type: 'logic'; op: CompletionLogic } | { type: 'output' })
export type CompletionLink = { id: string; from: string; fromPort: CompletionPort; to: string; toPort: CompletionPort }
export type CompletionGraph = { nodes: CompletionNode[]; links: CompletionLink[] }
export type GoalTerminal = CompletionOutcome
export type CompletionEval = 'deliverable' | 'failed' | 'race' | null
/** Internal tree used while lowering authoring graphs; questc emits strings instead. */
export type CompletionExpression = { type: 'goal'; goalId: string; outcome: CompletionOutcome } | { type: 'logic'; op: CompletionLogic; inputs: CompletionExpression[] }
/** Compiled questc surface: boolean JS using goalSucceeded(id) / goalFailed(id). */
export type CompletionCompiled = { outputs: Array<{ success?: string; failure?: string }> }

export const SUCCESS_COLOR = '#6f9e6a'
export const FAILURE_COLOR = '#c17d62'
export const LOGIC_COLOR = '#7a9aab'

export const createCompletionGraph = (): CompletionGraph => ({ nodes: [{ id: randomId(), type: 'output' }], links: [] })
export const outcomeOf = (port: CompletionPort): CompletionOutcome => port === 'output' || port === 'input' ? 'success' : 'failure'

/** Display aliases are projections of the current ordered list, never reference identities. */
export function goalAliases(goals: readonly ProgressGoal[]): Map<string, string> {
  const types = new Map<string, number>(), counts = new Map<string, number>(), result = new Map<string, string>()
  for (const goal of goals) {
    if (!types.has(goal.kind)) types.set(goal.kind, types.size)
    let index = types.get(goal.kind)! + 1, letters = ''
    while (index) { index--; letters = String.fromCharCode(65 + index % 26) + letters; index = Math.floor(index / 26) }
    const count = (counts.get(goal.kind) ?? 0) + 1; counts.set(goal.kind, count); result.set(goal.id, `${letters}${count}`)
  }
  return result
}

export function inputLimit(node: CompletionNode, port: CompletionPort): number {
  if (node.type === 'goal' || port === 'output' || port === 'output2') return 0
  if (node.type === 'output') return 1
  return node.op === 'not' ? 1 : node.op === 'xor' ? 2 : Infinity
}

export function outputPortsOf(node: CompletionNode): CompletionPort[] {
  return node.type === 'goal' ? ['output', 'output2'] : node.type === 'logic' ? ['output'] : []
}

export function inputPortsOf(node: CompletionNode): CompletionPort[] {
  return node.type === 'output' ? ['input', 'input2'] : node.type === 'logic' ? ['input'] : []
}

function isPort(value: unknown): value is CompletionPort {
  return value === 'input' || value === 'input2' || value === 'output' || value === 'output2'
}

/** Structural invariants apply to drafts too; incomplete inputs and missing goal references remain editable. */
export function parseCompletionGraph(raw: unknown): CompletionGraph {
  const check = (ok: unknown): void => { if (!ok) throw new Error('自定义完成图结构无效（节点、连线、容量或环）') }
  check(!!raw && typeof raw === 'object' && !Array.isArray(raw))
  const graph = raw as CompletionGraph
  check(Object.keys(graph).every(key => ['nodes', 'links'].includes(key)))
  check(Array.isArray(graph.nodes) && graph.nodes.length <= 512 && Array.isArray(graph.links) && graph.links.length <= 1024)
  const ids = new Set<string>(), byId = new Map<string, CompletionNode>()
  const id = (value: unknown) => { check(typeof value === 'string' && value.trim() && !ids.has(value)); ids.add(value as string) }
  for (const node of graph.nodes) {
    check(!!node && typeof node === 'object'); id(node.id)
    check(node.type === 'output' || node.type === 'goal' && typeof node.goalId === 'string' || node.type === 'logic' && Object.hasOwn(LOGIC_LABELS, node.op))
    check(Object.keys(node).every(key => ['id', 'type', ...(node.type === 'goal' ? ['goalId'] : node.type === 'logic' ? ['op'] : [])].includes(key)))
    byId.set(node.id, node)
  }
  check(graph.nodes.some(node => node.type === 'output'))
  const outgoing = new Map<string, string>(), incoming = new Map<string, number>()
  for (const link of graph.links) {
    check(!!link && typeof link === 'object'); id(link.id)
    check(Object.keys(link).every(key => ['id', 'from', 'fromPort', 'to', 'toPort'].includes(key)))
    check(isPort(link.fromPort) && isPort(link.toPort))
    const source = byId.get(link.from), target = byId.get(link.to)
    check(source && target && outputPortsOf(source).includes(link.fromPort) && inputPortsOf(target).includes(link.toPort))
    const outKey = `${link.from}\0${link.fromPort}`, inKey = `${link.to}\0${link.toPort}`
    check(!outgoing.has(outKey))
    const count = (incoming.get(inKey) ?? 0) + 1
    check(count <= inputLimit(target!, link.toPort)); incoming.set(inKey, count); outgoing.set(outKey, link.to)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const walk = (nodeId: string) => {
    check(!visiting.has(nodeId))
    if (visited.has(nodeId)) return
    visiting.add(nodeId)
    for (const link of graph.links) if (link.from === nodeId) walk(link.to)
    visiting.delete(nodeId); visited.add(nodeId)
  }
  for (const node of graph.nodes) walk(node.id)
  return structuredClone(graph)
}

export function canConnectCompletion(graph: CompletionGraph, from: string, fromPort: CompletionPort, to: string, toPort: CompletionPort): boolean {
  try { parseCompletionGraph({ ...graph, links: [...graph.links, { id: randomId(), from, fromPort, to, toPort }] }); return true } catch { return false }
}

function rootedNodes(graph: CompletionGraph): Set<string> {
  const visited = new Set<string>()
  const pending = graph.nodes.filter(node => node.type === 'output').map(node => node.id)
  while (pending.length) {
    const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id)
    pending.push(...graph.links.filter(link => link.to === id).map(link => link.from))
  }
  return visited
}

/** Blocking authoring issues. Race between success and failure is a warning, not an issue. */
export function completionIssues(graph: CompletionGraph, goals: readonly ProgressGoal[]): string[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node])), visited = rootedNodes(graph), issues: string[] = []
  const outputs = graph.nodes.filter(node => node.type === 'output')
  const connectedOutputs = outputs.filter(node => graph.links.some(link => link.to === node.id))
  if (!connectedOutputs.length) issues.push('请连接完成输出')
  for (const id of visited) {
    const node = byId.get(id)!
    if (node.type === 'goal') {
      if (!goals.some(goal => goal.id === node.goalId)) issues.push('完成树中有未选择或已删除的目标引用')
      continue
    }
    for (const port of inputPortsOf(node)) {
      const inputs = graph.links.filter(link => link.to === id && link.toPort === port)
      const expected = node.type === 'output' ? 0 : node.op === 'xor' ? 2 : 1
      if (node.type === 'output') continue
      if (inputs.length < expected) issues.push(`${LOGIC_LABELS[node.op]}的输入未接完整`)
    }
  }
  return [...new Set(issues)]
}

/** Non-blocking: success and failure sides of the rooted forest can both fire. */
export function completionWarnings(graph: CompletionGraph): string[] {
  const rooted = rootedNodes(graph)
  const toOutput = (port: 'input' | 'input2') => graph.links.some(link => rooted.has(link.to) && graph.nodes.find(node => node.id === link.to)?.type === 'output' && link.toPort === port)
  return toOutput('input') && toOutput('input2') ? ['成功与失败完成输出可同时触发，运行时 first-wins、无稳定优先级'] : []
}

function evalExpr(expr: CompletionExpression, states: ReadonlyMap<string, GoalTerminal | undefined>): boolean {
  if (expr.type === 'goal') return states.get(expr.goalId) === expr.outcome
  const inputs = expr.inputs.map(input => evalExpr(input, states))
  return expr.op === 'and' ? inputs.every(Boolean) : expr.op === 'or' ? inputs.some(Boolean) : expr.op === 'not' ? !inputs[0] : inputs[0] !== inputs[1]
}

function expressionAt(graph: CompletionGraph, id: string, viaPort?: CompletionPort): CompletionExpression {
  const node = graph.nodes.find(item => item.id === id)!
  if (node.type === 'goal') {
    const port = viaPort ?? 'output'
    return { type: 'goal', goalId: node.goalId, outcome: outcomeOf(port) }
  }
  if (node.type !== 'logic') throw new Error('完成输出不能作为表达式叶子')
  const children = graph.links.filter(link => link.to === id).map(link => expressionAt(graph, link.from, link.fromPort))
  return { type: 'logic', op: node.op, inputs: children }
}

/** Emit Mod-aligned helpers: goalSucceeded(id) / goalFailed(id). */
export function emitCompletionSource(expr: CompletionExpression): string {
  if (expr.type === 'goal') {
    return expr.outcome === 'success'
      ? `goalSucceeded(${JSON.stringify(expr.goalId)})`
      : `goalFailed(${JSON.stringify(expr.goalId)})`
  }
  const parts = expr.inputs.map(input => {
    const text = emitCompletionSource(input)
    return input.type === 'logic' && (input.op === 'and' || input.op === 'or' || input.op === 'xor') ? `(${text})` : text
  })
  if (expr.op === 'not') return `!(${parts[0]})`
  if (expr.op === 'and') return parts.join(' && ')
  if (expr.op === 'or') return parts.join(' || ')
  return `((${parts[0]}) || (${parts[1]})) && !((${parts[0]}) && (${parts[1]}))`
}

function compileTree(graph: CompletionGraph, goals: readonly ProgressGoal[]): Array<{ success?: CompletionExpression; failure?: CompletionExpression }> {
  const issues = completionIssues(graph, goals)
  if (issues.length) throw new Error(issues.join('；'))
  const outputs = graph.nodes.filter(node => node.type === 'output').map(node => {
    const success = graph.links.find(link => link.to === node.id && link.toPort === 'input')
    const failure = graph.links.find(link => link.to === node.id && link.toPort === 'input2')
    return {
      ...(success ? { success: expressionAt(graph, success.from, success.fromPort) } : {}),
      ...(failure ? { failure: expressionAt(graph, failure.from, failure.fromPort) } : {}),
    }
  }).filter(item => item.success || item.failure)
  if (!outputs.length) throw new Error('请连接完成输出')
  return outputs
}

export function compileCompletionExpression(graph: CompletionGraph, goals: readonly ProgressGoal[]): CompletionCompiled {
  return {
    outputs: compileTree(graph, goals).map(output => ({
      ...(output.success ? { success: emitCompletionSource(output.success) } : {}),
      ...(output.failure ? { failure: emitCompletionSource(output.failure) } : {}),
    })),
  }
}

/** Lower built-in all/any to the same string-output shape as custom graphs. */
export function compileBuiltinCompletion(mode: 'all' | 'any', goals: readonly { id: string }[]): CompletionCompiled {
  if (!goals.length) throw new Error('缺少目标')
  const successOp = mode === 'all' ? 'and' : 'or'
  const failureOp = mode === 'all' ? 'or' : 'and'
  const success: CompletionExpression = goals.length === 1
    ? { type: 'goal', goalId: goals[0].id, outcome: 'success' }
    : { type: 'logic', op: successOp, inputs: goals.map(goal => ({ type: 'goal' as const, goalId: goal.id, outcome: 'success' as const })) }
  const failure: CompletionExpression = goals.length === 1
    ? { type: 'goal', goalId: goals[0].id, outcome: 'failure' }
    : { type: 'logic', op: failureOp, inputs: goals.map(goal => ({ type: 'goal' as const, goalId: goal.id, outcome: 'failure' as const })) }
  return { outputs: [{ success: emitCompletionSource(success), failure: emitCompletionSource(failure) }] }
}

/** null means invalid/incomplete; race means both sides can fire under current terminals (protocol: first-wins). */
export function evaluateCompletion(graph: CompletionGraph, goals: readonly ProgressGoal[], states: ReadonlyMap<string, GoalTerminal | undefined>): CompletionEval {
  if (completionIssues(graph, goals).length) return null
  let deliverable = false, failed = false
  for (const output of compileTree(graph, goals)) {
    if (output.success && evalExpr(output.success, states)) deliverable = true
    if (output.failure && evalExpr(output.failure, states)) failed = true
  }
  if (deliverable && failed) return 'race'
  if (deliverable) return 'deliverable'
  if (failed) return 'failed'
  return null
}

/** Output-rooted trees, leaves on the left. Other forest components occupy a separate lower lane. */
export function layoutCompletion(graph: CompletionGraph): Record<string, Point> {
  const positions: Record<string, Point> = Object.create(null)
  const children = new Map(graph.nodes.map(node => [node.id, graph.links.filter(link => link.to === node.id).map(link => link.from)]))
  let row = 0
  const visit = (id: string): number => {
    const list = [...new Set(children.get(id) ?? [])], depth = list.length ? Math.max(...list.map(visit)) + 1 : 0
    const y = list.length ? list.reduce((sum, child) => sum + positions[child].y, 0) / list.length : 60 + row++ * 150
    positions[id] = { x: 60 + depth * 270, y }; return depth
  }
  for (const output of graph.nodes.filter(node => node.type === 'output')) visit(output.id)
  row += 1
  const sources = new Set(graph.links.map(link => link.from))
  for (const node of graph.nodes) if (!positions[node.id] && !sources.has(node.id)) visit(node.id)
  return positions
}
