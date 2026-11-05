import { useMemo, useRef, useState } from 'react'
import { NodeEditor, NodeFrame, NodeHeader, NodeField, PortLabel, type NodeViewProps, type NodeRegistry, type NodeEditorApi, type Point } from '../../nodeEditor'
import { randomId } from '../../project/crypto'
import { goalLabel, type ProgressGoal } from './progressDoc'
import type { GoalDefinition } from './goalDefinitions'
import {
  LOGIC_LABELS, SUCCESS_COLOR, FAILURE_COLOR, LOGIC_COLOR,
  canConnectCompletion, completionIssues, completionWarnings, goalAliases, inputLimit, layoutCompletion,
  type CompletionGraph, type CompletionNode, type CompletionLogic, type CompletionPort,
} from './completionGraph'
import './ProgressCompletionEditor.css'

type Data = { item: CompletionNode; goals: readonly ProgressGoal[]; definitions: readonly GoalDefinition[]; aliases: Map<string, string>; change: (node: CompletionNode) => void }
function CompletionCard({ node, selected, dragging, readOnly }: NodeViewProps) {
  const { item, goals, definitions, aliases, change } = node.data as Data
  const missing = item.type === 'goal' && !aliases.has(item.goalId)
  return <NodeFrame selected={selected} dragging={dragging} className={missing ? 'completion-node-missing' : ''}>
    <NodeHeader title={item.type === 'goal' ? `Goal · ${aliases.get(item.goalId) ?? '未关联'}` : item.type === 'output' ? '完成输出' : '逻辑'} icon={item.type === 'goal' ? '◎' : item.type === 'output' ? '▸' : '◇'} color={item.type === 'goal' ? '#796443' : item.type === 'output' ? '#536a49' : '#5a4a62'} />
    <div className="completion-node-fields">
      {item.type === 'goal' ? <NodeField label="目标"><select aria-label="引用目标" disabled={readOnly} value={aliases.has(item.goalId) ? item.goalId : ''} onChange={event => change({ ...item, goalId: event.target.value })}><option value="">{item.goalId ? '目标已删除' : '请选择目标'}</option>{goals.map(goal => <option value={goal.id} key={goal.id}>{aliases.get(goal.id)} · {goalLabel(goal, definitions)}</option>)}</select></NodeField>
        : item.type === 'logic' ? <NodeField label="运算"><select aria-label="逻辑运算" disabled={readOnly} value={item.op} onChange={event => change({ ...item, op: event.target.value as CompletionLogic })}>{Object.entries(LOGIC_LABELS).map(([op, label]) => <option key={op} value={op}>{label}</option>)}</select></NodeField>
          : <p>成功入 → 可交付；失败入 → 失败</p>}
    </div>
    {node.ports.map(port => <PortLabel key={port.id} direction={port.direction} y={port.y} color={port.color}>{port.label}</PortLabel>)}
  </NodeFrame>
}
const registry: NodeRegistry = { completion: { component: CompletionCard } }

function portsFor(item: CompletionNode) {
  if (item.type === 'goal') return [
    { id: 'output' as const, direction: 'output' as const, y: 78, label: '成功', kind: 'S', color: SUCCESS_COLOR },
    { id: 'output2' as const, direction: 'output' as const, y: 108, label: '失败', kind: 'F', color: FAILURE_COLOR },
  ]
  if (item.type === 'logic') return [
    { id: 'input' as const, direction: 'input' as const, y: 93, label: '入', kind: 'S', color: LOGIC_COLOR },
    { id: 'output' as const, direction: 'output' as const, y: 93, label: '出', kind: 'S', color: LOGIC_COLOR },
  ]
  return [
    { id: 'input' as const, direction: 'input' as const, y: 78, label: '成功入', kind: 'S', color: SUCCESS_COLOR },
    { id: 'input2' as const, direction: 'input' as const, y: 108, label: '失败入', kind: 'F', color: FAILURE_COLOR },
  ]
}

export function ProgressCompletionEditor({ graph, goals, definitions, onChange, disabled, active }: {
  graph: CompletionGraph; goals: readonly ProgressGoal[]; definitions: readonly GoalDefinition[]; disabled?: boolean; active: boolean; onChange: (graph: CompletionGraph) => void
}) {
  const [local, setLocal] = useState<Record<string, Point>>(() => layoutCompletion(graph)), [notice, setNotice] = useState('')
  const api = useRef<NodeEditorApi>(null), aliases = goalAliases(goals)
  const automatic = useMemo(() => layoutCompletion(graph), [graph])
  const commit = (next: CompletionGraph) => { if (!disabled) { setNotice(''); onChange(next) } }
  const change = (item: CompletionNode) => {
    if (item.type === 'logic' && graph.links.filter(link => link.to === item.id).length > inputLimit(item, 'input')) { setNotice(`${LOGIC_LABELS[item.op]}输入数量超限，请先断开多余连线`); return }
    commit({ ...graph, nodes: graph.nodes.map(node => node.id === item.id ? item : node) })
  }
  const add = (type: 'goal' | 'logic' | 'output', position?: Point) => {
    if (graph.nodes.length >= 512) { setNotice('最多支持 512 个完成节点'); return }
    const id = randomId()
    const item: CompletionNode = type === 'goal' ? { id, type, goalId: goals[0]?.id ?? '' } : type === 'logic' ? { id, type, op: 'and' } : { id, type }
    setLocal(previous => ({ ...automatic, ...previous, [id]: position ?? api.current?.center() ?? { x: 60, y: 60 } }))
    commit({ ...graph, nodes: [...graph.nodes, item] })
  }
  const remove = (ids: string[], links: string[]) => {
    const outputs = graph.nodes.filter(node => node.type === 'output').length
    const removed = new Set(ids.filter(id => {
      const node = graph.nodes.find(item => item.id === id)
      return node && (node.type !== 'output' || outputs > 1)
    }))
    commit({ ...graph, nodes: graph.nodes.filter(node => !removed.has(node.id)), links: graph.links.filter(link => !links.includes(link.id) && !removed.has(link.from) && !removed.has(link.to)) })
  }
  const nodes = graph.nodes.map(item => ({
    id: item.id, type: 'completion', position: Object.hasOwn(local, item.id) ? local[item.id] : automatic[item.id],
    width: 226, height: item.type === 'logic' ? 116 : 136,
    label: item.type === 'goal' ? `Goal ${aliases.get(item.goalId) ?? '未关联'}` : item.type === 'output' ? '完成输出' : LOGIC_LABELS[item.op],
    deletable: item.type !== 'output' || graph.nodes.filter(node => node.type === 'output').length > 1,
    ports: portsFor(item), data: { item, goals, definitions, aliases, change },
  }))
  const issues = completionIssues(graph, goals), warnings = completionWarnings(graph)
  const focus = graph.nodes.find(node => node.type === 'output')?.id
  return <section className="progress-completion-editor" aria-label="自定义完成节点编辑器" hidden={!active}>
    <header className="completion-toolbar">
      <span>自定义完成</span>
      <button type="button" disabled={disabled} onClick={() => add('goal')}>＋ Goal</button>
      <button type="button" disabled={disabled} onClick={() => add('logic')}>＋ 逻辑</button>
      <button type="button" disabled={disabled} onClick={() => add('output')}>＋ 完成输出</button>
      <button type="button" onClick={() => { setLocal(layoutCompletion(graph)); requestAnimationFrame(() => api.current?.fit()) }}>树形排列</button>
      <button type="button" onClick={() => api.current?.fit()}>显示全部</button>
    </header>
    <div className="completion-canvas"><NodeEditor ref={api} documentId={focus ?? graph.nodes[0]?.id ?? 'completion'} registry={registry}
      initialFocusId={[...nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)[0]?.id}
      nodes={nodes}
      edges={graph.links.map(link => ({
        id: link.id, source: link.from, target: link.to, sourcePort: link.fromPort, targetPort: link.toPort,
        kind: outcomeKind(link.fromPort, link.toPort), color: outcomeColor(link.fromPort, link.toPort),
        label: outcomeKind(link.fromPort, link.toPort) === 'F' ? '失败完成连接' : '成功完成连接',
      }))}
      active={active} readOnly={disabled} features={{ groups: false, arrange: false }}
      onMove={positions => setLocal(previous => ({ ...automatic, ...previous, ...positions }))}
      canConnect={connection => canConnectCompletion(graph, connection.source, connection.sourcePort as CompletionPort, connection.target, connection.targetPort as CompletionPort)}
      onConnect={connection => {
        const fromPort = connection.sourcePort as CompletionPort, toPort = connection.targetPort as CompletionPort
        if (canConnectCompletion(graph, connection.source, fromPort, connection.target, toPort)) {
          commit({ ...graph, links: [...graph.links, { id: randomId(), from: connection.source, fromPort, to: connection.target, toPort }] })
        }
      }}
      onDelete={selection => remove(selection.nodes, selection.edges)} onCut={ids => remove([], ids)}
      menuItems={context => context.kind === 'pane' ? [
        { label: '添加 Goal', action: () => add('goal', context.position) },
        { label: '添加逻辑', action: () => add('logic', context.position) },
        { label: '添加完成输出', action: () => add('output', context.position) },
      ] : []}
    /></div>
    <footer className="completion-footer">
      <span>{notice || issues.join('；') || warnings.join('；') || '仅完成输出上游的树参与求值 · 多输出 first-wins'}</span>
      <small>边沿结算 · 布局不保存</small>
    </footer>
  </section>
}

function outcomeKind(fromPort: CompletionPort, toPort: CompletionPort) {
  return fromPort === 'output2' || toPort === 'input2' ? 'F' : 'S'
}
function outcomeColor(fromPort: CompletionPort, toPort: CompletionPort) {
  return outcomeKind(fromPort, toPort) === 'F' ? FAILURE_COLOR : SUCCESS_COLOR
}
