import { useEffect, useMemo, useRef, useState } from 'react'
import * as M from './model'
import * as S from './signals'
import { SignalDebugger } from './SignalDebugger'
import type { CanvasNodeType, FlowCanvasNote, FlowInputPort, FlowOutputPort, FlowPosition, ProgressFlow, FlowSelection } from './model'
import { NodeEditor, NoteNode } from '../../nodeEditor'
import { NodeContextMenu } from '../../nodeEditor/ContextMenu'
import type { EditorSelection, MenuContext, MenuItem, NodeEditorApi, NodeRegistry, NodeViewProps } from '../../nodeEditor'
import { progressEdges, progressNodes, nodeSelection, edgeSelection } from './graphAdapter'
import { ProgressNode } from './ProgressNode'
import { NodeFormView, type NodeFormKind } from './NodeFormView'
import type { GoalDefinition } from './goalDefinitions'
import './ProgressGraph.css'
import './NodeFormView.css'

export type ProgressGraphKitOption = { ref: string; label: string }

function FormNode({ node: view }: NodeViewProps) {
  const data = view.data as {
    flow: ProgressFlow; nodeId: string; kind: NodeFormKind; definitions: readonly GoalDefinition[]
    kitOptions: readonly ProgressGraphKitOption[]; resolveText?: (key: string) => string | null
    setText?: (key: string, value: string) => void; onChange: (flow: ProgressFlow) => void
    onClose: () => void; disabled: boolean
  }
  return <NodeFormView {...data} />
}

const registry: NodeRegistry = { progress: { component: ProgressNode }, form: { component: FormNode }, note: { component: NoteNode } }

const FORM_PREFIX = 'form:'
const FORM_WIDTH = 380
const FORM_HEIGHT = 460

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
  const [duration, setDuration] = useState(600)
  const locked = sim.initialized || !!sim.fault
  const eventDisabled = disabled || !active || !S.canTrigger(sim)
  const flight = useRef({ key: '', elapsed: 0 })
  const previousFlow = useRef(flow)
  const flightKey = `${sim.pulse}:${sim.execution?.processed ?? sim.log.length}:${sim.queue[0]?.link ?? ''}`
  useEffect(() => {
    if (!playing || disabled || !active || !sim.queue.length) return
    if (flight.current.key !== flightKey) flight.current = { key: flightKey, elapsed: 0 }
    const started = performance.now()
    const timer = window.setTimeout(() => { flight.current.elapsed = 0; setSim(previous => S.stepSignal(flow, previous)) }, Math.max(0, duration - flight.current.elapsed))
    return () => { window.clearTimeout(timer); flight.current.elapsed += performance.now() - started }
  }, [playing, disabled, active, sim.queue.length, flightKey, duration, flow])
  useEffect(() => { if (!sim.queue.length || disabled || !active) setPlaying(false) }, [sim.queue.length, disabled, active])
  const [localSelection, setLocalSelection] = useState<EditorSelection>({ nodes: [], edges: [] })
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number; position: FlowPosition } | null>(null)
  const [zoom, setZoom] = useState(1)
  /** 打开的表单视图：节点 ID → 视图位置（会话内，不写文档） */
  const [forms, setForms] = useState<Record<string, FlowPosition>>({})

  useEffect(() => {
    if (previousFlow.current !== flow) {
      const prior = previousFlow.current
      const changedDocument = prior.id !== flow.id
      previousFlow.current = flow
      if (JSON.stringify(prior) === JSON.stringify(flow)) return
      setSim(S.createSimState(flow)); setPlaying(false)
      if (changedDocument) { setLocalSelection({ nodes: [], edges: [] }); setCreateMenu(null); setForms({}) }
    }
  }, [flow])
  useEffect(() => {
    setForms(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => M.hasContentNode(flow, id))))
  }, [flow])

  const nodeKind = (id: string): NodeFormKind | null => M.getProgressNode(flow, id) ? 'progress' : M.getPredicateNode(flow, id) ? 'predicate' : M.getEndNode(flow, id) ? 'end' : null
  const openForm = (id: string) => {
    if (disabled || locked) return
    const kind = nodeKind(id)
    if (!kind) return
    setForms(previous => {
      if (Object.hasOwn(previous, id)) return previous
      const base = layoutPosition(id)
      return { ...previous, [id]: { x: base.x + 260, y: base.y } }
    })
  }
  const closeForm = (id: string) => setForms(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))

  const nodes = useMemo(() => {
    const base = progressNodes(flow, sim, onUpdateNote, resolveText).map(node=>({...node, draggable: !locked, readOnly: locked}))
    const formsNodes = Object.entries(forms).map(([nodeId, position]) => {
      const kind = nodeKind(nodeId)
      return {
        id: `${FORM_PREFIX}${nodeId}`,
        type: 'form',
        position,
        width: FORM_WIDTH,
        height: FORM_HEIGHT,
        ports: [],
        deletable: false,
        label: `表单 ${nodeId}`,
        data: { flow, nodeId, kind, definitions, kitOptions, resolveText, setText: locked ? undefined : setText, disabled: disabled || locked, onChange: locked ? () => {} : onChangeFlow, onClose: () => closeForm(nodeId) },
      }
    }).filter(node => node.data.kind !== null)
    return [...base, ...formsNodes]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sim, forms, definitions, kitOptions, disabled, locked, resolveText, setText, onChangeFlow, onUpdateNote])
  const delivery = sim.queue[0]
  const edges = useMemo(() => progressEdges(flow, delivery ? { delivery, key: sim.queue.length ? flightKey : `last:${sim.pulse}:${sim.log.length}`, durationMs: duration || 1, running: active && (playing || !sim.queue.length) } : undefined), [flow, delivery, flightKey, duration, active, playing, sim.queue.length, sim.pulse, sim.log.length])
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

  const initialize = () => { if (!eventDisabled) setSim(previous => S.initializeQuest(flow, previous, true)) }
  const settle = (id: string, outcome: 'succeeded' | 'failed') => { if (!eventDisabled) setSim(previous => S.settleProgress(flow, previous, id, outcome, true)) }
  const togglePredicate = (id: string) => { if (!eventDisabled) setSim(previous => S.setPredicateTruth(flow, previous, id, !S.predicateTruth(previous, id), true)) }

  const createItems = (position: FlowPosition): MenuItem[] => [
    { label: '新建进度', action: () => onCreate(position, 'progress') },
    { label: '新建谓词', action: () => onCreate(position, 'predicate') },
    { label: '新建变迁', action: () => onCreate(position, 'transition') },
    { label: '新建结束', action: () => onCreate(position, 'end') },
    { label: '添加注释', action: () => onCreate(position, 'note') },
  ]

  const menuItems = (context: MenuContext): MenuItem[] => {
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
        { label: '删除谓词', disabled: locked, action: () => onDelete(id) },
      ]
    }
    if (M.getTransitionNode(flow, id)) return [{ label: '删除变迁', disabled: locked, action: () => onDelete(id) }]
    if (M.getEndNode(flow, id)) return [{ label: '编辑…', disabled: locked, action: () => openForm(id) }, { label: '删除结束节点', disabled: locked, action: () => onDelete(id) }]
    return []
  }

  return <div className="flow-graph">
    <div className="flow-graph-toolbar">
      <span className="flow-graph-editor-icon">◇</span><span className="flow-graph-editor-name">进度节点</span>
      <button type="button" className="flow-graph-add" disabled={disabled || !active || locked} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setCreateMenu({ x: rect.left, y: rect.bottom + 4, position: api.current?.center() ?? { x: 64, y: 64 } }) }}>＋ 节点</button>
      <span className="flow-graph-count">{nodes.length} 节点 · {edges.length} 连接</span>
      <div className="flow-graph-zoom"><button type="button" aria-label="缩小画布" onClick={() => { api.current?.zoom(-.1) }}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label="放大画布" onClick={() => { api.current?.zoom(.1) }}>+</button><button type="button" onClick={() => api.current?.fit()}>显示全部</button><button type="button" onClick={() => api.current?.focus(flow.start)}>定位开始</button></div>
    </div>
    <NodeEditor ref={api} documentId={flow.id} nodes={nodes} edges={edges} groups={groups} registry={registry} selection={graphSelection} active={active} readOnly={disabled} features={{ connections: !locked, knife: !locked, groups: !locked, arrange: !locked }} initialFocusId={flow.start} onViewportChange={viewport => setZoom(viewport.zoom)}
      onSelectionChange={next => {
        setLocalSelection(next)
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
      }} />
    <SignalDebugger flow={flow} sim={sim} playing={playing} duration={duration} disabled={disabled || !active} resolveText={resolveText} onInitialize={initialize} onStep={()=>{setPlaying(false);setSim(previous=>S.stepSignal(flow,previous))}} onPlay={()=>setPlaying(previous=>!previous)} onReset={()=>{setPlaying(false);flight.current={key:'',elapsed:0};setSim(S.resetSimState(flow))}} onDuration={setDuration} onFocus={delivery=>{api.current?.focus(delivery.to);onSelect(delivery.link ? {kind:'logic-link',id:delivery.link} : nodeSelection(flow,delivery.to))}} />
    <div className="flow-graph-legend"><span>开始进度 · 进度 · 谓词 · 变迁 · 结束</span><span>双击节点在画布上打开表单 · 初始化时播报已为真的谓词 · 未联通的节点是草稿</span></div>
    {createMenu && <NodeContextMenu {...createMenu} title="节点画布" label="新建节点" items={createItems(createMenu.position)} onClose={() => setCreateMenu(null)} />}
  </div>
}
