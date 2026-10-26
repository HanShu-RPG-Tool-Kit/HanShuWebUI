import { createContext, createElement, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, ConnectionMode, SelectionMode, applyNodeChanges, applyEdgeChanges, useReactFlow, useUpdateNodeInternals, useStoreApi, type Node, type Edge, type NodeProps, type EdgeProps, type Connection, type EdgeChange, type ConnectionLineComponentProps } from '@xyflow/react'
import type { EditorEdge, EditorGroup, EditorNode, EditorSelection, MenuContext, NodeEditorApi, NodeEditorProps, Point } from './types'
import { normalizeConnection, segmentsCross, wireGeometry, portSide, portOffset } from './geometry'
import { arrangeNodes } from './arrange'
import { MIN_CANVAS_ZOOM,MAX_CANVAS_ZOOM } from './camera'
import { NodeContextMenu } from './ContextMenu'
import knifeIcon from './knife.svg'
import '@xyflow/react/dist/style.css'
import './NodeEditor.css'

type ViewData = { view: EditorNode; registry: NodeEditorProps['registry']; readOnly: boolean; connections:boolean }
type FlowNode = Node<ViewData, 'content' | 'group'>
type FlowEdge = Edge<Pick<EditorEdge, 'kind' | 'color' | 'activity' | 'sourceBadge' | 'targetBadge'>, 'wire'>
const PortContext=createContext<(id:string,port:string)=>void>(()=>{})
const EMPTY_CUTS=new Set<string>()
const CutContext=createContext<Set<string>>(EMPTY_CUTS)
const GroupContext = createContext<{ rename(id:string,name:string):void; readOnly:boolean; selectedNodes:string[]; editingGroup:string|null; editGroup:(id:string|null)=>void }>({ rename() {},readOnly:true,selectedNodes:[],editingGroup:null,editGroup(){} })

function ContentNode({ id, data, selected, dragging }: NodeProps<FlowNode>) {
  const update = useUpdateNodeInternals(),keyboard=useContext(PortContext)
  const signature = JSON.stringify([data.view.width,data.view.height,data.view.ports.map(port=>[port.id,port.direction,portSide(port),portOffset(port)])])
  const previousPorts=useRef(signature)
  useEffect(()=>{if(previousPorts.current!==signature){previousPorts.current=signature;update(id)}},[id,signature,update])
  const Component = data.registry[data.view.type]?.component
  return <div className={`node-editor-content ${data.view.className ?? ''}`} data-canvas-node={id}>
    {Component ? createElement(Component,{ node:data.view,selected,dragging:!!dragging,readOnly:data.readOnly }) : <span>未知节点类型：{data.view.type}</span>}
    {data.view.ports.map(port=><Handle key={port.id} id={port.id} type={port.direction==='output'?'source':'target'} position={({left:Position.Left,right:Position.Right,top:Position.Top,bottom:Position.Bottom})[portSide(port)]}
      style={{...(portSide(port)==='top'||portSide(port)==='bottom'?{left:portOffset(port)}:{top:portOffset(port)}),background:port.color}} className={`node-editor-port is-kind-${port.kind ?? 'default'}`} data-flow-socket={port.id} data-node-id={id}
      aria-label={`${data.view.label}，${port.label}端口`} title={port.label} isConnectable={data.connections} tabIndex={data.readOnly?-1:0} role="button" onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(!data.readOnly)keyboard(id,port.id)}}} />)}
  </div>
}
function GroupNode({ data }: NodeProps<FlowNode>) {
  const { rename,readOnly,selectedNodes,editingGroup,editGroup } = useContext(GroupContext)
  const group = data.view.data as EditorGroup
  const [name,setName] = useState<string|null>(null),finished=useRef(false)
  useEffect(()=>{if(editingGroup===group.id){finished.current=false;setName(group.name)}},[editingGroup,group.id,group.name])
  const finish = (save:boolean) => { if(finished.current)return;finished.current=true;if(save && name?.trim() && !readOnly) rename(group.id,name.trim());setName(null);editGroup(null) }
  return <div className={`node-editor-group-frame${group.nodes.every(id=>selectedNodes.includes(id))?' is-selected':''}`} data-canvas-group={group.id}>
    {name!==null ? <input className="nodrag nopan node-editor-group-name" disabled={readOnly} aria-label="Group 名称" autoFocus value={name} onChange={event=>setName(event.target.value)} onBlur={()=>finish(true)} onKeyDown={event=>{
      event.stopPropagation(); if(event.key==='Enter'){event.preventDefault();finish(true)} if(event.key==='Escape'){event.preventDefault();finish(false)}
    }} /> : <div className="node-editor-group-heading" onDoubleClick={event=>{event.stopPropagation();if(!readOnly){finished.current=false;setName(group.name)}}}><span>{group.name}</span><small>{group.nodes.length} 节点</small></div>}
  </div>
}
function Wire({ id,sourceX,sourceY,targetX,targetY,source,target,sourcePosition,targetPosition,selected,data }: EdgeProps<FlowEdge>) {
  const cutting=useContext(CutContext).has(id)
  const geometry=wireGeometry({x:sourceX,y:sourceY},{x:targetX,y:targetY},source===target,sourcePosition,targetPosition)
  const path=geometry.path, sourceBadge=geometry.sample(.32), targetBadge=geometry.sample(.68)
  return <g className={`node-editor-wire is-kind-${data?.kind ?? 'default'}${selected?' is-selected':''}`}>
    <path d={path} className="node-editor-wire-shadow"/>
    <path d={path} className="node-editor-wire-line" style={{stroke:cutting?'#fa7777':selected?'#efb26a':data?.color}}/>
    {data?.sourceBadge !== undefined && <g className="node-editor-wire-badge" transform={`translate(${sourceBadge.x},${sourceBadge.y - 12})`}><circle r="9"/><text>{data.sourceBadge + 1}</text></g>}
    {data?.targetBadge !== undefined && <g className="node-editor-wire-badge is-reverse" transform={`translate(${targetBadge.x},${targetBadge.y - 12})`}><circle r="9"/><text>{data.targetBadge + 1}</text></g>}
    {data?.activity && <g key={data.activity.key} className="node-editor-wire-signal" data-signal={data.activity.label} style={{ color: data.activity.color, offsetPath: `path("${path}")`, offsetRotate: '0deg', offsetAnchor: '0px 0px', animationDuration: `${data.activity.durationMs}ms`, animationDirection: data.activity.reverse ? 'reverse' : 'normal', animationPlayState: data.activity.running ? 'running' : 'paused' }}><circle r="10"/><text>{data.activity.label}</text></g>}
    <path d={path} className="node-editor-wire-hit react-flow__edge-interaction" data-editor-edge={id}/>
  </g>
}
function ConnectionPreview({fromX,fromY,toX,toY,fromHandle,fromPosition,toPosition}:ConnectionLineComponentProps){
  const from={x:fromX,y:fromY},to={x:toX,y:toY}
  return <path className="react-flow__connection-path" d={(fromHandle.type==='target'?wireGeometry(to,from,false,toPosition,fromPosition):wireGeometry(from,to,false,fromPosition,toPosition)).path}/>
}
const nodeTypes={content:ContentNode,group:GroupNode},edgeTypes={wire:Wire}
const empty:EditorSelection={nodes:[],edges:[]}
const NO_GROUPS:EditorGroup[]=[]
const equal=(a:EditorSelection,b:EditorSelection)=>a.nodes.length===b.nodes.length&&a.edges.length===b.edges.length&&a.nodes.every(id=>b.nodes.includes(id))&&a.edges.every(id=>b.edges.includes(id))
function withGroupBounds(nodes:FlowNode[],groups:EditorGroup[]) {
  return nodes.map(node=>{
    if(node.type!=='group')return node
    const group=node.data.view.data as EditorGroup, members=nodes.filter(item=>group.nodes.includes(item.id))
    if(!members.length)return node
    const x=Math.min(...members.map(item=>item.position.x))-16,y=Math.min(...members.map(item=>item.position.y))-36
    const width=Math.max(...members.map(item=>item.position.x+(item.width??216)))-x+16,height=Math.max(...members.map(item=>item.position.y+(item.height??100)))-y+16
    return {...node,position:{x,y},width,height,style:{width,height}}
  }).filter(node=>node.type!=='group'||groups.some(group=>group.id===(node.data.view.data as EditorGroup).id))
}

type Drag={anchor:Point; pointer:Point|null; zoom:number; starts:Record<string,Point>}
type Knife={pointer:number; points:Point[]; cuts:Set<string>; paths:{id:string;points:Point[]}[]}
const EditorSurface=forwardRef<NodeEditorApi,NodeEditorProps>(function EditorSurface(props,ref){
  const api=useReactFlow<FlowNode,FlowEdge>(),store=useStoreApi<FlowNode,FlowEdge>(),root=useRef<HTMLDivElement>(null),live=useRef(props);live.current=props
  const disabled=props.readOnly||props.active===false,features=props.features??{},groups=features.groups===false?NO_GROUPS:props.groups??NO_GROUPS,interaction=props.interaction??{}
  const [nodes,setNodes]=useState<FlowNode[]>([]),[edges,setEdges]=useState<FlowEdge[]>([])
  const selectionRef=useRef<EditorSelection>(props.selection??empty)
  const [selection,setSelection]=useState<EditorSelection>(props.selection??empty)
  const keyboardPort=useRef<{node:string;port:string}|null>(null)
  const [editingGroup,setEditingGroup]=useState<string|null>(null)
  const [menu,setMenu]=useState<(MenuContext&{x:number;y:number})|null>(null)
  const downPoint=useRef<Point|null>(null)
  const drag=useRef<Drag|null>(null),lastBlank=useRef<{x:number;y:number;at:number}|null>(null)
  const knife=useRef<Knife|null>(null),[knifeView,setKnifeView]=useState<Knife|null>(null)
  const suppressContext=useRef(false),rightDown=useRef<Point|null>(null),initialized=useRef(false)
  const projection=useMemo(()=>{
    const result:FlowNode[]=props.nodes.map(view=>({id:view.id,type:'content',position:view.position,width:view.width,height:view.height,style:{width:view.width,height:view.height},data:{view,registry:props.registry,readOnly:!!disabled||!!view.readOnly,connections:!disabled&&features.connections!==false},deletable:false,draggable:!disabled&&view.draggable!==false,selected:false,ariaLabel:view.label,dragHandle:undefined}))
    if(features.groups!==false)for(const group of groups){
      let id=`node-editor:group:${group.id}`;while(result.some(node=>node.id===id))id='_'+id
      const view:EditorNode={id,type:'group',position:{x:0,y:0},width:0,height:0,ports:[],label:group.name,data:group}
      result.unshift({id,type:'group',position:view.position,data:{view,registry:props.registry,readOnly:!!disabled||!!view.readOnly,connections:!disabled&&features.connections!==false},draggable:!disabled,deletable:false,selectable:false,dragHandle:'.node-editor-group-heading',zIndex:-1})
    }
    return withGroupBounds(result,groups)
  },[props.nodes,props.registry,groups,disabled,features.groups,features.connections])
  useEffect(()=>{setNodes(previous=>{const byId=new Map(previous.map(node=>[node.id,node]));return projection.map(node=>{
    const old=byId.get(node.id)
    return {...node,measured:old?.measured,selected:selectionRef.current.nodes.includes(node.id),position:drag.current?.starts[node.id]&&old?old.position:node.position}
  })})},[projection])
  useEffect(()=>{setEdges(props.edges.map(edge=>({id:edge.id,source:edge.source,target:edge.target,sourceHandle:edge.sourcePort,targetHandle:edge.targetPort,type:'wire',data:{kind:edge.kind,color:edge.color,activity:edge.activity,sourceBadge:edge.sourceBadge,targetBadge:edge.targetBadge},selected:selectionRef.current.edges.includes(edge.id),deletable:false,ariaLabel:edge.label??`${edge.source} → ${edge.target}`})))},[props.edges])
  const select=useCallback((next:EditorSelection)=>{
    if(equal(selectionRef.current,next))return
    selectionRef.current=next;setSelection(next)
    setNodes(previous=>previous.map(node=>({...node,selected:next.nodes.includes(node.id)})))
    setEdges(previous=>previous.map(edge=>({...edge,selected:next.edges.includes(edge.id)})))
    live.current.onSelectionChange?.(next)
  },[])
  useEffect(()=>{
    if(!props.selection||equal(selectionRef.current,props.selection))return
    select(props.selection)
    const id=props.selection.nodes.length===1?props.selection.nodes[0]:null
    const node=id?api.getNode(id):null,element=root.current
    if(!node||!element||props.active===false)return
    const viewport=api.getViewport(),left=node.position.x*viewport.zoom+viewport.x,top=node.position.y*viewport.zoom+viewport.y
    const right=left+(node.width??216)*viewport.zoom,bottom=top+(node.height??100)*viewport.zoom
    const dx=left<24?24-left:right>element.clientWidth-24?element.clientWidth-24-right:0,dy=top<24?24-top:bottom>element.clientHeight-24?element.clientHeight-24-bottom:0
    if(dx||dy)void api.setViewport({...viewport,x:viewport.x+dx,y:viewport.y+dy})
  },[props.selection,props.active,select,api])
  const onSelectionChange=useCallback(({nodes:selectedNodes,edges:selectedEdges}:{nodes:FlowNode[];edges:FlowEdge[]})=>{
    if(live.current.active===false)return
    const ids=new Set(selectedNodes.filter(node=>node.type==='content').map(node=>node.id))
    if(live.current.features?.groups!==false)for(const group of live.current.groups??[])if(group.nodes.some(id=>ids.has(id)))for(const id of group.nodes)ids.add(id)
    select({nodes:[...ids],edges:selectedEdges.map(edge=>edge.id)})
  },[select])
  const selectionEnd=(event:React.MouseEvent)=>{
    const start=downPoint.current;if(disabled||!start||Math.hypot(event.clientX-start.x,event.clientY-start.y)<3)return
    const left=Math.min(start.x,event.clientX),right=Math.max(start.x,event.clientX),top=Math.min(start.y,event.clientY),bottom=Math.max(start.y,event.clientY)
    const inside=(p:Point)=>p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom
    const hits=[...(root.current?.querySelectorAll<SVGPathElement>('[data-editor-edge]')??[])].filter(path=>{
      const matrix=path.getScreenCTM(),length=path.getTotalLength(),steps=Math.max(16,Math.ceil(length*api.getZoom()/6))
      let last:Point|null=null
      for(let i=0;i<=steps;i++){
        const p=path.getPointAtLength(length*i/steps),point=matrix?new DOMPoint(p.x,p.y).matrixTransform(matrix):p
        if(inside(point)||last&&[{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}].some((corner,index,corners)=>segmentsCross(last!,point,corner,corners[(index+1)%4])))return true
        last=point
      }
      return false
    }).map(path=>path.dataset.editorEdge!)
    select({nodes:selectionRef.current.nodes,edges:[...new Set([...selectionRef.current.edges,...hits])]})
  }
  const dragStart=(_event:unknown,node:FlowNode)=>{
    if(disabled)return
    const group=node.type==='group'?node.data.view.data as EditorGroup:groups.find(item=>item.nodes.includes(node.id))
    const ids=group&&node.type==='group'?group.nodes:selectionRef.current.nodes.includes(node.id)&&selectionRef.current.nodes.length>1?selectionRef.current.nodes:group?.nodes??[node.id]
    select({nodes:ids,edges:[]})
    drag.current={pointer:downPoint.current,zoom:api.getZoom(),anchor:{...(projection.find(item=>item.id===node.id)?.position??node.position)},starts:Object.fromEntries(live.current.nodes.filter(item=>ids.includes(item.id)&&item.draggable!==false).map(item=>[item.id,{...item.position}]))}
    setMenu(null)
  }
  const dragMove=(event:unknown,node:FlowNode)=>{
    const current=drag.current;if(!current||disabled)return
    const mouse=event as MouseEvent
    const dx=current.pointer&&Number.isFinite(mouse.clientX)?(mouse.clientX-current.pointer.x)/current.zoom:node.position.x-current.anchor.x,dy=current.pointer&&Number.isFinite(mouse.clientY)?(mouse.clientY-current.pointer.y)/current.zoom:node.position.y-current.anchor.y
    setNodes(previous=>withGroupBounds(previous.map(item=>current.starts[item.id]?{...item,position:{x:current.starts[item.id].x+dx,y:current.starts[item.id].y+dy}}:item),groups))
  }
  const dragStop=(event:unknown,node:FlowNode)=>{
    const current=drag.current;if(!current){setNodes(projection);return}
    drag.current=null
    if(disabled){setNodes(projection);return}
    const mouse=event as MouseEvent
    const dx=current.pointer&&Number.isFinite(mouse.clientX)?(mouse.clientX-current.pointer.x)/current.zoom:node.position.x-current.anchor.x,dy=current.pointer&&Number.isFinite(mouse.clientY)?(mouse.clientY-current.pointer.y)/current.zoom:node.position.y-current.anchor.y
    if(Math.abs(dx)+Math.abs(dy)<.01)return
    props.onMove?.(Object.fromEntries(Object.entries(current.starts).map(([id,p])=>[id,{x:p.x+dx,y:p.y+dy}])))
  }
  const valid=(connection:Connection|FlowEdge)=>{
    if(disabled||features.connections===false)return false
    const normalized=normalizeConnection(props.nodes,{source:connection.source,target:connection.target,sourcePort:connection.sourceHandle??'',targetPort:connection.targetHandle??''})
    return !!normalized&&(props.canConnect?.(normalized)??true)
  }
  const openMenu=(event:{preventDefault():void;clientX:number;clientY:number},kind:MenuContext['kind'],id?:string)=>{
    event.preventDefault();if(disabled||suppressContext.current)return
    if(kind==='node'&&id&&!selectionRef.current.nodes.includes(id)){
      const group=groups.find(item=>item.nodes.includes(id));select({nodes:group?.nodes??[id],edges:[]})
    }
    if(kind==='edge'&&id&&!selectionRef.current.edges.includes(id))select({nodes:[],edges:[id]})
    if(kind==='group'){const group=groups.find(item=>item.id===id);if(group)select({nodes:group.nodes,edges:[]})}
    setMenu({kind,id,selection:selectionRef.current,position:api.screenToFlowPosition({x:event.clientX,y:event.clientY}),x:event.clientX,y:event.clientY})
  }
  const remove=()=>{
    if(disabled)return
    const nodes=selectionRef.current.nodes.filter(id=>props.nodes.find(node=>node.id===id)?.deletable!==false)
    if(nodes.length||selectionRef.current.edges.length)props.onDelete?.({nodes,edges:selectionRef.current.edges})
  }
  useImperativeHandle(ref,()=>({fit:()=>{void api.fitView({padding:.15})},focus:(id)=>{const node=api.getNode(id);if(node)void api.setCenter(node.position.x+(node.width??216)/2,node.position.y+(node.height??100)/2,{zoom:api.getZoom()})},zoom:(delta)=>{void api.zoomTo(Math.max(interaction.minZoom??MIN_CANVAS_ZOOM,Math.min(interaction.maxZoom??MAX_CANVAS_ZOOM,api.getZoom()+delta)))},center:()=>{const rect=root.current!.getBoundingClientRect();return api.screenToFlowPosition({x:rect.left+rect.width/2,y:rect.top+rect.height/2})}}),[api,interaction.minZoom,interaction.maxZoom])
  useEffect(()=>{
    if(initialized.current||!nodes.length)return
    initialized.current=true
    const node=props.nodes.find(node=>node.id===props.initialFocusId)??props.nodes[0]
    if(node)void api.setViewport({x:64-node.position.x,y:64-node.position.y,zoom:1})
  },[nodes.length,api,props.initialFocusId,props.nodes])
  const cancel=useCallback(()=>{
    knife.current=null;setKnifeView(null);lastBlank.current=null;setMenu(null);keyboardPort.current=null;store.getState().cancelConnection()
    if(drag.current){drag.current=null;setNodes(projection)}
  },[projection,store,setKnifeView,setMenu])
  useEffect(()=>{if(disabled)cancel()},[disabled,cancel])
  useEffect(()=>{window.addEventListener('blur',cancel);return()=>window.removeEventListener('blur',cancel)},[cancel])
  const knifeMove=(event:React.PointerEvent<HTMLDivElement>)=>{
    const current=knife.current;if(!current||current.pointer!==event.pointerId)return
    const point={x:event.clientX,y:event.clientY},last=current.points.at(-1)!
    if(Math.hypot(point.x-last.x,point.y-last.y)<1)return
    for(const path of current.paths)if(!current.cuts.has(path.id)&&path.points.some((p,i)=>i>0&&segmentsCross(last,point,path.points[i-1],p)))current.cuts.add(path.id)
    current.points.push(point);setKnifeView({...current})
  }
  const knifeEnd=(event:React.PointerEvent<HTMLDivElement>,aborted=false)=>{
    const current=knife.current;if(!current||current.pointer!==event.pointerId)return
    if(!aborted)knifeMove(event)
    knife.current=null;setKnifeView(null);lastBlank.current=null
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
    if(!aborted&&!disabled&&current.cuts.size)props.onCut?.([...current.cuts])
  }
  const selectedGroup=groups.find(group=>group.nodes.length===selection.nodes.length&&group.nodes.every(id=>selection.nodes.includes(id)))
  const menuItems=menu?[
    ...(features.arrange!==false&&menu.selection.nodes.length>1?[{label:'智能排版',action:()=>props.onArrange?props.onArrange(menu.selection.nodes):props.onMove?.(arrangeNodes(props.nodes,menu.selection.nodes))}]:[]),
    ...(features.groups!==false&&menu.selection.nodes.length>1?(selectedGroup?[...(props.onRenameGroup?[{label:'重命名 Group…',action:()=>setEditingGroup(selectedGroup.id)}]:[]),{label:'解除 Group',action:()=>props.onUngroup?.(selectedGroup.id)}]:[{label:`Group · ${menu.selection.nodes.length} 项`,action:()=>props.onGroup?.(menu.selection.nodes)}]):[]),
    ...(props.menuItems?.(menu)??[]),
    ...(menu.selection.nodes.some(id=>props.nodes.find(node=>node.id===id)?.deletable!==false)||menu.selection.edges.length?[{label:'删除所选',action:remove}]:[]),
  ]:[]
  const connectKeyboard=(id:string,port:string)=>{
    if(disabled||features.connections===false)return
    const start=keyboardPort.current
    if(!start){keyboardPort.current={node:id,port};return}
    if(start.node===id&&start.port===port){keyboardPort.current=null;return}
    const connection=normalizeConnection(props.nodes,{source:start.node,target:id,sourcePort:start.port,targetPort:port})
    if(connection&&(props.canConnect?.(connection)??true)){keyboardPort.current=null;props.onConnect?.(connection)}
  }
  return <CutContext.Provider value={knifeView?.cuts??EMPTY_CUTS}><PortContext.Provider value={connectKeyboard}><GroupContext.Provider value={{rename:(id,name)=>{if(!disabled)props.onRenameGroup?.(id,name)},readOnly:!!disabled,selectedNodes:selection.nodes,editingGroup,editGroup:setEditingGroup}}>
    <div ref={root} className={`node-editor${knifeView?' is-cutting':''}`} tabIndex={0} aria-label="节点画布，可拖拽框选或右键创建节点"
      onKeyDownCapture={event=>{
        if((event.target as Element).closest('input,textarea,[contenteditable="true"]'))return
        if(event.key==='Escape'){event.preventDefault();cancel();return}
        if(disabled)return
        if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){
          event.preventDefault();event.stopPropagation()
          const wrapper=(event.target as Element).closest<HTMLElement>('.react-flow__node'),node=wrapper?api.getNode(wrapper.dataset.id!):undefined
          const rect=wrapper?.getBoundingClientRect()??event.currentTarget.getBoundingClientRect()
          openMenu({preventDefault(){},clientX:rect.left+20,clientY:rect.top+20},node?.type==='group'?'group':node?'node':'pane',node?.type==='group'?(node.data.view.data as EditorGroup).id:node?.id)
        }
        if((event.key==='Enter'||event.key==='F2')&&selection.nodes.length===1){event.preventDefault();props.onNodeDoubleClick?.(selection.nodes[0])}
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&(event.target as Element).closest('.react-flow__node')){
          event.preventDefault();event.stopPropagation();const step=event.shiftKey?40:10,ids=new Set(selection.nodes)
          for(const group of groups)if(group.nodes.some(id=>ids.has(id)))for(const id of group.nodes)ids.add(id)
          props.onMove?.(Object.fromEntries(props.nodes.filter(node=>ids.has(node.id)&&node.draggable!==false).map(node=>[node.id,{x:node.position.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),y:node.position.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)}])))
        }
        if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();event.stopPropagation();remove()}
        if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='g'&&features.groups!==false){event.preventDefault();event.stopPropagation();if(event.shiftKey&&selectedGroup)props.onUngroup?.(selectedGroup.id);else if(selection.nodes.length>1)props.onGroup?.(selection.nodes)}
      }}
      onPointerDownCapture={event=>{
        if(event.button===0)downPoint.current={x:event.clientX,y:event.clientY}
        if(event.button===2){rightDown.current={x:event.clientX,y:event.clientY};suppressContext.current=false;setMenu(null);return}
        if(disabled||features.knife===false||event.button!==0||!(event.target as Element).classList.contains('react-flow__pane'))return
        const previous=lastBlank.current;lastBlank.current={x:event.clientX,y:event.clientY,at:event.timeStamp}
        if(!previous||event.timeStamp-previous.at>500||Math.hypot(previous.x-event.clientX,previous.y-event.clientY)>6)return
        event.preventDefault();event.stopPropagation()
        const paths=[...(root.current?.querySelectorAll<SVGPathElement>('[data-editor-edge]')??[])].map(path=>{
          const transform=path.getScreenCTM(),length=path.getTotalLength(),steps=Math.max(16,Math.ceil(length*api.getZoom()/3))
          return {id:path.dataset.editorEdge!,points:Array.from({length:steps+1},(_,i)=>{const p=path.getPointAtLength(length*i/steps);const point=new DOMPoint(p.x,p.y);return transform?point.matrixTransform(transform):point})}
        })
        knife.current={pointer:event.pointerId,points:[{x:event.clientX,y:event.clientY}],cuts:new Set(),paths};setKnifeView({...knife.current});event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMoveCapture={event=>{
        if(rightDown.current&&Math.hypot(event.clientX-rightDown.current.x,event.clientY-rightDown.current.y)>4)suppressContext.current=true
        if(knife.current){event.preventDefault();event.stopPropagation();knifeMove(event)}
      }} onPointerUpCapture={event=>{if(event.button===2){rightDown.current=null;setTimeout(()=>{suppressContext.current=false},100)}if(knife.current){event.stopPropagation();knifeEnd(event)}}}
      onPointerCancel={event=>knifeEnd(event,true)} onLostPointerCapture={event=>knifeEnd(event,true)}>
      <ReactFlow<FlowNode,FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={changes=>setNodes(previous=>applyNodeChanges(changes.filter(change=>!disabled||change.type==='dimensions'),previous))}
        onEdgesChange={(changes:EdgeChange<FlowEdge>[])=>setEdges(previous=>applyEdgeChanges(changes,previous))}
        onSelectionChange={onSelectionChange} onSelectionEnd={event=>{lastBlank.current=null;selectionEnd(event)}} onNodeDragStart={dragStart} onNodeDrag={dragMove} onNodeDragStop={dragStop}
        onSelectionDragStart={(_event,items)=>{if(items[0])dragStart(_event,items[0])}} onSelectionDrag={(_event,items)=>{if(items[0])dragMove(_event,items[0])}} onSelectionDragStop={(_event,items)=>{if(items[0])dragStop(_event,items[0])}}
        onNodeClick={(event,node)=>{if(disabled)return;if(node.type==='group'){select({nodes:(node.data.view.data as EditorGroup).nodes,edges:[]});return}props.onNodeClick?.(node.id,event)}}
        onNodeDoubleClick={(_event,node)=>{if(!disabled&&node.type!=='group')props.onNodeDoubleClick?.(node.id)}}
        onEdgeDoubleClick={(_event,edge)=>{if(!disabled)props.onEdgeDoubleClick?.(edge.id)}}
        onNodeContextMenu={(event,node)=>openMenu(event,node.type==='group'?'group':'node',node.type==='group'?(node.data.view.data as EditorGroup).id:node.id)}
        onEdgeContextMenu={(event,edge)=>openMenu(event,'edge',edge.id)} onPaneContextMenu={event=>{
          // Right-button pan end can report a pane context menu even when a
          // non-draggable node was clicked. Resolve its real hit target again.
          const target=event.target instanceof Element?event.target:null
          const nodeElement=target?.closest<HTMLElement>('.react-flow__node[data-id]')
          const node=nodes.find(item=>item.id===nodeElement?.dataset.id)
          const edgeElement=target?.closest<SVGElement>('[data-editor-edge]')
          if(node)openMenu(event,node.type==='group'?'group':'node',node.type==='group'?(node.data.view.data as EditorGroup).id:node.id)
          else if(edgeElement?.dataset.editorEdge)openMenu(event,'edge',edgeElement.dataset.editorEdge)
          else openMenu(event,'pane')
        }}
        onConnect={connection=>{if(!valid(connection))return;const result=normalizeConnection(props.nodes,{source:connection.source,target:connection.target,sourcePort:connection.sourceHandle??'',targetPort:connection.targetHandle??''});if(result)props.onConnect?.(result)}}
        isValidConnection={valid} connectionMode={ConnectionMode.Loose} connectOnClick connectionRadius={22} connectionLineComponent={ConnectionPreview}
        nodesDraggable={!disabled} nodesConnectable={!disabled&&features.connections!==false} elementsSelectable={features.selection!==false&&props.active!==false}
        selectionOnDrag={features.selection!==false&&!disabled} selectionMode={SelectionMode.Partial} selectionKeyCode={null} multiSelectionKeyCode="Shift"
        panOnDrag={interaction.panOnDrag??[2]} panOnScroll={false} zoomOnScroll={interaction.zoomOnScroll??true} zoomOnDoubleClick={false} zoomOnPinch minZoom={interaction.minZoom??MIN_CANVAS_ZOOM} maxZoom={interaction.maxZoom??MAX_CANVAS_ZOOM}
        deleteKeyCode={null} autoPanOnNodeDrag={false} autoPanOnConnect={false}
        onMoveStart={()=>setMenu(null)} onMove={(_event,viewport)=>props.onViewportChange?.(viewport)} onlyRenderVisibleElements={props.nodes.length>300}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#3c3c3c"/>
        {props.toolbar}
      </ReactFlow>
      {knifeView&&<svg className="node-editor-knife" style={{left:-root.current!.getBoundingClientRect().left,top:-root.current!.getBoundingClientRect().top}}><polyline points={knifeView.points.map(p=>`${p.x},${p.y}`).join(' ')}/><image href={knifeIcon} x={knifeView.points.at(-1)!.x-2} y={knifeView.points.at(-1)!.y-22} width="24" height="24"/></svg>}
      {menu&&menuItems.length>0&&<NodeContextMenu x={menu.x} y={menu.y} title={menu.kind==='pane'?'节点画布':menu.kind==='group'?'Group 操作':menu.kind==='edge'?'连接操作':'节点操作'} label="节点编辑操作" items={menuItems} onClose={()=>setMenu(null)} boundary={root}/>}
    </div>
  </GroupContext.Provider></PortContext.Provider></CutContext.Provider>
})

export const NodeEditor=forwardRef<NodeEditorApi,NodeEditorProps>(function NodeEditor(props,ref){
  return <ReactFlowProvider key={props.documentId}><EditorSurface {...props} ref={ref}/></ReactFlowProvider>
})
