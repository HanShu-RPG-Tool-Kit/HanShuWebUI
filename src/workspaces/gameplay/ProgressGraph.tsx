import { useEffect, useMemo, useRef, useState } from 'react'
import * as M from './model'
import * as S from './signals'
import { signalStop, type SignalBreakpoints } from './signalDebugging'
import { SignalDebugger } from './SignalDebugger'
import type { CanvasNodeType, FlowCanvasNote, FlowInputPort, FlowOutputPort, FlowPosition, ProgressFlow, FlowSelection } from './model'
import { NodeEditor, NoteNode } from '../../nodeEditor'
import { NodeContextMenu } from '../../nodeEditor/ContextMenu'
import type { EditorEdge, EditorSelection, MenuContext, MenuItem, NodeEditorApi, NodeRegistry, NodeViewProps } from '../../nodeEditor'
import { progressEdges, progressNodes, nodeSelection, edgeSelection } from './graphAdapter'
import { ProgressNode } from './ProgressNode'
import { NodeFormView, type NodeFormKind } from './NodeFormView'
import { localizedGoalDefinitionLabel, type GoalDefinition } from './goalDefinitions'
import './ProgressGraph.css'
import './NodeFormView.css'

export type ProgressGraphKitOption = { ref: string; label: string }

function FormNode({ node: view }: NodeViewProps) {
  const data = view.data as {
    flow: ProgressFlow; nodeId: string; kind: NodeFormKind; definitions: readonly GoalDefinition[]
    kitOptions: readonly ProgressGraphKitOption[]; resolveText?: (key: string) => string | null
    setText?: (key: string, value: string) => void; onChange: (flow: ProgressFlow) => void
    onClose: () => void; onActivate: () => void; onResize: (size: { width: number; height: number }, reveal?: boolean) => void; active: boolean; disabled: boolean
  }
  return <NodeFormView {...data} />
}

const registry: NodeRegistry = { progress: { component: ProgressNode }, form: { component: FormNode }, note: { component: NoteNode } }

const FORM_PREFIX = 'form:'
const FORM_WIDTH = 760
const FORM_HEIGHT = 540
const ASSOCIATION_PORT = '__form_association__'

export function ProgressGraph({ flow, selection, onSelect, onCreate, onChangeFlow, onMove, onGroup, onUngroup, onRenameGroup, onDelete, onDeleteMany, onArrange, onUpdateNote, onConnect, onDisconnect, onCut, definitions, kitOptions = [], active, disabled = false, resolveText, setText }: {
  flow: ProgressFlow; selection: FlowSelection; onSelect: (selection: FlowSelection) => void
  onCreate: (position: FlowPosition, operator?: CanvasNodeType) => void
  onChangeFlow: (flow: ProgressFlow) => void
  onMove: (positions: Record<string, FlowPosition>) => void
  onGroup: (ids: string[]) => string | null; onUngroup: (id: string) => void; onRenameGroup: (id: string, name: string) => void
  onUpdateNote: (id: string, patch: Partial<FlowCanvasNote>) => void
  onDelete: (id: string) => void
  onDeleteMany: (ids: string[], disconnect?: FlowSelection[]) => void; onArrange: (ids: string[]) => void
  onConnect: (from: string, to: string, port: FlowInputPort, fromPort?: FlowOutputPort) => void; onDisconnect: (selection: FlowSelection) => void; onCut: (selections: FlowSelection[]) => void
  definitions: readonly GoalDefinition[]
  kitOptions?: readonly ProgressGraphKitOption[]
  active: boolean; disabled?: boolean
  resolveText?: (key: string) => string | null
  setText?: (key: string, value: string) => void
}) {
  const api = useRef<NodeEditorApi>(null)
  const [sim, setSim] = useState(() => S.createSimState(flow))
  const [playing, setPlaying] = useState(false)
  const [autoPlay, setAutoPlay] = useState(true)
  const [duration, setDuration] = useState(600)
  const [debugGeneration, setDebugGeneration] = useState(0)
  const [breakpoints, setBreakpoints] = useState<SignalBreakpoints>({nodes:[],links:[]})
  const [runTo, setRunTo] = useState<string | null>(null)
  const [skipTrace, setSkipTrace] = useState<number | null>(null)
  const [stopReason, setStopReason] = useState('')
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const stop = signalStop(sim,breakpoints,runTo)
  const stopped = stop && stop.traceId !== skipTrace
  const toggleBreakpoint = (kind: 'nodes' | 'links', id: string) => setBreakpoints(previous=>({...previous,[kind]:previous[kind].includes(id)?previous[kind].filter(value=>value!==id):[...previous[kind],id]}))
  const play = () => {
    if (playing) {setPlaying(false);return}
    setStopReason(''); setSkipTrace(stop && stop.traceId===pausedAt ? stop.traceId : null);setPausedAt(null); setPlaying(true)
  }
  const step = () => {setPlaying(false);setSkipTrace(null);setPausedAt(null);setStopReason('');setSim(previous=>S.stepSignal(flow,previous))}
  const runUntil = (id: string) => {setRunTo(id);setSkipTrace(null);setPausedAt(null);setStopReason('');setPlaying(true)}
  const locked = sim.initialized || !!sim.fault
  const eventDisabled = disabled || !active || !S.canTrigger(sim)
  const flight = useRef({ key: '', elapsed: 0 })
  const previousFlow = useRef(flow)
  const flightKey = `${sim.pulse}:${sim.execution?.processed ?? sim.log.length}:${sim.queue[0]?.link ?? ''}`
  useEffect(() => {
    if (!playing || disabled || !active || !sim.queue.length) return
    if (stopped) {
      setPlaying(false);setPausedAt(stop.traceId);setStopReason(stop.reason === 'target' ? '已到达目标节点，尚未处理该信号' : stop.reason === 'node' ? '命中节点断点，尚未处理该信号' : '命中连线断点，尚未处理该信号')
      if (stop.reason === 'target') setRunTo(null)
      return
    }
    if (flight.current.key !== flightKey) flight.current = { key: flightKey, elapsed: 0 }
    const started = performance.now()
    const timer = window.setTimeout(() => { flight.current.elapsed = 0; setSim(previous => S.stepSignal(flow, previous)) }, Math.max(0, duration - flight.current.elapsed))
    return () => { window.clearTimeout(timer); flight.current.elapsed += performance.now() - started }
  }, [playing, disabled, active, sim.queue.length, flightKey, duration, flow, stopped, stop?.traceId, stop?.reason])
  useEffect(() => {
    if (!sim.queue.length || disabled || !active) setPlaying(false)
    if (!sim.queue.length && runTo) {
      if (!sim.outcome && !sim.fault) setStopReason('本轮传播已结束，未到达目标节点')
      setRunTo(null)
    }
  }, [sim.queue.length, disabled, active, runTo, sim.outcome, sim.fault])
  const [localSelection, setLocalSelection] = useState<EditorSelection>({ nodes: [], edges: [] })
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number; position: FlowPosition } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [toolsExpanded, setToolsExpanded] = useState(false)
  /** 打开的表单视图：节点 ID → 视图位置（会话内，不写文档） */
  const [forms, setForms] = useState<Record<string, FlowPosition>>({})
  const [formSizes, setFormSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [activeFormId, setActiveFormId] = useState<string | null>(null)

  useEffect(() => {
    if (previousFlow.current !== flow) {
      const prior = previousFlow.current
      const changedDocument = prior.id !== flow.id
      previousFlow.current = flow
      if (JSON.stringify(prior) === JSON.stringify(flow)) return
      setDebugGeneration(value=>value+1);setSim(S.createSimState(flow)); setPlaying(false); setRunTo(null);setSkipTrace(null);setPausedAt(null);setStopReason('')
      setBreakpoints(previous=>changedDocument?{nodes:[],links:[]}:{nodes:previous.nodes.filter(id=>M.hasContentNode(flow,id)),links:previous.links.filter(id=>flow.logic?.links.some(link=>link.id===id))})
      if (changedDocument) { setLocalSelection({ nodes: [], edges: [] }); setCreateMenu(null); setForms({}); setFormSizes({}); setActiveFormId(null) }
    }
  }, [flow])
  useEffect(() => {
    setForms(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => M.hasContentNode(flow, id))))
  }, [flow])

  const nodeKind = (id: string): NodeFormKind | null => M.getProgressNode(flow, id) ? 'progress' : M.getPredicateNode(flow, id) ? 'predicate' : M.getObjectiveNode(flow, id) ? 'objective' : M.getEndNode(flow, id) ? 'end' : null
  const openForm = (id: string) => {
    if (disabled || locked) return
    const kind = nodeKind(id)
    if (!kind) return
    setActiveFormId(id)
    if (!Object.hasOwn(forms, id)) setForms(previous => {
      const base = layoutPosition(id)
      return { ...previous, [id]: { x: base.x + 260, y: base.y } }
    })
    requestAnimationFrame(() => requestAnimationFrame(() => api.current?.reveal(`${FORM_PREFIX}${id}`)))
  }
  const closeForm = (id: string) => {
    setForms(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))
    setActiveFormId(previous => previous === id ? null : previous)
  }

  const nodes = useMemo(() => {
    const base = progressNodes(flow, sim, onUpdateNote, resolveText, Object.fromEntries(definitions.map(definition=>[definition.kind,localizedGoalDefinitionLabel(definition,'zh_cn')]))).map(node=>{
      const formPosition=forms[node.id]
      const formOnRight=formPosition ? formPosition.x >= node.position.x + node.width / 2 : true
      return {...node, ports: formPosition ? [...node.ports, { id: ASSOCIATION_PORT, direction: 'output' as const, side: formOnRight ? 'right' as const : 'left' as const, y: node.height / 2, label: '关联表单', kind: 'association' }] : node.ports, draggable: !locked, readOnly: locked, className: `${node.className ?? ''}${breakpoints.nodes.includes(node.id)?' flow-sim-breakpoint':''}${runTo===node.id?' flow-sim-run-target':''}`}
    })
    const formsNodes = Object.entries(forms).map(([nodeId, position]) => {
      const kind = nodeKind(nodeId)
      const size = formSizes[nodeId] ?? { width: FORM_WIDTH, height: FORM_HEIGHT }
      return {
        id: `${FORM_PREFIX}${nodeId}`,
        type: 'form',
        position,
        ...size,
        ports: [{ id: ASSOCIATION_PORT, direction: 'input' as const, side: position.x >= layoutPosition(nodeId).x + 108 ? 'left' as const : 'right' as const, y: size.height / 2, label: '关联节点', kind: 'association' }],
        deletable: false,
        dragHandle: '.node-form-header',
        label: `表单 ${nodeId}`,
        className: activeFormId === nodeId ? 'is-active-form' : undefined,
        data: { flow, nodeId, kind, definitions, kitOptions, resolveText, setText: locked ? undefined : setText, active: activeFormId === nodeId, disabled: disabled || locked, onActivate: () => setActiveFormId(nodeId), onResize: (size: { width: number; height: number }, reveal?: boolean) => { setFormSizes(previous => ({ ...previous, [nodeId]: size })); if (reveal) requestAnimationFrame(() => requestAnimationFrame(() => api.current?.reveal(`${FORM_PREFIX}${nodeId}`))) }, onChange: locked ? () => {} : onChangeFlow, onClose: () => closeForm(nodeId) },
      }
    }).filter(node => node.data.kind !== null)
    return [...base, ...formsNodes]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sim, forms, formSizes, activeFormId, definitions, kitOptions, disabled, locked, breakpoints.nodes, runTo, resolveText, setText, onChangeFlow, onUpdateNote])
  const delivery = sim.queue[0]
  const edges = useMemo(() => progressEdges(flow, delivery ? { delivery, key: sim.queue.length ? flightKey : `last:${sim.pulse}:${sim.log.length}`, durationMs: duration || 1, running: active && playing && !stopped } : undefined).map(edge=>({...edge,kind:breakpoints.links.includes(edge.id.slice(6))?'breakpoint':edge.kind})), [breakpoints.links, stopped, flow, delivery, flightKey, duration, active, playing, sim.queue.length, sim.pulse, sim.log.length])
  const formEdges = useMemo<EditorEdge[]>(() => Object.keys(forms).filter(id => M.hasContentNode(flow, id)).map(id => ({ id: `association:${id}`, source: id, target: `${FORM_PREFIX}${id}`, sourcePort: ASSOCIATION_PORT, targetPort: ASSOCIATION_PORT, kind: activeFormId === id ? 'association-active' : 'association', color: '#65c7f2', label: '节点关联表单' })), [forms, flow, activeFormId])
  const groups = useMemo(() => Object.entries(flow.layout?.groups ?? {}).map(([id, group], i) => ({ id, name: group.name?.trim() || `Group ${i + 1}`, nodes: group.nodes })), [flow.layout?.groups])
  const graphSelection: EditorSelection = selection.kind === 'flow' ? localSelection
    : selection.kind === 'logic-link' ? { nodes: [], edges: [`logic:${selection.id}`] }
      : { nodes: [selection.id], edges: [] }

  function layoutPosition(id: string): FlowPosition {
    return flow.layout?.positions[id] ?? { x: 80, y: 80 }
  }

  const moveNodes = (positions: Record<string, FlowPosition>) => {
    if (locked) return
    const formPositions: Record<string, FlowPosition> = {}
    const itemPositions: Record<string, FlowPosition> = {}
    for (const [id, position] of Object.entries(positions)) {
      if (id.startsWith(FORM_PREFIX)) formPositions[id.slice(FORM_PREFIX.length)] = position
      else itemPositions[id] = position
    }
    if (Object.keys(formPositions).length) setForms(previous => ({ ...previous, ...formPositions }))
    if (Object.keys(itemPositions).length) onMove(itemPositions)
  }

  const trigger = (update: (previous: S.FlowSimState) => S.FlowSimState) => {
    if (eventDisabled) return
    const next = update(sim)
    if (next === sim) return
    setStopReason('');setPausedAt(null);setSkipTrace(null);setSim(next)
    setPlaying(autoPlay && S.isBusy(next))
  }
  const initialize = () => trigger(previous=>S.initializeQuest(flow,previous,true))
  const settle = (id: string, outcome: 'succeeded' | 'failed') => trigger(previous=>M.getObjectiveNode(flow,id) ? S.settleObjective(flow,previous,id,outcome,true) : S.settleProgress(flow,previous,id,outcome,true))
  const togglePredicate = (id: string) => trigger(previous=>S.setPredicateTruth(flow,previous,id,!S.predicateTruth(previous,id),true))

  const createItems = (position: FlowPosition): MenuItem[] => [
    { label: '新建进度', action: () => onCreate(position, 'progress') },
    { label: '新建条件', action: () => onCreate(position, 'predicate') },
    { label: '新建目标', action: () => onCreate(position, 'objective') },
    { label: '新建逻辑', action: () => onCreate(position, 'transition') },
    { label: '新建结束', action: () => onCreate(position, 'end') },
    { label: '添加注释', action: () => onCreate(position, 'note') },
  ]

  const businessMenuItems = (context: MenuContext): MenuItem[] => {
    const id = context.id
    if (context.kind === 'pane') return [
      { label: '编辑任务信息…', action: () => openForm(flow.start) },
      { label: '初始化任务', disabled: eventDisabled || sim.initialized, action: initialize },
      ...(locked ? [] : createItems(context.position)),
    ]
    if (context.kind === 'group') return []
    if (context.kind === 'edge' && id) return [{ label: '断开连接', disabled: locked, action: () => onDisconnect(edgeSelection(id)) }]
    if (!id || id.startsWith(FORM_PREFIX)) return []
    const progress = M.getProgressNode(flow, id)
    if (progress) {
      const running = S.progressState(sim, id) === 'running'
      const start = M.isStartNode(flow, id)
      return [
        { label: '编辑…', disabled: locked, action: () => openForm(id) },
        ...(start ? [{ label: '初始化任务', disabled: eventDisabled || sim.initialized, action: initialize }] : []),
        { label: '结算为成功（发 A）', disabled: eventDisabled || !running, action: () => settle(id, 'succeeded') },
        { label: '结算为失败（发 A）', disabled: eventDisabled || !running, action: () => settle(id, 'failed') },
        { label: start ? '删除开始进度（不可用）' : '删除进度', disabled: start || locked, action: () => onDelete(id) },
      ]
    }
    if (M.getPredicateNode(flow, id)) {
      const truth = S.predicateTruth(sim, id)
      return [
        { label: '编辑…', disabled: locked, action: () => openForm(id) },
        { label: truth ? '置为假' : sim.initialized ? '置为真（发 A）' : '预置为真（初始化时广播）', disabled: eventDisabled, action: () => togglePredicate(id) },
        { label: '删除条件', disabled: locked, action: () => onDelete(id) },
      ]
    }
    if (M.getObjectiveNode(flow, id)) {
      const running = S.objectiveState(sim,id) === 'running'
      return [
        { label: '编辑…', disabled: locked, action: () => openForm(id) },
        { label: '结算为成功（发 A）', disabled: eventDisabled || !running, action: () => settle(id,'succeeded') },
        { label: '结算为失败（发 A）', disabled: eventDisabled || !running, action: () => settle(id,'failed') },
        { label: '删除目标', disabled: locked, action: () => onDelete(id) },
      ]
    }
    if (M.getTransitionNode(flow, id)) return [{ label: '删除逻辑', disabled: locked, action: () => onDelete(id) }]
    if (M.getEndNode(flow, id)) return [{ label: '编辑…', disabled: locked, action: () => openForm(id) }, { label: '删除结束节点', disabled: locked, action: () => onDelete(id) }]
    return []
  }

  const menuItems = (context: MenuContext): MenuItem[] => {
    const id=context.id
    const debug: MenuItem[] = context.kind==='edge' && id ? [{label:breakpoints.links.includes(id.slice(6))?'移除连线断点':'添加连线断点',action:()=>toggleBreakpoint('links',id.slice(6))}]
      : context.kind==='node' && id && M.hasContentNode(flow,id) ? [
        {label:breakpoints.nodes.includes(id)?'移除节点断点':'添加节点断点',action:()=>toggleBreakpoint('nodes',id)},
        {label:'运行到此节点',disabled:!S.isBusy(sim)||disabled||!active,action:()=>runUntil(id)},
      ] : []
    return [...debug,...businessMenuItems(context)]
  }

  const viewTools = <>
      <button type="button" className="flow-graph-add" disabled={disabled || !active || locked} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setCreateMenu({ x: rect.left, y: rect.bottom + 4, position: api.current?.center() ?? { x: 64, y: 64 } }) }}>＋ 节点</button>
      <div className="flow-graph-zoom"><button type="button" aria-label="缩小画布" title="缩小画布 · 滚轮也可缩放" onClick={() => { api.current?.zoom(-.1) }}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label="放大画布" title="放大画布" onClick={() => { api.current?.zoom(.1) }}>+</button></div>
      <button type="button" title="调整视口以显示全部节点" onClick={() => api.current?.fit()}>显示全部</button><button type="button" title="定位开始进度节点" onClick={() => api.current?.focus(flow.start)}>定位开始</button>
    </>
  return <div className="flow-graph">
    <NodeEditor ref={api} documentId={flow.id} nodes={nodes} edges={[...edges, ...formEdges]} groups={groups} registry={registry} selection={graphSelection} active={active} readOnly={disabled} features={{ connections: !locked, knife: !locked, groups: !locked, arrange: !locked }} initialFocusId={flow.start} onViewportChange={viewport => setZoom(viewport.zoom)}
      onSelectionChange={next => {
        setLocalSelection(next)
        const selectedForm=next.nodes.find(id => id.startsWith(FORM_PREFIX))
        setActiveFormId(selectedForm ? selectedForm.slice(FORM_PREFIX.length) : null)
        const items = next.nodes.filter(id => !id.startsWith(FORM_PREFIX))
        onSelect(items.length === 1 && !next.edges.length ? nodeSelection(flow, items[0]) : next.edges.length === 1 && !next.nodes.length ? edgeSelection(next.edges[0]) : { kind: 'flow' })
      }}
      onMove={moveNodes} onGroup={ids => { onGroup(ids.filter(id => !id.startsWith(FORM_PREFIX))) }} onUngroup={onUngroup} onRenameGroup={onRenameGroup} onArrange={onArrange}
      canConnect={connection => !locked && M.canConnectNodes(flow, connection.source, connection.target, connection.targetPort as FlowInputPort, connection.sourcePort as FlowOutputPort)}
      onConnect={connection => { if (!locked) onConnect(connection.source, connection.target, connection.targetPort as FlowInputPort, connection.sourcePort as FlowOutputPort) }}
      onDelete={next => { if (locked) return; if (next.nodes.length === 1 && !next.edges.length) onDelete(next.nodes[0]); else if (next.nodes.length) onDeleteMany(next.nodes, next.edges.map(edgeSelection)); else onCut(next.edges.map(edgeSelection)) }}
      onCut={ids => { if (!locked) onCut(ids.map(edgeSelection)) }} menuItems={menuItems}
      onNodeDoubleClick={id => { if (!id.startsWith(FORM_PREFIX)) openForm(id) }}
      onNodeClick={(id, event) => {
        if (id.startsWith(FORM_PREFIX) || !(event.ctrlKey || event.metaKey)) return
        if (M.isStartNode(flow, id) && !sim.initialized) { initialize(); return }
        if (M.getPredicateNode(flow, id)) { togglePredicate(id); return }
        if (M.getProgressNode(flow, id) && S.progressState(sim, id) === 'running') settle(id, event.shiftKey ? 'failed' : 'succeeded')
        if (M.getObjectiveNode(flow, id) && S.objectiveState(sim, id) === 'running') settle(id, event.shiftKey ? 'failed' : 'succeeded')
      }} />
    <SignalDebugger key={`${flow.id}:${debugGeneration}`} viewTools={viewTools} expanded={toolsExpanded} onToggleExpanded={()=>setToolsExpanded(value=>!value)} flow={flow} sim={sim} playing={playing} autoPlay={autoPlay} onAutoPlay={value=>{setAutoPlay(value);if(!value)setPlaying(false)}} duration={duration} breakpoints={breakpoints} stopReason={stopReason} onClearBreakpoints={()=>{setBreakpoints({nodes:[],links:[]});setPausedAt(null);setStopReason('')}} disabled={disabled || !active} resolveText={resolveText} onInitialize={initialize} onStep={step} onPlay={play} onReset={()=>{setPlaying(false);flight.current={key:'',elapsed:0};setDebugGeneration(value=>value+1);setSim(S.resetSimState(flow));setRunTo(null);setSkipTrace(null);setPausedAt(null);setStopReason('')}} onDuration={setDuration} onFocus={delivery=>{api.current?.focus(delivery.to);onSelect(delivery.link ? {kind:'logic-link',id:delivery.link} : nodeSelection(flow,delivery.to))}} />
    {createMenu && <NodeContextMenu {...createMenu} title="节点画布" label="新建节点" items={createItems(createMenu.position)} onClose={() => setCreateMenu(null)} />}
  </div>
}
