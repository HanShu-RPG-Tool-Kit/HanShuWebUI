import { useMemo,useState } from 'react'
import { NodeEditor } from './NodeEditor'
import { NodeFrame, NodeHeader, PortLabel, NodeField } from './NodeParts'
import { NoteNode } from './NoteNode'
import type { EditorEdge,EditorGroup,EditorNode,NodeRegistry,NodeViewProps } from './types'
function Card({node,selected,dragging,readOnly}:NodeViewProps){return <NodeFrame selected={selected} dragging={dragging}><NodeHeader title={node.label} color="#48616b"/><NodeField label="数值"><input type="number" aria-label={`${node.label}数值`} defaultValue={1} disabled={readOnly}/></NodeField>{node.ports.map(port=><PortLabel key={port.id} direction={port.direction} y={port.y}>{port.label}</PortLabel>)}</NodeFrame>}

const registry:NodeRegistry={card:{component:Card},note:{component:NoteNode}}
/** Executable integration example; never reads or writes project resources. */
export function NodeEditorExample(){
  const [positions,setPositions]=useState<Record<string,{x:number;y:number}>>({a:{x:64,y:64},b:{x:400,y:64},c:{x:64,y:280},note:{x:700,y:300}})
  const [edges,setEdges]=useState<EditorEdge[]>([{id:'e1',source:'a',target:'b',sourcePort:'out',targetPort:'in'}])
  const [groups,setGroups]=useState<EditorGroup[]>([])
  const [readOnly,setReadOnly]=useState(false)
  const [moves,setMoves]=useState(0)
  const [note,setNote]=useState({title:'设计注释',text:'双击编辑这段说明',color:'slate',width:240,height:150})
  const nodes:EditorNode[]=useMemo(()=>Object.entries(positions).map(([id,position])=>id==='note'?{
    id,type:'note',position,width:note.width,height:note.height,label:'设计注释',ports:[],data:{...note,onChange:(patch:Partial<typeof note>)=>setNote(previous=>({...previous,...patch}))}
  }:{id,type:'card',position,width:216,height:108,label:`示例 ${id}`,deletable:id!=='a',ports:[{id:'in',direction:'input',label:'输入',y:64},{id:'out',direction:'output',label:'输出',y:64}],data:{}}),[positions,note])

  return <div style={{display:'flex',flexDirection:'column',height:'100vh',background:'#222'}}><div style={{color:'#ddd',padding:8}}><button onClick={()=>setReadOnly(!readOnly)}>切换只读</button><output aria-label="移动提交次数">{moves}</output></div><NodeEditor documentId="independent-example" registry={registry} nodes={nodes} edges={edges} groups={groups} readOnly={readOnly}
    onMove={next=>{setMoves(n=>n+1);setPositions(previous=>({...previous,...next}))}}
    canConnect={connection=>connection.source!==connection.target}
    onConnect={connection=>setEdges(previous=>[...previous,{...connection,id:`e${Date.now()}`}])}
    onDelete={selection=>{setPositions(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>!selection.nodes.includes(id))));setEdges(previous=>previous.filter(edge=>!selection.edges.includes(edge.id)&&!selection.nodes.includes(edge.source)&&!selection.nodes.includes(edge.target)))}}
    onCut={ids=>setEdges(previous=>previous.filter(edge=>!ids.includes(edge.id)))}
    onGroup={ids=>setGroups([{id:'g1',name:'示例分组',nodes:ids}])} onUngroup={()=>setGroups([])} onRenameGroup={(id,name)=>setGroups(previous=>previous.map(group=>group.id===id?{...group,name}:group))}/></div>
}
