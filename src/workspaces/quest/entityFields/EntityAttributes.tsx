import {useId,useState} from 'react'
import {COMMON_ENTITY_ATTRIBUTES,ENTITY_ATTRIBUTE_OPERATIONS,canRemoveEntityAttribute,readEntityAttribute,type EntityAttributeOperation} from '../../../gameDevServer/entityAttributes'
import type {NbtValue} from '../tnbtJson'
import type {EntityFieldEditorProps} from './registry'
const identifier=/^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const operations:Record<EntityAttributeOperation,string>={add_value:'直接增加',add_multiplied_base:'增加基础值比例',add_multiplied_total:'增加总值比例'}
const string=(value:string):NbtValue=>({type:'string',value})
function NumberField({label,value,disabled,onCommit,allowEmpty=false}:{label:string;value:number|undefined;disabled:boolean;onCommit:(value:number|undefined)=>void;allowEmpty?:boolean}){
 const source=value===undefined?'':String(value),[draft,setDraft]=useState<{base:string;text:string;error:string}|null>(null),current=draft?.base===source?draft:null
 function commit(){if(disabled||!current)return;try{const raw=current.text.trim(),n=raw===''?undefined:Number(raw);if(n===undefined&&!allowEmpty)throw Error('此字段需要明确的数值');if(n!==undefined&&(!Number.isFinite(n)||Math.abs(n)>1e12))throw Error('填写绝对值不超过 1e12 的有限数值');if(n!==value)onCommit(n);setDraft(null)}catch(error){setDraft({base:source,text:current.text,error:String(error)})}}
 return <label className="entity-attribute-number">{label}<input type="number" step="any" aria-label={label} disabled={disabled} value={current?.text??source} placeholder={allowEmpty?'沿用实体默认值':''} aria-invalid={!!current?.error} onChange={event=>setDraft({base:source,text:event.target.value,error:''})} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape'){event.stopPropagation();setDraft(null)}}}/>{current?.error&&<small role="alert">{current.error}</small>}</label>
}
export function EntityAttributeFields({data,disabled,onChange}:EntityFieldEditorProps){
 const suggestions=useId(),[adding,setAdding]=useState(''),[newBase,setNewBase]=useState('0'),[error,setError]=useState(''),[modifierDraft,setModifierDraft]=useState<Record<string,string>>({})
 const root=data.attributes,nodes=root?.type==='list'?root.value:[],ids=new Set<string>(COMMON_ENTITY_ATTRIBUTES.map(attr=>attr.id)),counts=new Map<string,number>()
 for(const node of nodes)if(node.type==='compound'&&node.value.id?.type==='string'){ids.add(node.value.id.value);counts.set(node.value.id.value,(counts.get(node.value.id.value)??0)+1)}
 const unsupported=nodes.filter(node=>node.type!=='compound'||node.value.id?.type!=='string')
 function replace(id:string,node:NbtValue|undefined){
  if(disabled)return
  const at=nodes.findIndex(node=>node.type==='compound'&&node.value.id?.type==='string'&&node.value.id.value===id),next=[...nodes]
  if(node){if(at<0)next.push(node);else next[at]=node}else if(at>=0)next.splice(at,1)
  onChange({...data,attributes:{type:'list',value:next}})
 }
 function newAttribute(){if(disabled)return;try{if(!identifier.test(adding))throw Error('属性 ID 需要 namespace:id 格式');if(counts.has(adding)||COMMON_ENTITY_ATTRIBUTES.some(attr=>attr.id===adding))throw Error('该属性已在表单中');const base=Number(newBase);if(!newBase.trim()||!Number.isFinite(base)||Math.abs(base)>1e12)throw Error('填写有效的基础值');replace(adding,{type:'compound',value:{id:string(adding),base:{type:'double',value:String(base)}}});setAdding('');setError('')}catch(error){setError(String(error))}}
 return <div className="entity-attributes-editor">
  {root&&root.type!=='list'?<p className="entity-capability-note">此属性列表请在完整数据树中编辑。</p>:<>
   <datalist id={suggestions}>{COMMON_ENTITY_ATTRIBUTES.map(attr=><option key={attr.id} value={attr.id}>{attr.label}</option>)}</datalist>
   {[...ids].map(id=>{
    const node=nodes.find(node=>node.type==='compound'&&node.value.id?.type==='string'&&node.value.id.value===id),parsed=node?readEntityAttribute(node):null,title=COMMON_ENTITY_ATTRIBUTES.find(attr=>attr.id===id)?.label??id
    if(node&&(!parsed||(counts.get(id)??0)>1))return <section className="entity-attribute-row" key={id}><h4>{title}</h4><p className="entity-capability-note">属性格式不支持或 ID 重复，请在完整数据树中编辑。</p></section>
    const baseNode=parsed?.node??{type:'compound' as const,value:{id:string(id)}},modifiers=baseNode.value.modifiers?.type==='list'?baseNode.value.modifiers.value:[]
    const putModifier=(modifierId:string,value:NbtValue|undefined)=>{const at=modifiers.findIndex(modifier=>modifier.type==='compound'&&modifier.value.id?.type==='string'&&modifier.value.id.value===modifierId),next=[...modifiers];if(value){if(at<0)next.push(value);else next[at]=value}else if(at>=0)next.splice(at,1);replace(id,{...baseNode,value:{...baseNode.value,modifiers:{type:'list',value:next}}})}
    return <section className="entity-attribute-row" key={id}><h4>{title}<code>{id}</code></h4><NumberField label={`${title}基础值`} value={parsed?.base} disabled={disabled} allowEmpty onCommit={value=>{if(value===undefined){if(!canRemoveEntityAttribute(baseNode))throw Error('先移除修饰器；含未知字段的属性记录需在完整数据树中处理');replace(id,undefined)}else replace(id,{...baseNode,value:{...baseNode.value,base:{type:'double',value:String(value)}}})}}/>
     {parsed?.modifiers.map(modifier=>{const original=modifiers.find(node=>node.type==='compound'&&node.value.id?.type==='string'&&node.value.id.value===modifier.id) as Extract<NbtValue,{type:'compound'}>;return <div className="entity-attribute-modifier" key={modifier.id}><header><code>{modifier.id}</code><button type="button" disabled={disabled} aria-label={`移除修饰器 ${id} ${modifier.id}`} onClick={()=>putModifier(modifier.id,undefined)}>×</button></header><NumberField label={`${id} ${modifier.id} 数值`} value={modifier.amount} disabled={disabled} onCommit={amount=>{if(amount!==undefined)putModifier(modifier.id,{...original,value:{...original.value,amount:{type:'double',value:String(amount)}}})}}/><label>运算方式<select aria-label={`${id} ${modifier.id} 运算方式`} disabled={disabled} value={modifier.operation} onChange={event=>{if(!disabled)putModifier(modifier.id,{...original,value:{...original.value,operation:string(event.target.value)}})}}>{ENTITY_ATTRIBUTE_OPERATIONS.map(operation=><option key={operation} value={operation}>{operations[operation]}</option>)}</select></label></div>})}
     {parsed&&<div className="entity-attribute-add-modifier"><input aria-label={`${id} 新修饰器 ID`} placeholder="namespace:modifier" disabled={disabled} value={modifierDraft[id]??''} onChange={event=>setModifierDraft({...modifierDraft,[id]:event.target.value})}/><button type="button" disabled={disabled} onClick={()=>{if(disabled)return;const next=modifierDraft[id]??'';if(!identifier.test(next)||parsed.modifiers.some(modifier=>modifier.id===next)){setError('修饰器 ID 无效或已存在');return}putModifier(next,{type:'compound',value:{id:string(next),amount:{type:'double',value:'0'},operation:string('add_value')}});setModifierDraft({...modifierDraft,[id]:''});setError('')}}>添加修饰器</button></div>}
    </section>
   })}
   {!!unsupported.length&&<p className="entity-capability-note">另有 {unsupported.length} 条属性，请在完整数据树中编辑。</p>}
   <div className="entity-attribute-create"><label>新增属性 ID<input list={suggestions} aria-label="新增属性 ID" disabled={disabled} value={adding} placeholder="namespace:attribute" onChange={event=>setAdding(event.target.value)}/></label><label>基础值<input type="number" step="any" aria-label="新增属性基础值" disabled={disabled} value={newBase} onChange={event=>setNewBase(event.target.value)}/></label><button type="button" disabled={disabled} onClick={newAttribute}>添加属性</button></div>
  </>}{error&&<p role="alert">{error}</p>}
 </div>
}
