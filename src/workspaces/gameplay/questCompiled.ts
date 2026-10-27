import { parseJsonValue } from '../../utils/strictJson'
import { completionIssues, type CompletionGraph, type CompletionLogic } from './completionGraph'
import {
  FLOW_LIMITS, compareIds, connectedToStart, inputPorts, outputPorts, orderedLinks, linkSourcePort,
  getProgressNode, getPredicateNode, getObjectiveNode, getTransitionNode, getEndNode,
  isObject, parseFlowSubmission, flowSubmissionIssue, type Data, type FlowInputPort, type FlowOutputPort,
  type FlowSubmission, type FlowProgressGoal, type ProgressFlow,
} from './model'
import type { ProgressConditionRule } from './conditions'
import { parseConditionRules } from './conditions'
import { PROGRESS_REPEAT_LABELS, type ProgressDocument } from './progressDoc'

export const QUEST_COMPILED_FORMAT = 'hanshu.questc'
export const QUEST_COMPILED_EXT = '.questc'
export type QuestPointer = { node: string; port: FlowInputPort | FlowOutputPort }
export type CompletionExpression = { type: 'goal'; goalId: string } | { type: 'logic'; op: CompletionLogic; inputs: CompletionExpression[] }
type Connections = {
  inputs: Partial<Record<FlowInputPort, QuestPointer[]>>
  outputs: Partial<Record<FlowOutputPort, QuestPointer[]>>
}
export type QuestCompiledNode = Connections & (
  | { type: 'progress'; identifier: string; runningLog: string; completedLog: string; goals: FlowProgressGoal[]; completion: 'all' | 'any' | 'custom'; completionExpression?: CompletionExpression; submission?: FlowSubmission }
  | { type: 'condition'; identifier?: string; conditions: ProgressConditionRule[] }
  | { type: 'objective'; identifier: string; goal: { kind: string; params: Data }; submission?: FlowSubmission }
  | { type: 'logic' }
  | { type: 'end'; title: string; rewardKits: string[] }
)
export type QuestCompiled = {
  format: typeof QUEST_COMPILED_FORMAT
  version: 1
  metadata: { title: string; description: string } & Partial<Pick<ProgressDocument, 'tags' | 'visibility' | 'acceptance' | 'abandonable' | 'autoStartWhenAcceptable' | 'repeat'>>
  start: string
  nodes: Record<string, QuestCompiledNode>
}

function compileCompletion(graph: CompletionGraph, goals: FlowProgressGoal[]): CompletionExpression {
  const issues = completionIssues(graph, goals.map(goal => ({ ...goal, config: goal.params as Record<string, string | number | boolean> })))
  if (issues.length) throw new Error(issues.join('；'))
  const visit = (id: string): CompletionExpression => {
    const node = graph.nodes.find(item => item.id === id)!
    if (node.type === 'goal') return { type: 'goal', goalId: node.goalId }
    const children = graph.links.filter(link => link.to === id).map(link => visit(link.from))
    return node.type === 'output' ? children[0] : { type: 'logic', op: node.op, inputs: children }
  }
  return visit(graph.nodes.find(node => node.type === 'output')!.id)
}

/** Project a validated authoring graph. No author ID, edge table, layout or runtime state escapes. */
export function compileQuestFlow(flow: ProgressFlow): QuestCompiled {
  const effective = connectedToStart(flow), nodes: Record<string, QuestCompiledNode> = Object.create(null)
  const ids = [...Object.keys(flow.progress), ...Object.keys(flow.predicates ?? {}), ...Object.keys(flow.objectives ?? {}), ...Object.keys(flow.transitions ?? {}), ...Object.keys(flow.ends ?? {})].filter(id => effective.has(id)).sort(compareIds)
  for (const id of ids) {
    const inputs = Object.fromEntries(inputPorts(flow, id).map(port => [port, []]))
    const outputs = Object.fromEntries(outputPorts(flow, id).map(port => [port, []]))
    const progress = getProgressNode(flow, id), condition = getPredicateNode(flow, id), objective = getObjectiveNode(flow, id), end = getEndNode(flow, id)
    if (progress) nodes[id] = {
      type: 'progress', identifier: progress.identifier, runningLog: progress.runningLog.text, completedLog: progress.completedLog.text,
      goals: progress.goals.map(goal => ({ id: goal.id, kind: goal.kind, params: structuredClone(goal.params) })), completion: progress.completion,
      ...(progress.completion === 'custom' ? { completionExpression: compileCompletion(progress.completionGraph!, progress.goals) } : {}),
      ...(progress.submission ? { submission: structuredClone(progress.submission) } : {}), inputs, outputs,
    }
    else if (condition) nodes[id] = { type: 'condition', ...(condition.identifier ? { identifier: condition.identifier } : {}), conditions: structuredClone(condition.conditions), inputs, outputs }
    else if (objective) nodes[id] = { type: 'objective', identifier: objective.identifier, goal: structuredClone(objective.goal), ...(objective.submission ? { submission: structuredClone(objective.submission) } : {}), inputs, outputs }
    else if (getTransitionNode(flow, id)) nodes[id] = { type: 'logic', inputs, outputs }
    else if (end) nodes[id] = { type: 'end', title: end.title.text, rewardKits: [...end.rewardKits], inputs, outputs }
  }
  for (const link of orderedLinks(flow)) if (effective.has(link.from) && effective.has(link.to)) {
    nodes[link.from].outputs[linkSourcePort(flow, link.from, link.fromPort)]!.push({ node: link.to, port: link.port })
  }
  for (const link of orderedLinks(flow, true)) if (effective.has(link.from) && effective.has(link.to)) {
    nodes[link.to].inputs[link.port]!.push({ node: link.from, port: linkSourcePort(flow, link.from, link.fromPort) })
  }
  const start = getProgressNode(flow, flow.start)!
  const compiled: QuestCompiled = { format: QUEST_COMPILED_FORMAT, version: 1, metadata: { title: start.questTitle?.text ?? '', description: start.description?.text ?? '' }, start: flow.start, nodes }
  return parseQuestCompiled(JSON.stringify(compiled))
}

/** Both authoring styles have one runtime format; no hanshuSimpleQuest compatibility payload. */
export function compileSimpleQuest(doc: ProgressDocument): QuestCompiled {
  const start = 'progress_start', success = 'end_success', failure = 'end_failure'
  const progress = {
    identifier: 'start', runningLog: { text: '' }, completedLog: { text: '' },
    goals: doc.goals.map(goal => ({ id: goal.id, kind: goal.kind, params: { ...goal.config } })), completion: doc.completion,
    ...(doc.completionGraph ? { completionGraph: doc.completionGraph } : {}), questTitle: { text: doc.name }, description: { text: doc.description },
  }
  const flow: ProgressFlow = {
    format: 'hanshu.progress-tree', version: 1, id: doc.id, start, progress: { [start]: progress },
    ends: { [success]: { title: { text: '' }, rewardKits: [...doc.rewardKits] }, [failure]: { title: { text: '' }, rewardKits: [] } },
    logic: { links: [{ id: 'success', from: start, fromPort: 'output', to: success, port: 'input' }, { id: 'failure', from: start, fromPort: 'output2', to: failure, port: 'input2' }] },
  }
  const compiled = compileQuestFlow(flow)
  compiled.metadata = { ...compiled.metadata, tags: [...doc.tags], visibility: structuredClone(doc.visibility), acceptance: structuredClone(doc.acceptance), abandonable: doc.abandonable, autoStartWhenAcceptable: doc.autoStartWhenAcceptable, repeat: structuredClone(doc.repeat) }
  return compiled
}

/** Boundary check for the compiled pointer graph, also used on compiler output. */
export function parseQuestCompiled(source: string): QuestCompiled {
  const value = parseJsonValue(source)
  function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`questc：${message}`) }
  check(isObject(value) && value.format === QUEST_COMPILED_FORMAT && value.version === 1, '格式或版本不支持')
  check(Object.keys(value).every(key => ['format', 'version', 'metadata', 'start', 'nodes'].includes(key)), '不能携带任务 ID、边表或编辑器数据')
  check(isObject(value.metadata) && typeof value.metadata.title === 'string' && typeof value.metadata.description === 'string', '缺少任务元信息')
  const metadata = value.metadata
  check(Object.keys(metadata).every(key => ['title','description','tags','visibility','acceptance','abandonable','autoStartWhenAcceptable','repeat'].includes(key)), '元信息含非运行字段')
  if (metadata.tags !== undefined) check(Array.isArray(metadata.tags) && metadata.tags.every(tag => typeof tag === 'string'), '标签无效')
  for (const key of ['abandonable','autoStartWhenAcceptable']) if (metadata[key] !== undefined) check(typeof metadata[key] === 'boolean', `${key} 无效`)
  for (const key of ['visibility','acceptance']) if (metadata[key] !== undefined) parseConditionRules(metadata[key], key, key === 'visibility')
  if (metadata.repeat !== undefined) check(isObject(metadata.repeat) && Object.hasOwn(PROGRESS_REPEAT_LABELS, String(metadata.repeat.kind)) && typeof metadata.repeat.hours === 'number' && Number.isFinite(metadata.repeat.hours) && metadata.repeat.hours > 0, '重复策略无效')
  check(isObject(value.nodes) && typeof value.start === 'string' && Object.hasOwn(value.nodes, value.start), '开始节点不存在')
  const nodes = value.nodes as Record<string, QuestCompiledNode>, start = value.start
  check(Object.keys(nodes).length <= FLOW_LIMITS.nodes && isObject(nodes[start]) && nodes[start].type === 'progress', '节点数量超限或开始节点不是进度')
  const names = new Set<string>()
  const stableId = (id: unknown) => typeof id === 'string' && id.trim().length > 0 && id.length <= 200 && !['__proto__','prototype','constructor'].includes(id)
  const goalShape = (goal: unknown, embedded: boolean) => isObject(goal) && Object.keys(goal).every(key => ['kind','params',...(embedded ? ['id'] : [])].includes(key)) && (!embedded || stableId(goal.id)) && typeof goal.kind === 'string' && isObject(goal.params) && Object.values(goal.params).every(param => typeof param === 'string' || typeof param === 'boolean' || typeof param === 'number' && Number.isFinite(param))
  for (const [id, node] of Object.entries(nodes)) {
    check(stableId(id), '节点 ID 无效')
    check(isObject(node) && ['progress', 'condition', 'objective', 'logic', 'end'].includes(node.type), `节点 ${id} 类型无效`)
    const fields = node.type === 'progress' ? ['identifier','runningLog','completedLog','goals','completion','completionExpression','submission'] : node.type === 'condition' ? ['identifier','conditions'] : node.type === 'objective' ? ['identifier','goal','submission'] : node.type === 'end' ? ['title','rewardKits'] : []
    check(Object.keys(node).every(key => ['type','inputs','outputs',...fields].includes(key)), `节点 ${id} 含非运行字段`)
    if (node.type === 'progress' || node.type === 'objective' || node.type === 'condition' && node.identifier !== undefined) {
      const name = node.identifier
      check(typeof name === 'string' && name.trim() && name === name.trim() && !/[\r\n\t]/.test(name) && name.length <= 200 && !names.has(name), `节点 ${id} 标识符无效或重复`)
      names.add(name)
    }
    if ('submission' in node && node.submission !== undefined) {
      parseFlowSubmission(node.submission, `nodes.${id}.submission`)
      check(!flowSubmissionIssue(node.submission), `节点 ${id} 提交配置无效`)
    }
    if (node.type === 'progress') {
      check(typeof node.runningLog === 'string' && typeof node.completedLog === 'string' && Array.isArray(node.goals) && node.goals.every(goal => goalShape(goal, true)), `进度 ${id} 内容无效`)
      const goals = new Set(node.goals.map(goal => goal.id))
      check(goals.size === node.goals.length && ['all','any','custom'].includes(node.completion), `进度 ${id} 目标 ID 或完成规则无效`)
      let count = 0
      const expression = (raw: unknown): void => {
        check(++count <= 512 && isObject(raw), `进度 ${id} 完成表达式无效或超限`)
        if (raw.type === 'goal') check(Object.keys(raw).length === 2 && typeof raw.goalId === 'string' && goals.has(raw.goalId), `进度 ${id} 完成表达式引用不存在的目标`)
        else {
          check(raw.type === 'logic' && Object.keys(raw).length === 3 && ['and','or','not','xor'].includes(String(raw.op)) && Array.isArray(raw.inputs), `进度 ${id} 完成表达式无效`)
          check(raw.op === 'not' ? raw.inputs.length === 1 : raw.op === 'xor' ? raw.inputs.length === 2 : raw.inputs.length >= 1, `进度 ${id} 完成表达式输入数量无效`)
          raw.inputs.forEach(expression)
        }
      }
      if (node.completion === 'custom') expression(node.completionExpression)
      else check(node.completionExpression === undefined, `进度 ${id} 非自定义规则不能带表达式`)
    }
    else if (node.type === 'objective') check(goalShape(node.goal, false), `目标 ${id} 内容无效`)
    else if (node.type === 'condition') parseConditionRules(node.conditions, `nodes.${id}.conditions`, true)
    else if (node.type === 'end') check(typeof node.title === 'string' && Array.isArray(node.rewardKits) && node.rewardKits.every(kit => typeof kit === 'string' && kit.trim()) && new Set(node.rewardKits).size === node.rewardKits.length, `结束节点 ${id} 内容无效`)
    check(isObject(node.inputs) && isObject(node.outputs), `节点 ${id} 缺少端口列表`)
    const ins = node.type === 'progress' ? id === start ? [] : ['input'] : ['logic','end'].includes(node.type) ? ['input','input2'] : []
    const outs = ['progress','objective'].includes(node.type) ? ['output','output2'] : ['logic','condition'].includes(node.type) ? ['output'] : []
    for (const [side, ports] of [[node.inputs, ins], [node.outputs, outs]] as const) {
      check(Object.keys(side).length === ports.length && ports.every(port => Object.hasOwn(side, port)), `节点 ${id} 端口不正确`)
      for (const list of Object.values(side)) {
        check(Array.isArray(list) && list.length <= FLOW_LIMITS.fanout, `节点 ${id} 连接列表无效或超限`)
        const seen = new Set<string>()
        for (const pointer of list) {
          check(isObject(pointer) && Object.keys(pointer).length === 2 && typeof pointer.node === 'string' && typeof pointer.port === 'string' && Object.hasOwn(nodes, pointer.node), `节点 ${id} 指针悬空或格式错误`)
          const key = JSON.stringify([pointer.node,pointer.port]); check(!seen.has(key), `节点 ${id} 重复连接`); seen.add(key)
        }
      }
    }
  }
  let links = 0
  for (const [id, node] of Object.entries(nodes)) for (const direction of ['inputs','outputs'] as const) {
    for (const [port, pointers] of Object.entries(node[direction])) for (const pointer of pointers) {
      const other = nodes[pointer.node], opposite = direction === 'inputs' ? 'outputs' : 'inputs'
      const list = (other[opposite] as Record<string, QuestPointer[]>)[pointer.port]
      check(list?.some(back => back.node === id && back.port === port), `节点 ${id} 指针两端不一致`)
      if (direction === 'outputs') links++
    }
  }
  check(links <= FLOW_LIMITS.links, '连接总数超限')
  const effective = new Set([start]), pending = [start]
  for (let index = 0; index < pending.length; index++) for (const side of [nodes[pending[index]].inputs, nodes[pending[index]].outputs]) for (const list of Object.values(side)) for (const pointer of list) {
    if (!effective.has(pointer.node)) { effective.add(pointer.node); pending.push(pointer.node) }
  }
  check(effective.size === Object.keys(nodes).length, '不能包含未与开始节点联通的草稿')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    check(!visiting.has(id), '节点连接成环')
    if (visited.has(id)) return
    visiting.add(id)
    for (const list of Object.values(nodes[id].outputs)) for (const pointer of list) visit(pointer.node)
    visiting.delete(id); visited.add(id)
  }
  for (const id of Object.keys(nodes)) visit(id)
  return value as QuestCompiled
}
