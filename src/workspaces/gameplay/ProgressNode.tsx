import * as M from './model'
import * as S from './signals'
import { NodeFrame, NodeHeader, PortLabel, type NodeViewProps } from '../../nodeEditor'
import type { ProgressNodeData } from './graphAdapter'

const { getProgressNode, getPredicateNode, getTransitionNode, getEndNode, displayText } = M

export function ProgressNode({ node: view, selected, dragging }: NodeViewProps) {
  const { flow, sim, draft, resolveText, goalLabels } = view.data as ProgressNodeData
  const id = view.id
  const ports = view.ports.filter(port => port.kind !== 'association').map(port => (
    <PortLabel key={port.id} direction={port.direction} y={port.y} color={port.color}>{port.label}</PortLabel>
  ))
  const draftClass = draft ? ' is-draft' : ''
  const draftTag = draft ? <span className="flow-graph-header-tag">草稿</span> : null

  const progress = getProgressNode(flow, id)
  if (progress) {
    const state = S.progressState(sim, id)
    const start = M.isStartNode(flow, id)
    const subtitle = start
      ? displayText(progress.questTitle ?? { text: '' }, resolveText)
      : `${progress.goals.length} 个目标 · ${{all:'完成全部',any:'完成任一',custom:'自定义完成'}[progress.completion]}`
    return <NodeFrame selected={selected} dragging={dragging} data-progress-state={state} data-start={start ? 'true' : undefined} className={`flow-graph-node is-progress is-progress-${state}${start ? ' is-start' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon={start ? '▸' : '▣'} title={start ? '开始进度' : '进度'} badge={draftTag ?? <span className="flow-graph-header-tag">{S.PROGRESS_STATES[state]}</span>} />
      <span className="flow-graph-node-title" title={progress.identifier}>{progress.identifier || '未填写进度标识符'}</span>
      {subtitle && <span className="flow-graph-node-description" title={subtitle}>{subtitle}</span>}
      <div className="flow-graph-node-port-band" />
      {ports}
    </NodeFrame>
  }

  const predicate = getPredicateNode(flow, id)
  const objective = M.getObjectiveNode(flow, id)
  if (objective) {
    const state = S.objectiveState(sim, id)
    const label = goalLabels && Object.hasOwn(goalLabels,objective.goal.kind) ? goalLabels[objective.goal.kind] : objective.goal.kind
    return <NodeFrame selected={selected} dragging={dragging} data-objective-state={state} className={`flow-graph-node is-objective${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon="◎" title="目标" badge={draftTag ?? <span className="flow-graph-header-tag">{S.PROGRESS_STATES[state]}</span>} />
      <span className="flow-graph-node-title" title={objective.goal.kind}>{label || '未选择目标'}</span>
      <span className="flow-graph-node-description">Quest 级后台目标</span>
      <div className="flow-graph-node-port-band" />
      {ports}
    </NodeFrame>
  }
  if (predicate) {
    const truth = S.predicateTruth(sim, id)
    const summary = predicate.conditions.length ? `${predicate.conditions.length} 个条件` : '无条件（恒假）'
    return <NodeFrame selected={selected} dragging={dragging} data-predicate-truth={truth ? 'true' : 'false'} className={`flow-graph-node is-predicate${truth ? ' is-true' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon="⊢" title="谓词" badge={draftTag ?? <span className="flow-graph-header-tag">{truth ? '真' : '假'}</span>} />
      <span className="flow-graph-node-title">{summary}</span>
      {ports}
    </NodeFrame>
  }

  if (getTransitionNode(flow, id)) {
    const round = S.transitionRound(sim, id)
    return <NodeFrame selected={selected} dragging={dragging} className={`flow-graph-node is-transition${round.open ? ' is-waiting' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon="→" title="变迁" badge={draftTag ?? (round.open ? <span className="flow-graph-header-tag">查询中</span> : undefined)} />
      {ports}
    </NodeFrame>
  }

  const end = getEndNode(flow, id)
  if (end) {
    const outcome = S.endOutcome(sim, id)
    const title = displayText(end.title, resolveText)
    return <NodeFrame selected={selected} dragging={dragging} data-end-outcome={outcome ?? undefined} className={`flow-graph-node is-end${outcome ? ' is-reached' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon="■" title="结束" badge={draftTag ?? (outcome ? <span className="flow-graph-header-tag">{outcome === 'success' ? '成功' : '失败'}</span> : undefined)} />
      <span className="flow-graph-node-title" title={title}>{title || '未命名结局'}</span>
      <div className="flow-graph-node-port-band" />
      {ports}
    </NodeFrame>
  }

  return null
}
