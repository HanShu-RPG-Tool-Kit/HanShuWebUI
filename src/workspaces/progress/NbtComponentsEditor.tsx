import {useState, useRef, type CSSProperties} from 'react'
import {NodeContextMenu, type NodeMenuItem} from './NodeContextMenu'
import {NBT_TYPES, defaultNbt, readNbt, readComponents, type NbtValue, type NbtType, type ItemComponents} from './tnbtJson'
import {ItemComponentCards} from './itemComponents/ItemComponentCards'
import './ItemEditor.css'

function Scalar({node, disabled, onChange, label = '值'}: {node:NbtValue; disabled?:boolean; onChange:(node:NbtValue)=>void; label?:string}) {
  const text = String(node.value)
  const [edit,setEdit]=useState<{base:string;raw:string;error:string}|null>(null)
  const current=edit?.base===`${node.type}:${text}`?edit:null
  const error=current?.error ?? ''

  const integer = ['byte','short','int'].includes(node.type)
  function change(raw:string) {
    try {const next=readNbt({type:node.type,value:integer ? (raw.trim() ? Number(raw) : null) : raw});setEdit(null);onChange(next)}
    catch(e) {setEdit({base:`${node.type}:${text}`,raw,error:String(e instanceof Error ? e.message : e)})}
  }
  return <input data-nbt-value className="item-tree-input" aria-label={label} aria-invalid={!!error} title={error || node.type}
    type={integer ? 'number' : 'text'} step={integer ? '1' : undefined} disabled={disabled}
    value={current?.raw ?? text} onChange={e=>change(e.target.value)} onBlur={()=>{if(!error)setEdit(null)}} />
}

function Entry({label,node,depth,root=false,array=false,disabled,onChange,onRename,onDelete}: {
  label:string;node:NbtValue;depth:number;root?:boolean;array?:boolean;disabled?:boolean;
  onChange:(node:NbtValue)=>void;onRename?:(name:string)=>string|void;onDelete?:()=>void
}) {
  const [open,setOpen]=useState(root), [rename,setRename]=useState(false), [key,setKey]=useState(label), [renameError,setRenameError]=useState('')
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null), [pending,setPending]=useState<NbtType|null>(null)
  const row=useRef<HTMLDivElement>(null)
  const container=node.type==='compound'||node.type==='list'||node.type.endsWith('_array')
  const element:NbtType|null=node.type==='byte_array'?'byte':node.type==='int_array'?'int':node.type==='long_array'?'long':null
  const addType = (type:NbtType):NodeMenuItem => ({label:type, className:`nbt-menu-type is-${type}`, disabled, action:()=>{setOpen(true);setPending(type)}})
  const addItems:NodeMenuItem[] = element ? [addType(element)] : [
    addType('string'), addType('compound'), addType('list'),
    {label:'数值', children: NBT_TYPES.filter(type=>['byte','short','int','long','float','double'].includes(type)).map(addType)},
    {label:'数值数组', children: NBT_TYPES.filter(type=>type.endsWith('_array')).map(addType)},
  ]
  const children:[string,NbtValue][] = node.type==='compound' ? Object.entries(node.value) : node.type==='list' ? node.value.map((v,i)=>[String(i),v]) : element ? (node.value as (number|string)[]).map((v,i)=>[String(i),{type:element,value:v} as NbtValue]) : []
  const replace=(name:string,child:NbtValue)=> {
    if(node.type==='compound') onChange({...node,value:{...node.value,[name]:child}})
    else if(node.type==='list') onChange({...node,value:node.value.map((v,i)=>String(i)===name?child:v)})
    else if(element) onChange({...node,value:(node.value as (string|number)[]).map((v,i)=>String(i)===name?child.value:v)} as NbtValue)
  }
  function commitRename(){const error=onRename&&key!==label?onRename(key):undefined;setRenameError(error??'');if(!error)setRename(false)}
  return <div className="item-tree-node" style={{'--item-depth':depth} as CSSProperties}>
    <div ref={row} className="item-tree-row" role="treeitem" aria-label={label || '空键'} aria-expanded={container ? open:undefined} tabIndex={0}
      onContextMenu={e=>{e.preventDefault();e.stopPropagation();setMenu({x:e.clientX,y:e.clientY})}}
      onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='F2'&&onRename&&!disabled){setKey(label);setRename(true)}if(e.key==='ArrowRight')setOpen(true);if(e.key==='ArrowLeft')setOpen(false);if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();setMenu({x:r.left+20,y:r.bottom})}}}>
      <div className="item-tree-kind"><button type="button" className={`item-tree-twist${container?'':' is-leaf'}`} disabled={!container} aria-label={open?'折叠':'展开'} onClick={()=>setOpen(!open)}>{container?(open?'▾':'▸'):'·'}</button><span className={`item-tree-badge is-${node.type}`} title={node.type}>{node.type}</span></div>
      {rename ? <input className="item-tree-key is-edit" autoFocus aria-label="组件键名" aria-invalid={!!renameError} title={renameError} value={key} onChange={e=>{setKey(e.target.value);setRenameError('')}} onBlur={commitRename} onKeyDown={e=>{if(e.key==='Enter')commitRename();if(e.key==='Escape')setRename(false)}} />
        : <button type="button" className="item-tree-key" disabled={disabled||!onRename} onDoubleClick={()=>{setKey(label);setRename(true)}}>{array?`[${label}]`:label||'""'}</button>}
      <span className="item-tree-value">{container?<span className="item-tree-summary">{children.length} 项</span>:<Scalar node={node} disabled={disabled} onChange={onChange} />}</span>
    </div>
    {menu&&<NodeContextMenu {...menu} label="组件操作" title={label} className="item-context-menu" boundary={row} items={[
      ...(container?[{label:'添加',disabled,children:addItems}]:[]),
      ...(container?[{label:open?'折叠':'展开',action:()=>setOpen(!open)}]:[]),
      ...(onRename?[{label:'重命名',disabled,action:()=>{setKey(label);setRename(true)}}]:[]),
      ...(onDelete?[{label:'删除',disabled,action:onDelete}]:[]),
    ]} onClose={(restore=true)=>{setMenu(null);if(restore)row.current?.focus({preventScroll:true})}}/>}
    {container&&open&&<div role="group" className="item-tree-children">
      {children.map(([name,child])=><Entry key={name} label={name} node={child} depth={depth+1} array={node.type!=='compound'} disabled={disabled}
        onChange={next=>{if(!disabled)replace(name,next)}}
        onRename={node.type==='compound'?(next=>{if(disabled||next===name)return;if(Object.hasOwn(node.value,next))return '键名重复';try{const value=Object.fromEntries(Object.entries(node.value).map(([k,v])=>[k===name?next:k,v]));if(root)readComponents(value);onChange({...node,value})}catch(error){return (error as Error).message}}):undefined}
        onDelete={()=>{if(disabled)return;if(node.type==='compound'){const value={...node.value};delete value[name];onChange({...node,value})}else onChange({...node,value:(node.value as unknown[]).filter((_,i)=>String(i)!==name)} as NbtValue)}}/>)}
      {pending&&<Draft type={pending} compound={node.type==='compound'} root={root} existing={children.map(([k])=>k)} disabled={disabled} onCancel={()=>setPending(null)}
        onCommit={(name,child)=>{if(disabled)return;if(node.type==='compound')onChange({...node,value:{...node.value,[name]:child}});else if(node.type==='list')onChange({...node,value:[...node.value,child]});else onChange({...node,value:[...(node.value as (string|number)[]),child.value]} as NbtValue);setPending(null)}}/>}
    </div>}
  </div>
}
function Draft({type,compound,root,existing,disabled,onCommit,onCancel}:{type:NbtType;compound:boolean;root:boolean;existing:string[];disabled?:boolean;onCommit:(key:string,node:NbtValue)=>void;onCancel:()=>void}) {
  const [key,setKey]=useState(''),[node,setNode]=useState(()=>defaultNbt(type)),[error,setError]=useState('')
  const draftRef=useRef<HTMLDivElement>(null)
  function commit(){if(disabled||draftRef.current?.querySelector('[data-nbt-value][aria-invalid=true]'))return;try{if(compound&&existing.includes(key))throw Error('键名重复');if(root)readComponents({[key]:node});onCommit(key,node)}catch(e){setError((e as Error).message)}}
  return <div ref={draftRef} className="item-tree-row item-tree-draft" tabIndex={0} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit()}if(e.key==='Escape')onCancel()}}>
    <div className="item-tree-kind"><span className={`item-tree-badge is-${type}`}>{type}</span></div>{compound?<input autoFocus className="item-tree-input" aria-label="新键名" aria-invalid={!!error} title={error} value={key} onChange={e=>{setKey(e.target.value);setError('')}} disabled={disabled}/>:<span>新元素</span>}
    <span className="item-tree-value">{type==='compound'||type==='list'||type.endsWith('_array')?<span className="item-tree-summary">空容器 · Enter 确认</span>:<Scalar node={node} disabled={disabled} onChange={setNode} label="新值"/>}</span>
    {error&&<span role="alert">{error}</span>}
  </div>
}
export function ComponentsTree({value,disabled,onChange}:{value:Record<string,unknown>;disabled?:boolean;onChange:(value:ItemComponents)=>void}) {
  const components=readComponents(value)
  return <div className="item-tree" role="tree" aria-label="物品组件"><div className="item-tree-columns" aria-hidden="true"><span>类型</span><span>组件 / 键</span><span>值</span></div>
    <Entry label="components" node={{type:'compound',value:components}} depth={0} root disabled={disabled} onChange={next=>{if(!disabled&&next.type==='compound')onChange(readComponents(next.value))}}/>
  </div>
}
export function NbtComponentsEditor({value,disabled,onChange}:{value:Record<string,unknown>;disabled?:boolean;onChange:(value:ItemComponents)=>void}) {
  return <div className="item-editor item-components-shared"><ItemComponentCards components={value} disabled={disabled} onChange={onChange}/><ComponentsTree value={value} disabled={disabled} onChange={onChange}/></div>
}
