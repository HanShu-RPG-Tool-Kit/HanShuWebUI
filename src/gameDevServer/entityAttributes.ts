import {randomId} from '../project/crypto'
import type {EntityDocument} from '../workspaces/progress/entityDoc'
import type {NbtValue} from '../workspaces/progress/tnbtJson'

export const ENTITY_ATTRIBUTES_PROTOCOL = 'hanshu-entity-attributes-v1'
export const ENTITY_ATTRIBUTE_OPERATIONS = ['add_value','add_multiplied_base','add_multiplied_total'] as const
export type EntityAttributeOperation = typeof ENTITY_ATTRIBUTE_OPERATIONS[number]
export type EntityModifierValue = {amount:number;operation:EntityAttributeOperation}
export type EntityAttributeModifier = EntityModifierValue & {id:string}
export type EntityAttributeBinding = {
  bindingId:string;attributeId:string;base:number|null;modifiers:EntityAttributeModifier[];allowedModifierIds:string[]
}
export type EntityAttributesOpen = {protocol:typeof ENTITY_ATTRIBUTES_PROTOCOL;bindings:EntityAttributeBinding[]}
export type EntityAttributeDelta =
  | {op:'attribute.base.set';bindingId:string;expected:number|null;value:number}
  | {op:'attribute.base.remove';bindingId:string;expected:number}
  | {op:'attribute.modifier.set';bindingId:string;modifierId:string;expected:EntityModifierValue|null;value:EntityModifierValue}
  | {op:'attribute.modifier.remove';bindingId:string;modifierId:string;expected:EntityModifierValue}
export type EntityAttributeSession = {readonly context:EntityAttributesOpen;readonly original:EntityDocument}
export const COMMON_ENTITY_ATTRIBUTES = [
  {id:'minecraft:max_health',label:'最大生命'},
  {id:'minecraft:attack_damage',label:'基础攻击力'},
  {id:'minecraft:movement_speed',label:'移动速度'},
] as const
const identifier=/^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const same=(a:unknown,b:unknown):boolean=>{
  if(a===b)return true
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]))
  if(!record(a)||!record(b))return false
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]))
}
export function entityAttributeNumber(value:NbtValue|undefined):number|undefined{
  if(!value||!['byte','short','int','long','float','double'].includes(value.type))return undefined
  const number=Number(value.value);return Number.isFinite(number)?number:undefined
}
export type ParsedEntityAttribute={id:string;base:number;modifiers:EntityAttributeModifier[];node:Extract<NbtValue,{type:'compound'}>}
/** Unknown fields are accepted and retained; ambiguous or unsupported known fields stay read-only. */
export function readEntityAttribute(value:NbtValue):ParsedEntityAttribute|null{
  if(value.type!=='compound'||value.value.id?.type!=='string'||!identifier.test(value.value.id.value))return null
  const base=entityAttributeNumber(value.value.base)
  if(base===undefined||Math.abs(base)>1e12||(value.value.modifiers&&value.value.modifiers.type!=='list'))return null
  const modifiers:EntityAttributeModifier[]=[]
  for(const modifier of value.value.modifiers?.type==='list'?value.value.modifiers.value:[]){
    if(modifier.type!=='compound'||modifier.value.id?.type!=='string'||!identifier.test(modifier.value.id.value)||modifier.value.operation?.type!=='string'||!ENTITY_ATTRIBUTE_OPERATIONS.includes(modifier.value.operation.value as EntityAttributeOperation))return null
    const amount=entityAttributeNumber(modifier.value.amount)
    if(amount===undefined||Math.abs(amount)>1e12||modifiers.some(other=>other.id===modifier.value.id.value))return null
    modifiers.push({id:modifier.value.id.value,amount,operation:modifier.value.operation.value as EntityAttributeOperation})
  }
  return {id:value.value.id.value,base,modifiers,node:value}
}
export function canRemoveEntityAttribute(node:Extract<NbtValue,{type:'compound'}>):boolean{
  return Object.keys(node.value).every(key=>['id','base','modifiers'].includes(key))&&(!node.value.modifiers||(node.value.modifiers.type==='list'&&!node.value.modifiers.value.length))
}
function list(document:EntityDocument){const value=document.entity.data.value.attributes;return value?.type==='list'?value.value:[]}
function bindingNode(document:EntityDocument,id:string){return list(document).find(node=>node.type==='compound'&&node.value.id?.type==='string'&&node.value.id.value===id)}
function assertFinite(value:unknown,label:string):asserts value is number{
  if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)throw Error(`${label}需要绝对值不超过 1e12 的有限数值`)
}
function modifierValue(value:unknown):EntityModifierValue{
  if(!record(value)||Object.keys(value).some(key=>!['amount','operation'].includes(key)))throw Error('属性修饰器载荷无效')
  assertFinite(value.amount,'修饰器数值')
  if(!ENTITY_ATTRIBUTE_OPERATIONS.includes(value.operation as EntityAttributeOperation))throw Error('属性修饰器运算方式无效')
  return {amount:value.amount,operation:value.operation as EntityAttributeOperation}
}
/** Freezes authority before open; the game receives only opaque bindings and explicitly allocated modifier IDs. */
export function prepareEntityAttributes(document:EntityDocument,additionalAttributes?:readonly string[]):EntityAttributeSession{
  const original=structuredClone(document),root=original.entity.data.value.attributes
  if(root&&root.type!=='list')return {original,context:{protocol:ENTITY_ATTRIBUTES_PROTOCOL,bindings:[]}}
  const nodes=list(original),counts=new Map<string,number>()
  for(const node of nodes)if(node.type==='compound'&&node.value.id?.type==='string')counts.set(node.value.id.value,(counts.get(node.value.id.value)??0)+1)
  const ids=new Set<string>([...(additionalAttributes??COMMON_ENTITY_ATTRIBUTES.map(a=>a.id)).filter(id=>identifier.test(id)),...nodes.flatMap(node=>{const parsed=readEntityAttribute(node);return parsed?[parsed.id]:[]})])
  const bindings:EntityAttributeBinding[]=[]
  for(const attributeId of ids){
    const node=bindingNode(original,attributeId),parsed=node?readEntityAttribute(node):null
    if((counts.get(attributeId)??0)>1||(node&&!parsed))continue
    const modifiers=parsed?.modifiers??[]
    bindings.push({bindingId:randomId(),attributeId,base:parsed?.base??null,modifiers:structuredClone(modifiers),allowedModifierIds:[...modifiers.map(modifier=>modifier.id),...Array.from({length:64},()=>`hanshu:${randomId()}`)]})
  }
  return {original,context:{protocol:ENTITY_ATTRIBUTES_PROTOCOL,bindings}}
}
/** Legacy peers and full candidates never get authority to replace either native or legacy attribute NBT. */
export function assertEntityAttributesUnchanged(original:EntityDocument,candidate:EntityDocument):void{
  for(const key of ['attributes','Attributes'])if(!same(original.entity.data.value[key],candidate.entity.data.value[key]))throw Error('实体属性必须使用已授权的细粒度操作，不能覆盖整个属性 NBT')
}
export async function supportsEntityAttributes(request:(method:string,params:unknown,timeout?:number)=>Promise<unknown>):Promise<boolean>{
  try{const result=await request('localization.capabilities',{},5000);return record(result)&&Array.isArray(result.protocols)&&result.protocols.includes(ENTITY_ATTRIBUTES_PROTOCOL)}catch{return false}
}
/** Validate all expected values against open's immutable snapshot, then patch only the named fields. */
export function applyEntityAttributeResult(session:EntityAttributeSession,candidate:EntityDocument,result:unknown):EntityDocument{
  assertEntityAttributesUnchanged(session.original,candidate)
  if(!record(result)||result.protocol!==ENTITY_ATTRIBUTES_PROTOCOL||!Array.isArray(result.operations)||Object.keys(result).some(key=>!['protocol','operations'].includes(key)))throw Error('实体属性回包协议无效')
  const deltas=new Map<string,{base?:EntityAttributeDelta;modifiers:EntityAttributeDelta[]}>(),seen=new Set<string>()
  for(const raw of result.operations){
    if(!record(raw)||typeof raw.op!=='string'||typeof raw.bindingId!=='string')throw Error('实体属性操作无效')
    const op=raw.op
    const binding=session.context.bindings.find(binding=>binding.bindingId===raw.bindingId)
    if(!binding)throw Error('实体属性绑定未授权')
    const baseOp=raw.op==='attribute.base.set'||raw.op==='attribute.base.remove',modifierOp=raw.op==='attribute.modifier.set'||raw.op==='attribute.modifier.remove'
    if(!baseOp&&!modifierOp)throw Error('未知实体属性操作')
    if(Object.keys(raw).some(key=>!(baseOp?['op','bindingId','expected',...(op.endsWith('.set')?['value']:[])]:['op','bindingId','modifierId','expected',...(op.endsWith('.set')?['value']:[])]).includes(key)))throw Error('实体属性操作包含未授权字段')
    const target=baseOp?`${binding.bindingId}/base`:`${binding.bindingId}/${raw.modifierId}`
    if(seen.has(target))throw Error('同一属性字段不能重复提交操作');seen.add(target)
    const edits=deltas.get(binding.bindingId)??{modifiers:[]}
    if(baseOp){
      if(raw.expected!==binding.base)throw Error('属性基础值原值冲突')
      if(raw.op==='attribute.base.set')assertFinite(raw.value,'属性基础值')
      else if(binding.base===null)throw Error('未设置的属性基础值不能移除')
      edits.base=raw as EntityAttributeDelta
    }else{
      if(typeof raw.modifierId!=='string'||!binding.allowedModifierIds.includes(raw.modifierId))throw Error('属性修饰器 ID 未授权')
      const original=binding.modifiers.find(modifier=>modifier.id===raw.modifierId),expected=original?{amount:original.amount,operation:original.operation}:null
      if(!same(raw.expected,expected))throw Error('属性修饰器原值冲突')
      if(raw.op==='attribute.modifier.set')modifierValue(raw.value)
      else if(!original)throw Error('不存在的属性修饰器不能移除')
      edits.modifiers.push(raw as EntityAttributeDelta)
    }
    deltas.set(binding.bindingId,edits)
  }
  if(!deltas.size)return candidate
  const nodes=[...list(candidate)]
  for(const [id,edits] of deltas){
    const binding=session.context.bindings.find(binding=>binding.bindingId===id)!
    const old=bindingNode(session.original,binding.attributeId),index=old?nodes.findIndex(node=>node.type==='compound'&&node.value.id?.type==='string'&&node.value.id.value===binding.attributeId):-1
    if(!old&&edits.base?.op!=='attribute.base.set')throw Error('新增属性需同时设置明确的基础值')
    const node:Extract<NbtValue,{type:'compound'}>=old?.type==='compound'?{...old,value:{...old.value}}:{type:'compound',value:{id:{type:'string',value:binding.attributeId}}}
    if(edits.modifiers.length){
      let modifiers=node.value.modifiers?.type==='list'?[...node.value.modifiers.value]:[]
      for(const delta of edits.modifiers){
        if(delta.op!=='attribute.modifier.set'&&delta.op!=='attribute.modifier.remove')continue
        const at=modifiers.findIndex(value=>value.type==='compound'&&value.value.id?.type==='string'&&value.value.id.value===delta.modifierId)
        if(delta.op==='attribute.modifier.remove')modifiers=modifiers.filter((_,index)=>index!==at)
        else{
          const original=at>=0?modifiers[at]:undefined,fields=original?.type==='compound'?original.value:{}
          const next:NbtValue={type:'compound',value:{...fields,...(at<0?{id:{type:'string' as const,value:delta.modifierId}}:{}),...(entityAttributeNumber(fields.amount)!==delta.value.amount?{amount:{type:'double' as const,value:String(delta.value.amount)}}:{}),...(fields.operation?.value!==delta.value.operation?{operation:{type:'string' as const,value:delta.value.operation}}:{})}}
          if(at<0)modifiers.push(next);else modifiers[at]=next
        }
      }
      node.value.modifiers={type:'list',value:modifiers}
    }
    if(edits.base?.op==='attribute.base.remove'){
      if(!canRemoveEntityAttribute(node))throw Error('移除基础值前需清空修饰器；含未知属性字段的记录只能在完整数据树中编辑')
      if(index>=0)nodes.splice(index,1)
      continue
    }
    if(edits.base?.op==='attribute.base.set'&&edits.base.value!==binding.base)node.value.base={type:'double',value:String(edits.base.value)}
    if(index<0)nodes.push(node);else nodes[index]=node
  }
  return {...candidate,entity:{...candidate.entity,data:{...candidate.entity.data,value:{...candidate.entity.data.value,attributes:{type:'list',value:nodes}}}}}
}
