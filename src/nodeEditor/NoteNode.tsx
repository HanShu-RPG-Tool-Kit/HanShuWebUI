import { useEffect,useRef,useState } from 'react'
import { useViewport } from '@xyflow/react'
import type { NodeViewProps } from './types'
export type NoteData = { title:string;text:string;color:string;onChange:(patch:{title?:string;text?:string;width?:number;height?:number})=>void }
export function NoteNode({node,selected,readOnly}:NodeViewProps){
  const data=node.data as NoteData,viewport=useViewport()
  const resize=useRef<{pointer:number;x:number;y:number;width:number;height:number;size:{width:number;height:number}}|null>(null)
  const [size,setSize]=useState<{width:number;height:number}|null>(null)
  const move=(event:React.PointerEvent<HTMLButtonElement>)=>{const current=resize.current;if(!current||current.pointer!==event.pointerId)return;current.size={width:Math.max(160,current.width+(event.clientX-current.x)/viewport.zoom),height:Math.max(96,current.height+(event.clientY-current.y)/viewport.zoom)};setSize(current.size)}
  const end=(event:React.PointerEvent<HTMLButtonElement>,cancel=false)=>{const current=resize.current;if(!current||current.pointer!==event.pointerId)return;if(!cancel)move(event);resize.current=null;setSize(null);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(!cancel&&!readOnly)data.onChange(current.size)}
  const [draft,setDraft]=useState<{title:string;text:string}|null>(null)
  const done=useRef(false)
  useEffect(()=>{if(readOnly){resize.current=null;setSize(null);setDraft(null)}},[readOnly])
  useEffect(()=>{const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'&&resize.current){resize.current=null;setSize(null)}};window.addEventListener('keydown',cancel);return()=>window.removeEventListener('keydown',cancel)},[])
  const finish=(save:boolean)=>{if(done.current)return;done.current=true;if(draft&&save&&!readOnly)data.onChange(draft);setDraft(null)}
  return <div className={`node-editor-note is-${data.color}${selected?' is-selected':''}`} style={size??undefined} onDoubleClick={event=>{event.stopPropagation();if(!readOnly){done.current=false;setDraft({title:data.title,text:data.text})}}}>
    {selected&&!readOnly&&!draft&&<button className="node-editor-note-resize nodrag nopan" type="button" aria-label="调整注释大小" onPointerDown={event=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();resize.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,width:node.width,height:node.height,size:{width:node.width,height:node.height}};event.currentTarget.setPointerCapture(event.pointerId)
    }} onPointerMove={move} onPointerUp={event=>end(event)} onPointerCancel={event=>end(event,true)} onLostPointerCapture={event=>end(event,true)} onKeyDown={event=>{
      if(event.key==='Escape'&&resize.current){event.preventDefault();event.stopPropagation();resize.current=null;setSize(null)}
    }}><svg viewBox="0 0 16 16" aria-hidden><path d="m5 13 8-8m-3 8 3-3"/></svg></button>}

    {draft?<div className="node-editor-note-edit nodrag nopan" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))finish(true)}} onKeyDown={event=>{
      event.stopPropagation();if(event.nativeEvent.isComposing)return
      if(event.key==='Escape'){event.preventDefault();finish(false)}
      if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();finish(true)}
    }}><input aria-label="注释标题" value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/><textarea autoFocus aria-label="注释内容" value={draft.text} onChange={event=>setDraft({...draft,text:event.target.value})}/></div>:<><header>{data.title||'注释'}</header><p>{data.text||'双击写下说明…'}</p></>}
  </div>
}
