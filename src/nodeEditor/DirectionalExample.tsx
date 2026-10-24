import { useMemo, useRef, useState } from 'react'
import { NodeEditor, NodeFrame, NodeHeader, PortLabel, type EditorNode, type EditorEdge, type NodeRegistry, type NodeViewProps, type NodeEditorApi, type PortSide } from './index'

type Orientation = 'down' | 'up' | 'right' | 'left'
const directions: Record<Orientation, [PortSide, PortSide]> = {down:['top','bottom'],up:['bottom','top'],right:['left','right'],left:['right','left']}
function Card({node,selected,dragging}:NodeViewProps){return <NodeFrame selected={selected} dragging={dragging}>
  <div style={{padding:'28px 12px'}}><NodeHeader title={node.label} color="#48616b"/></div>
  {node.ports.map(port=><PortLabel key={port.id} direction={port.direction} side={port.side} x={port.x} y={port.y}>{port.label}</PortLabel>)}
</NodeFrame>}
const registry:NodeRegistry={directional:{component:Card}}
/** Directional rendering example, not a behavior-tree runtime or a persisted document format. */
export function DirectionalExample(){
  const [orientation,setOrientation]=useState<Orientation>('down'),[reverse,setReverse]=useState(false),[offset,setOffset]=useState(108)
  const [edges,setEdges]=useState<EditorEdge[]>([{id:'first',source:'root',target:'a',sourcePort:'out',targetPort:'in'}])
  const api=useRef<NodeEditorApi>(null)
  const nodes=useMemo<EditorNode[]>(()=>{
    const [input,output]=directions[orientation],vertical=orientation==='down'||orientation==='up'
    const positions=vertical?{root:{x:300,y:orientation==='down'?50:350},a:{x:60,y:orientation==='down'?300:50},b:{x:540,y:orientation==='down'?300:50}}:{root:{x:orientation==='right'?60:540,y:200},a:{x:orientation==='right'?400:60,y:50},b:{x:orientation==='right'?400:60,y:350}}
    return (['root','a','b'] as const).map(id=>({id,type:'directional',position:positions[id],width:216,height:108,label:id==='root'?'父节点':`子节点 ${id}`,ports:[{id:'in',direction:'input',side:reverse?output:input,x:offset,y:54,label:'输入'},{id:'out',direction:'output',side:reverse?input:output,x:offset,y:54,label:'输出'}],data:{}}))
  },[orientation,reverse,offset])
  return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'#222',color:'#ddd'}}>
    <header style={{padding:8,display:'flex',gap:10}}><label>方向 <select aria-label="布局方向" value={orientation} onChange={event=>setOrientation(event.target.value as Orientation)}>{Object.entries({down:'向下',up:'向上',right:'向右',left:'向左'}).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <button onClick={()=>api.current?.fit()}>显示全部</button><button onClick={()=>setReverse(value=>!value)}>交换端口方位</button><button onClick={()=>setOffset(value=>value===108?68:108)}>移动端口</button>
    </header>
    <NodeEditor ref={api} documentId="direction-example" registry={registry} nodes={nodes} edges={edges} features={{groups:false}}
      canConnect={connection=>connection.source==='root'&&connection.target!=='root'&&!edges.some(edge=>edge.target===connection.target)}
      onConnect={connection=>setEdges(previous=>[...previous,{...connection,id:'second'}])}
      onDelete={selection=>setEdges(previous=>previous.filter(edge=>!selection.edges.includes(edge.id)))}
      onCut={ids=>setEdges(previous=>previous.filter(edge=>!ids.includes(edge.id)))}/>
  </div>
}
