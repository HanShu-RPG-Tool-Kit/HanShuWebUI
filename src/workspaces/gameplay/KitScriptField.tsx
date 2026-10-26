import {useId,useState} from 'react'
import {kitScriptRefs,type KitDocument} from './kit'
export type KitScriptOptions={ref:string;label:string;key:string}[]
export function KitScriptField({value,options=[],disabled,onChange,onOpen,onCreate,resourceLabel='礼包脚本'}:{value:KitDocument['script'];options?:KitScriptOptions;disabled?:boolean;onChange:(value:KitDocument['script'])=>void;onOpen?:(key:string)=>void;onCreate?:(source?:string)=>void;resourceLabel?:string}){
 const listId=useId()
 const [search,setSearch]=useState(''),[over,setOver]=useState(false)
 const legacy=typeof value==='string'&&!!value.trim(),refs=kitScriptRefs(value)
 const change=(next:string[])=>onChange(next.map(ref=>({ref})))
 const add=(ref:string)=>{if(!disabled&&!refs.includes(ref)){change([...refs,ref]);setSearch('')}}
 return <div className={`kit-script-reference${over?' is-over':''}`}
  onDragOver={e=>{if(!disabled&&(e.dataTransfer.types.includes('application/x-hanshu-progress-entry')||e.dataTransfer.types.includes('application/x-hanshu-kit-script-order'))){e.preventDefault();e.stopPropagation();setOver(true)}}}
  onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOver(false)}}
  onDrop={e=>{setOver(false);if(disabled)return;e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData('application/x-hanshu-progress-entry');const option=options.find(o=>`document:${o.key}`===id);if(option&&!legacy)add(option.ref)}}>
  {legacy?<><p role="alert">旧版内嵌代码，提取后可绑定多个脚本。</p><pre>{value as string}</pre>{onCreate&&<button type="button" disabled={disabled} onClick={()=>onCreate(value as string)}>提取为礼包脚本</button>}</>:<>
   <div className="kit-script-list">{refs.map((ref,index)=>{const selected=options.find(o=>o.ref===ref);return <div className="kit-script-row" key={ref} draggable={!disabled} onDragStart={e=>{e.dataTransfer.setData('application/x-hanshu-kit-script-order',JSON.stringify({listId,index}));e.dataTransfer.effectAllowed='move'}} onDragOver={e=>{if(!disabled&&e.dataTransfer.types.includes('application/x-hanshu-kit-script-order')){e.preventDefault();e.stopPropagation()}}} onDrop={e=>{if(disabled||!e.dataTransfer.types.includes('application/x-hanshu-kit-script-order'))return;e.preventDefault();e.stopPropagation();setOver(false);let order:{listId:string;index:number};try{order=JSON.parse(e.dataTransfer.getData('application/x-hanshu-kit-script-order'))}catch{return}if(order.listId!==listId)return;const from=order.index;if(!Number.isInteger(from)||from<0||from>=refs.length)return;const next=[...refs];next.splice(index,0,...next.splice(from,1));change(next)}}>
    <span className="kit-script-grip" title="拖动调整执行顺序">⠿</span><span className="kit-script-index">{index+1}</span>
    <button type="button" className="kit-script-link" title={selected?`打开脚本：${ref}`:`脚本不存在：${ref}`} disabled={!selected||!onOpen} onClick={()=>selected&&onOpen?.(selected.key)}>{selected?.label??ref}{!selected&&'（缺失）'}</button>
    {!disabled&&<><button type="button" className="kit-script-remove" aria-label={`上移脚本 ${index+1}`} disabled={index===0} onClick={()=>{const next=[...refs];[next[index-1],next[index]]=[next[index],next[index-1]];change(next)}}>↑</button><button type="button" className="kit-script-remove" aria-label={`下移脚本 ${index+1}`} disabled={index===refs.length-1} onClick={()=>{const next=[...refs];[next[index+1],next[index]]=[next[index],next[index+1]];change(next)}}>↓</button></>}
    {!disabled&&<button type="button" className="kit-script-remove" title="解除绑定" aria-label={`移除脚本 ${ref}`} onClick={()=>change(refs.filter(r=>r!==ref))}>×</button>}
   </div>})}</div>
   {!disabled&&<><p className="kit-script-hint">{over?'松开以绑定脚本':`从资源管理器拖入${resourceLabel}；按列表顺序执行。`}</p>
   <div className="kit-script-add"><input aria-label={`搜索${resourceLabel}`} placeholder={`搜索${resourceLabel}…`} value={search} onChange={e=>setSearch(e.target.value)}/><details><summary title="绑定或新建脚本" aria-label={`添加${resourceLabel}`}>＋</summary><div className="kit-script-menu">{options.filter(o=>!refs.includes(o.ref)&&`${o.label} ${o.ref}`.toLowerCase().includes(search.toLowerCase())).map(o=><button type="button" title={o.ref} key={o.key} onClick={e=>{add(o.ref);e.currentTarget.closest('details')?.removeAttribute('open')}}>{o.label}</button>)}{!options.some(o=>!refs.includes(o.ref)&&`${o.label} ${o.ref}`.toLowerCase().includes(search.toLowerCase()))&&<p className="kit-script-hint">没有可绑定的脚本</p>}{onCreate&&<button type="button" onClick={e=>{e.currentTarget.closest('details')?.removeAttribute('open');onCreate()}}>＋ 新建并绑定脚本</button>}</div></details></div></>}
  </>}
 </div>
}
