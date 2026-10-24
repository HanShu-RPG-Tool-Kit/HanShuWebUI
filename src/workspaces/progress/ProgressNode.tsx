import * as M from './model'
import * as S from './signals'
import { NodeFrame, NodeHeader, PortLabel, type NodeViewProps } from '../../nodeEditor'
import { progressLinks, type ProgressNodeData } from './graphAdapter'
const {getGoalNode,getPredicateNode,getTransitionNode,getConditionalNode,getDiffNode,getMergeNode,getSwapNode,displayText,GOAL_NAMES,PREDICATE_NAMES}=M
const {ckptState,goalState,predicateState,transitionSim,CKPT_STATES,GOAL_STATES,PREDICATE_STATES}=S
export function ProgressNode({node:view,selected,dragging}:NodeViewProps){
  const {flow,sim,resolveText}=view.data as ProgressNodeData
  const id=view.id,links=progressLinks(flow),lastAccepted=[...sim.log].reverse().find(item=>item.accepted)
  const goalLinksDiff=(id:string)=>(flow.logic?.links??[]).some(link=>link.from===id&&!!getDiffNode(flow,link.to))
  if(M.getEndNode(flow,id))return <NodeFrame selected={selected} dragging={dragging} className="flow-graph-node is-end"><NodeHeader title="结束" icon="■" className="flow-graph-node-header"/><span className="flow-graph-node-title">流程终点</span><PortLabel direction="input" y={view.ports[0]?.y??59}>S 入</PortLabel></NodeFrame>
            const isEntry = id === flow.entry.id, node = isEntry ? undefined : flow.nodes[id], goal = getGoalNode(flow, id), predicate = getPredicateNode(flow, id), transition = getTransitionNode(flow, id), conditional = getConditionalNode(flow, id), diff = getDiffNode(flow, id), merge = getMergeNode(flow, id), swap = getSwapNode(flow, id)
            const runtime = node ? ckptState(sim, id) : null
            const goalRuntime = goal ? goalState(sim, id) : null
            const predicateRuntime = predicate ? predicateState(sim, id) : null
            const mergeAwait = merge ? (sim.merges[id]?.awaiting.length ?? 0) : 0
            const mergeReported = merge ? (sim.merges[id]?.reported.length ?? 0) : 0
            const transitionQuery = transition ? transitionSim(sim, id) : null
            const transitionAwait = transitionQuery?.awaiting.length ?? 0
            const transitionReported = transitionQuery?.reported.length ?? 0
            const goalIncoming = transition ? links.filter(link => link.to === id && link.port === 'input').length : 0
            const title = isEntry ? '开始' : displayText((swap ?? merge ?? diff ?? conditional ?? transition ?? predicate ?? goal ?? node)!.title, resolveText) || (swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? '未命名谓词' : goal ? '未命名目标' : '未命名阶段')
            const description = node ? displayText(node.description, resolveText) : goal ? goal.kind === 'counter' ? `${GOAL_NAMES[goal.kind]} · ${goal.params.target ?? 1}` : GOAL_NAMES[goal.kind] : predicate ? predicate.kind === 'counter' ? `${PREDICATE_NAMES[predicate.kind]} · ${predicate.params.target ?? 1}` : PREDICATE_NAMES[predicate.kind] : ''
            const pulsed = lastAccepted && (lastAccepted.to === id || lastAccepted.from === id) && sim.pulse > 0
            const isSignalSource = isEntry || (goal && goalRuntime === 'subscribed') || (predicate && predicateRuntime === 'subscribed')
            const goalDiff = goal ? goalLinksDiff(id) : false
            const kindLabel = swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? `Predicate · ${PREDICATE_STATES[predicateRuntime!]}${predicateRuntime === 'subscribed' ? '；Ctrl+点击发出 P' : ''}` : goal ? `Goal · ${GOAL_STATES[goalRuntime!]}${goalRuntime === 'subscribed' ? (goalDiff ? '；Ctrl+G-Y · Ctrl+Shift+G-N' : '；Ctrl+点击发出 G') : ''}` : `checkpoint · ${CKPT_STATES[runtime!]}`

  return <NodeFrame selected={selected} dragging={dragging} data-ckpt-state={runtime??undefined} data-goal-state={goalRuntime??undefined} data-predicate-state={predicateRuntime??undefined}
    className={`flow-graph-node${isEntry?' is-entry':''}${isSignalSource?' is-signal-source':''}${goal?` is-goal is-goal-${goalRuntime}`:''}${predicate?` is-predicate is-predicate-${predicateRuntime}`:''}${transition?' is-transition':''}${conditional?' is-conditional':''}${diff?' is-diff':''}${merge?' is-merge':''}${swap?' is-swap':''}${node?` is-ckpt is-ckpt-${runtime}`:''}${selected?' is-selected':''}${pulsed?' is-sim-pulse':''}${dragging?' is-dragging':''}`} style={{left:0,top:0,width:'100%',height:'100%'}} title={`${id} · ${kindLabel}`}>
              <NodeHeader className="flow-graph-node-header" icon={isEntry ? '▸' : swap ? '⇄' : merge ? '⇉' : diff ? '⇅' : conditional ? '?' : transition ? '→' : predicate ? '⊢' : goal ? '◎' : '◇'} title={isEntry ? '开始' : swap ? '交换变迁' : merge ? '合并变迁' : diff ? '差分变迁' : conditional ? '条件变迁' : transition ? '线性变迁' : predicate ? 'Predicate' : goal ? 'Goal' : 'Checkpoint'} badge={isEntry ? <svg className="flow-graph-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="7" width="8" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 016 0v2" /></svg> : runtime ? <span className="flow-graph-header-tag">{CKPT_STATES[runtime]}</span> : goalRuntime ? <span className="flow-graph-header-tag">{GOAL_STATES[goalRuntime]}</span> : predicateRuntime ? <span className="flow-graph-header-tag">{PREDICATE_STATES[predicateRuntime]}</span> : swap ? <span className="flow-graph-header-tag">{swap.entries} 槽</span> : merge ? <span className="flow-graph-header-tag">{mergeAwait ? `C-R ${mergeReported}/${mergeAwait}` : '多→1'}</span> : diff ? <span className="flow-graph-header-tag">Y/N</span> : conditional ? <span className="flow-graph-header-tag">P·P→N</span> : transition ? <span className="flow-graph-header-tag">{transitionAwait ? `C-R ${transitionReported}/${transitionAwait}` : goalIncoming > 1 ? `G∧${goalIncoming}` : 'G·P→N'}</span> : null} />
              <span className="flow-graph-node-title">{isEntry ? '信号源 · S' : goal && goalRuntime === 'subscribed' ? `${title} · ${goalDiff ? '可发 G-Y / G-N' : '可发 G'}` : predicate && predicateRuntime === 'subscribed' ? `${title} · 可发 P` : title}</span>
              {view.ports.map(port=><PortLabel key={port.id} direction={port.direction} y={port.y} color={port.color}>{port.label}</PortLabel>)}
              {node && <span className={`flow-graph-node-description${description ? '' : ' is-empty'}`}>{description || '双击编辑'}</span>}
              {(goal || predicate) && description && <span className="flow-graph-node-description">{description}</span>}

  </NodeFrame>
}
