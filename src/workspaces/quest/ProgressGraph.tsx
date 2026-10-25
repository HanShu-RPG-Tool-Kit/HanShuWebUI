import { useEffect,useMemo,useRef,useState } from 'react'
import * as M from './model'
import * as S from './signals'
import type { CanvasNodeType,FlowCanvasNote,FlowInputPort,FlowPort,FlowPosition,ProgressFlow,FlowSelection } from './model'
import { NodeEditor,NoteNode } from '../../nodeEditor'
import { NodeContextMenu } from '../../nodeEditor/ContextMenu'
import type { EditorSelection,MenuContext,MenuItem,NodeEditorApi,NodeRegistry } from '../../nodeEditor'
import { progressEdges,progressNodes,nodeSelection,edgeSelection } from './graphAdapter'
import { ProgressNode } from './ProgressNode'
import './ProgressGraph.css'
const registry:NodeRegistry={progress:{component:ProgressNode},note:{component:NoteNode}}
export function ProgressGraph({ flow, selection, onSelect, onEdit, onAddNext, onCreate, onMove, onGroup, onUngroup, onRenameGroup, onDelete, onDeleteMany, onArrange, onUpdateNote, onConnectEntry, onConnect, onDisconnect, onCut, active, disabled = false, resolveText }: {
  flow: ProgressFlow; selection: FlowSelection; onSelect: (selection: FlowSelection) => void; onEdit: (selection: FlowSelection) => void
  onAddNext: (parent: string) => void; onCreate: (position: FlowPosition, operator?: CanvasNodeType) => void; onMove: (positions: Record<string, FlowPosition>) => void
  onGroup: (ids: string[]) => string | null; onUngroup: (id: string) => void; onRenameGroup: (id: string, name: string) => void
  onUpdateNote: (id: string, patch: Partial<FlowCanvasNote>) => void
  onDeleteMany: (ids: string[], disconnect?: FlowSelection[]) => void; onArrange: (ids: string[]) => void
  onDelete: (id: string) => void; onConnectEntry: (id: string | null) => void
  onConnect: (from: string, to: string, port: FlowInputPort, fromPort?: FlowPort) => void; onDisconnect: (selection: FlowSelection) => void; onCut: (selections: FlowSelection[]) => void
  active: boolean; disabled?: boolean
  resolveText?: (key: string) => string | null
}) {

  const api=useRef<NodeEditorApi>(null)
  const [sim,setSim]=useState(()=>S.createSimState(flow))
  const previousFlow=useRef(flow.id)
  const [localSelection,setLocalSelection]=useState<EditorSelection>({nodes:[],edges:[]})
  const [createMenu,setCreateMenu]=useState<{x:number;y:number;position:FlowPosition}|null>(null)
  const [zoom,setZoom]=useState(1)
  useEffect(()=>{
    if(previousFlow.current!==flow.id){previousFlow.current=flow.id;setSim(S.createSimState(flow));setLocalSelection({nodes:[],edges:[]});setCreateMenu(null)}
    else setSim(previous=>S.syncSimState(previous,flow))
  },[flow])
  const nodes=useMemo(()=>progressNodes(flow,sim,onUpdateNote,resolveText),[flow,sim,onUpdateNote,resolveText])
  const edges=useMemo(()=>progressEdges(flow),[flow])
  const groups=useMemo(()=>Object.entries(flow.layout?.groups??{}).map(([id,group],i)=>({id,name:group.name?.trim()||`Group ${i+1}`,nodes:group.nodes})),[flow.layout?.groups])
  const graphSelection=selection.kind==='flow'?localSelection:selection.kind==='entry'?{nodes:[flow.entry.id],edges:[]}:selection.kind==='entry-link'?{nodes:[],edges:['entry-link']}:selection.kind==='logic-link'?{nodes:[],edges:[`logic:${selection.id}`]}:{nodes:[selection.id],edges:[]}
  const goalDiff=(id:string)=>(flow.logic?.links??[]).some(link=>link.from===id&&!!M.getDiffNode(flow,link.to))
  const signal=(id:string,no=false)=>{
    if(disabled||!active)return
    setSim(previous=>{
      const current=S.syncSimState(previous,flow)
      if(id===flow.entry.id)return S.fireStart(flow,current)
      if(M.getGoalNode(flow,id)&&S.goalState(current,id)==='subscribed')return goalDiff(id)?no?S.fireGoalNo(flow,current,id):S.fireGoalYes(flow,current,id):S.fireGoalComplete(flow,current,id)
      if(M.getPredicateNode(flow,id)&&S.predicateState(current,id)==='subscribed')return S.firePredicateComplete(flow,current,id)
      return current
    })
  }
  const createItems=(position:FlowPosition):MenuItem[]=>[
    {label:'添加注释',action:()=>onCreate(position,'note')},
    {label:'新建 checkpoint',action:()=>onCreate(position)},
    ...([['transition','线性变迁'],['conditional','条件变迁'],['diff','差分变迁'],['merge','合并变迁'],['swap','交换变迁'],['goal','Goal'],['predicate','Predicate'],['end','结束节点']] as const).map(([type,label])=>({label:`新建 ${label}`,action:()=>onCreate(position,type)})),
  ]
  const menuItems=(context:MenuContext):MenuItem[]=>{
    const id=context.id
    if(context.kind==='pane')return createItems(context.position)
    if(context.kind==='group')return []
    if(context.kind==='edge'&&id)return [
      ...(id==='entry-link'?[{label:'编辑开始节点…',action:()=>onEdit({kind:'entry'})}]:[]),
      {label:'断开连接',action:()=>onDisconnect(edgeSelection(id))},
    ]
    if(!id)return []
    if(id===flow.entry.id)return [
      {label:'触发开始信号',action:()=>signal(id)},
      {label:'新建并连接 checkpoint',disabled:flow.entry.target!==null,action:()=>onAddNext(id)},
      {label:'设置起始节点…',action:()=>onEdit({kind:'entry'})},
      {label:'断开出口连接',disabled:flow.entry.target===null,action:()=>onConnectEntry(null)},
      {label:'删除开始节点（不可用）',disabled:true,action:()=>{}},
    ]
    const goal=M.getGoalNode(flow,id),predicate=M.getPredicateNode(flow,id),note=M.getCanvasNote(flow,id)
    if(goal)return goalDiff(id)?[
      {label:'发出 G-Y 成功',disabled:S.goalState(sim,id)!=='subscribed',action:()=>signal(id)},
      {label:'发出 G-N 失败',disabled:S.goalState(sim,id)!=='subscribed',action:()=>signal(id,true)},
    ]:[{label:'发出 G 信号',disabled:S.goalState(sim,id)!=='subscribed',action:()=>signal(id)}]
    if(predicate)return [{label:'发出 P 信号',disabled:S.predicateState(sim,id)!=='subscribed',action:()=>signal(id)}]
    if(note)return Object.entries(M.NOTE_COLORS).map(([color,label])=>({label:`${note.color===color?'✓ ':''}${label}`,action:()=>onUpdateNote(id,{color:color as FlowCanvasNote['color']})}))
    if(flow.nodes[id])return [
      {label:'新建下一节点',action:()=>onAddNext(id)},
      {label:'编辑阶段…',action:()=>onEdit({kind:'node',id})},
      {label:'连接到开始',disabled:flow.entry.target===id,action:()=>onConnectEntry(id)},
    ]
    return []
  }
  const lastAccepted=[...sim.log].reverse().find(item=>item.accepted)
  return <div className="flow-graph">
    <div className="flow-graph-toolbar">
      <span className="flow-graph-editor-icon">◇</span><span className="flow-graph-editor-name">进度节点</span>
      <button type="button" className="flow-graph-add" disabled={disabled||!active} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setCreateMenu({x:rect.left,y:rect.bottom+4,position:api.current?.center()??{x:64,y:64}})}}>＋ 节点</button>
      <span className="flow-graph-count">{nodes.length} 节点 · {edges.length} 连接</span>
      <div className="flow-graph-sim" aria-label="信号模拟"><button type="button" disabled={disabled||!active} onClick={()=>signal(flow.entry.id)}>触发开始</button><button type="button" disabled={disabled||!active} onClick={()=>setSim(S.resetSimState(flow))}>重置模拟</button><span className="flow-graph-sim-log" role="status">{sim.pulse===0?'模拟待命 · Ctrl+点击信号源发信号':lastAccepted?`脉冲 #${sim.pulse} · ${lastAccepted.to} ← ${S.SIGNAL_LABELS[lastAccepted.signal.kind]}`:`脉冲 #${sim.pulse}`}</span></div>
      <div className="flow-graph-zoom"><button type="button" aria-label="缩小画布" onClick={()=>{api.current?.zoom(-.1)}}>−</button><output>{Math.round(zoom*100)}%</output><button type="button" aria-label="放大画布" onClick={()=>{api.current?.zoom(.1)}}>+</button><button type="button" onClick={()=>api.current?.fit()}>显示全部</button><button type="button" onClick={()=>api.current?.focus(flow.entry.id)}>定位开始</button></div>
    </div>
    <NodeEditor ref={api} documentId={flow.id} nodes={nodes} edges={edges} groups={groups} registry={registry} selection={graphSelection} active={active} readOnly={disabled} initialFocusId={flow.entry.id} onViewportChange={viewport=>setZoom(viewport.zoom)}
      onSelectionChange={next=>{setLocalSelection(next);onSelect(next.nodes.length===1&&!next.edges.length?nodeSelection(flow,next.nodes[0]):next.edges.length===1&&!next.nodes.length?edgeSelection(next.edges[0]):{kind:'flow'})}}
      onMove={onMove} onGroup={ids=>{onGroup(ids)}} onUngroup={onUngroup} onRenameGroup={onRenameGroup} onArrange={onArrange}
      canConnect={connection=>M.canConnectNodes(flow,connection.source,connection.target,connection.targetPort as FlowInputPort,connection.sourcePort as FlowPort)}
      onConnect={connection=>{if(connection.source===flow.entry.id)onConnectEntry(connection.target);else onConnect(connection.source,connection.target,connection.targetPort as FlowInputPort,connection.sourcePort as FlowPort)}}
      onDelete={next=>{if(next.nodes.length===1&&!next.edges.length)onDelete(next.nodes[0]);else if(next.nodes.length)onDeleteMany(next.nodes,next.edges.map(edgeSelection));else onCut(next.edges.map(edgeSelection))}}
      onCut={ids=>onCut(ids.map(edgeSelection))} menuItems={menuItems}
      onNodeDoubleClick={id=>{if(id===flow.entry.id||flow.nodes[id])onEdit(nodeSelection(flow,id))}}
      onEdgeDoubleClick={id=>{if(id==='entry-link')onEdit({kind:'entry-link'})}}
      onNodeClick={(id,event)=>{if(event.ctrlKey||event.metaKey)signal(id,event.shiftKey)}} />
    <div className="flow-graph-legend"><span>开始 · Checkpoint · Goal · Predicate · 变迁</span><span>Ctrl+点击信号源 · 右键拖动平移 · 滚轮缩放 · 双击后按住小刀</span></div>
    {createMenu&&<NodeContextMenu {...createMenu} title="节点画布" label="新建节点" items={createItems(createMenu.position)} onClose={()=>setCreateMenu(null)}/>}
  </div>
}
