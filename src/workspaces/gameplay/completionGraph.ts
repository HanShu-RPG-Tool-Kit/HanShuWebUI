import { randomId } from '../../project/crypto'
import type { ProgressGoal } from './progressDoc'
import type { Point } from '../../nodeEditor'

export const LOGIC_LABELS = { and: '并且', or: '或者', not: '非', xor: '二元异或' } as const
export type CompletionLogic = keyof typeof LOGIC_LABELS
export type CompletionNode = { id: string } & ({ type: 'goal'; goalId: string } | { type: 'logic'; op: CompletionLogic } | { type: 'output' })
export type CompletionGraph = { nodes: CompletionNode[]; links: { id: string; from: string; to: string }[] }
export const createCompletionGraph = (): CompletionGraph => ({ nodes: [{ id: randomId(), type: 'output' }], links: [] })

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
export function inputLimit(node: CompletionNode): number {
  return node.type === 'goal' ? 0 : node.type === 'output' || node.op === 'not' ? 1 : node.op === 'xor' ? 2 : Infinity
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
  check(graph.nodes.filter(node => node.type === 'output').length === 1)
  const outgoing = new Map<string, string>(), incoming = new Map<string, number>()
  for (const link of graph.links) {
    check(!!link && typeof link === 'object'); id(link.id)
    check(Object.keys(link).every(key => ['id', 'from', 'to'].includes(key)))
    const source = byId.get(link.from), target = byId.get(link.to)
    check(source && target && source.type !== 'output' && !outgoing.has(link.from))
    const count = (incoming.get(link.to) ?? 0) + 1
    check(target && count <= inputLimit(target)); incoming.set(link.to, count); outgoing.set(link.from, link.to)
  }
  for (const node of graph.nodes) {
    const seen = new Set<string>(); let current: string | undefined = node.id
    while (current !== undefined) { check(!seen.has(current)); seen.add(current); current = outgoing.get(current) }
  }
  return structuredClone(graph)
}
export function canConnectCompletion(graph: CompletionGraph, from: string, to: string): boolean {
  try { parseCompletionGraph({ ...graph, links: [...graph.links, { id: randomId(), from, to }] }); return true } catch { return false }
}
export function completionIssues(graph: CompletionGraph, goals: readonly ProgressGoal[]): string[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node])), visited = new Set<string>(), issues: string[] = []
  const pending = graph.nodes.filter(node => node.type === 'output').map(node => node.id)
  while (pending.length) {
    const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id)
    const node = byId.get(id)!, inputs = graph.links.filter(link => link.to === id)
    if (node.type === 'goal') { if (!goals.some(goal => goal.id === node.goalId)) issues.push('完成树中有未选择或已删除的目标引用') }
    else {
      const expected = node.type === 'logic' && node.op === 'xor' ? 2 : 1
      if (inputs.length < expected) issues.push(node.type === 'output' ? '请连接完成输出节点' : `${LOGIC_LABELS[node.op]}的输入未接完整`)
    }
    pending.push(...inputs.map(link => link.from))
  }
  return [...new Set(issues)]
}
/** null means invalid/incomplete; disconnected drafts do not participate. */
export function evaluateCompletion(graph: CompletionGraph, goals: readonly ProgressGoal[], states: ReadonlyMap<string, boolean>): boolean | null {
  if (completionIssues(graph, goals).length) return null
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const value = (id: string): boolean => {
    const node = byId.get(id)!
    if (node.type === 'goal') return states.get(node.goalId) ?? false
    const inputs = graph.links.filter(link => link.to === id).map(link => value(link.from))
    return node.type === 'output' ? inputs[0]! : node.op === 'and' ? inputs.every(Boolean) : node.op === 'or' ? inputs.some(Boolean) : node.op === 'not' ? !inputs[0] : inputs[0] !== inputs[1]
  }
  return value(graph.nodes.find(node => node.type === 'output')!.id)
}
/** Output-rooted tree, leaves on the left. Other forest components occupy a separate lower lane. */
export function layoutCompletion(graph: CompletionGraph): Record<string, Point> {
  const positions: Record<string, Point> = Object.create(null), children = new Map(graph.nodes.map(node => [node.id, graph.links.filter(link => link.to === node.id).map(link => link.from)]))
  let row = 0
  const visit = (id: string): number => {
    const list = children.get(id) ?? [], depth = list.length ? Math.max(...list.map(visit)) + 1 : 0
    const y = list.length ? list.reduce((sum, child) => sum + positions[child].y, 0) / list.length : 60 + row++ * 130
    positions[id] = { x: 60 + depth * 270, y }; return depth
  }
  const output = graph.nodes.find(node => node.type === 'output')!; visit(output.id)
  row += 1
  const sources = new Set(graph.links.map(link => link.from))
  for (const node of graph.nodes) if (!positions[node.id] && !sources.has(node.id)) visit(node.id)
  return positions
}
