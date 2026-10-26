import * as M from './model'
import * as S from './signals'
import { NodeFrame, NodeHeader, PortLabel, type NodeViewProps } from '../../nodeEditor'
import type { ProgressNodeData } from './graphAdapter'

const { getProgressNode, getPredicateNode, getTransitionNode, getEndNode, displayText } = M

export function ProgressNode({ node: view, selected, dragging }: NodeViewProps) {
  const { flow, sim, draft, resolveText } = view.data as ProgressNodeData
  const id = view.id
  const ports = view.ports.map(port => (
    <PortLabel key={port.id} direction={port.direction} y={port.y} color={port.color}>{port.label}</PortLabel>
  ))
  const draftClass = draft ? ' is-draft' : ''
  const draftTag = draft ? <span className="flow-graph-header-tag">草稿</span> : null

  const progress = getProgressNode(flow, id)
  if (progress) {
    const state = S.progressState(sim, id)
    const start = M.isStartNode(flow, id)
    const subtitle = start
      ? displayText(progress.questTitle ?? progress.title, resolveText)
      : displayText(progress.runningLog, resolveText)
    return <NodeFrame selected={selected} dragging={dragging} data-progress-state={state} data-start={start ? 'true' : undefined} className={`flow-graph-node is-progress is-progress-${state}${start ? ' is-start' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon={start ? '▸' : '▣'} title={start ? '开始进度' : '进度'} badge={draftTag ?? <span className="flow-graph-header-tag">{S.PROGRESS_STATES[state]}</span>} />
      <span className="flow-graph-node-title">{displayText(progress.title, resolveText) || (start ? '开始进度' : '未命名进度')}</span>
      <span className={`flow-graph-node-description${subtitle ? '' : ' is-empty'}`}>{subtitle || (start ? '双击编辑任务信息' : '双击编辑')}</span>
      {ports}
    </NodeFrame>
  }

  const predicate = getPredicateNode(flow, id)
  if (predicate) {
    const truth = S.predicateTruth(sim, id)
    const summary = predicate.conditions.length ? `${predicate.conditions.length} 个条件` : '无条件（恒假）'
    return <NodeFrame selected={selected} dragging={dragging} data-predicate-truth={truth ? 'true' : 'false'} className={`flow-graph-node is-predicate${truth ? ' is-true' : ''}${draftClass}`}>
      <NodeHeader className="flow-graph-node-header" icon="⊢" title="谓词" badge={draftTag ?? <span className="flow-graph-header-tag">{truth ? '真' : '假'}</span>} />
      <span className="flow-graph-node-title">{displayText(predicate.title, resolveText) || '未命名谓词'}</span>
      <span className="flow-graph-node-description">{summary}</span>
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
      <span className="flow-graph-node-title">{title || '未命名结局'}{end.rewardKits.length > 0 ? ` · ${end.rewardKits.length} 奖励` : ''}</span>
      {ports}
    </NodeFrame>
  }

  return null
}
