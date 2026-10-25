import * as M from './model'
import { layoutCanvas,nodeMetrics,socketOffset } from './canvas'
import type { FlowSimState } from './signals'
import type { EditorEdge,EditorNode } from '../../nodeEditor'
export type ProgressNodeData={flow:M.ProgressFlow;sim:FlowSimState;resolveText?: (key:string)=>string|null}
export function nodeSelection(flow:M.ProgressFlow,id:string):M.FlowSelection {
  if(id===flow.entry.id)return {kind:'entry'}
  const kind=M.getCanvasNote(flow,id)?'note':M.getEndNode(flow,id)?'end':M.getTransitionNode(flow,id)?'transition':M.getConditionalNode(flow,id)?'conditional':M.getDiffNode(flow,id)?'diff':M.getMergeNode(flow,id)?'merge':M.getSwapNode(flow,id)?'swap':M.getGoalNode(flow,id)?'goal':M.getPredicateNode(flow,id)?'predicate':'node'
  return {kind,id}
}
export function edgeSelection(id:string):M.FlowSelection{return id==='entry-link'?{kind:'entry-link'}:{kind:'logic-link',id:id.slice(6)}}
export function progressLinks(flow:M.ProgressFlow){
  const links=(flow.logic?.links??[]).map(link=>({...link,entry:false}))
  return flow.entry.target===null?links:[{id:'entry-link',from:flow.entry.id,to:flow.entry.target,port:flow.entry.port??'input',fromPort:'output',entry:true} as typeof links[number],...links]
}
export function progressEdges(flow:M.ProgressFlow):EditorEdge[]{
  return progressLinks(flow).map(link=>({id:link.entry?'entry-link':`logic:${link.id}`,source:link.from,target:link.to,sourcePort:M.linkSourcePort(flow,link.from,link.to,link.port,link.fromPort),targetPort:link.port,kind:M.portKind(flow,link.from,M.linkSourcePort(flow,link.from,link.to,link.port,link.fromPort)),color:M.portKind(flow,link.from,M.linkSourcePort(flow,link.from,link.to,link.port,link.fromPort))==='goal'?'#d0ad72':'#7a9aab',label:link.entry?'起点连接':`连接 ${link.id}，${link.from} 到 ${link.to}`}))
}
function portLabel(flow:M.ProgressFlow,id:string,port:M.FlowPort):string {
  if(/^in\d+$/.test(port))return `A${Number(port.slice(2))+1} 入`
  if(/^out\d+$/.test(port))return `S${Number(port.slice(3))+1} 出`
  if(port==='input2')return 'Parent'
  if(port==='input')return M.getTransitionNode(flow,id)||M.getDiffNode(flow,id)?'Goal':M.getConditionalNode(flow,id)?'Predicate':M.getMergeNode(flow,id)?'A 入':'S 入'
  if(M.getDiffNode(flow,id))return port==='output2'?'失败 · S':'成功 · S'
  return id===flow.entry.id?'S 出':M.getGoalNode(flow,id)?'G 出':M.getPredicateNode(flow,id)?'P 出':M.getTransitionNode(flow,id)||M.getConditionalNode(flow,id)||M.getMergeNode(flow,id)?'Next · S':'激活出'
}
export function progressNodes(flow:M.ProgressFlow,sim:FlowSimState,onUpdateNote:(id:string,patch:Partial<M.FlowCanvasNote>)=>void,resolveText?: (key:string)=>string|null):EditorNode[]{
  const layout=layoutCanvas(flow)
  return layout.ids.map(id=>{
    const note=M.getCanvasNote(flow,id),metrics=nodeMetrics(flow,id)
    const ports=[...M.inputPorts(flow,id),...M.outputPorts(flow,id)].map(port=>({id:port,direction:M.isOutputPort(port)?'output' as const:'input' as const,y:socketOffset(flow,id,port).y,label:portLabel(flow,id,port),kind:M.portKind(flow,id,port),color:M.portKind(flow,id,port)==='goal'?'#d0ad72':'#7a9aab'}))
    return {id,type:note?'note':'progress',position:layout.positions.get(id)!,width:metrics.width,height:metrics.height,ports,deletable:id!==flow.entry.id,
      label:id===flow.entry.id?'开始节点（信号源），不可删除':`${nodeSelection(flow,id).kind} ${id}`,
      data:note?{...note,onChange:(patch:Partial<M.FlowCanvasNote>)=>onUpdateNote(id,patch)}:{flow,sim,resolveText}}
  })
}
