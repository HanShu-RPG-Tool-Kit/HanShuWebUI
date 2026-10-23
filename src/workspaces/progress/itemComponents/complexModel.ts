import type {NbtValue} from '../tnbtJson'

export const identifier = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
export const operations = {add_value:'直接增加', add_multiplied_base:'增加基础值比例', add_multiplied_total:'增加总值比例'} as const
export const slots = {any:'任意槽位',mainhand:'主手',offhand:'副手',hand:'双手',head:'头部',chest:'胸部',legs:'腿部',feet:'脚部',armor:'盔甲',body:'身体',saddle:'鞍'} as const
export const stringTag = (value:string):NbtValue => ({type:'string',value})
export const numeric = (v:NbtValue|undefined):number|undefined => v && ['byte','short','int','long','float','double'].includes(v.type) && Number.isFinite(Number(v.value)) ? Number(v.value) : undefined
export function acceptsEnchantments(v:NbtValue):boolean {
  return v.type==='compound' && Object.entries(v.value).every(([id,n])=> {
    const level=numeric(n)
    return identifier.test(id) && ['byte','short','int'].includes(n.type) && level!==undefined && Number.isInteger(level) && level>=1 && level<=255
  })
}
export function renameEnchantment(value:NbtValue,from:string,to:string):NbtValue {
  if(value.type!=='compound'||!identifier.test(to)||!Object.hasOwn(value.value,from)||(from!==to&&Object.hasOwn(value.value,to))) throw Error('附魔 ID 无效或重复')
  return {...value,value:Object.fromEntries(Object.entries(value.value).map(([id,v])=>[id===from?to:id,v]))}
}
export function acceptsAttributes(v:NbtValue):boolean {
  if(v.type!=='list')return false
  const seen=new Set<string>()
  return v.value.every(n=> {
    if(n.type!=='compound' || n.value.type?.type!=='string' || !identifier.test(n.value.type.value)
      || n.value.id?.type!=='string' || !identifier.test(n.value.id.value) || numeric(n.value.amount)===undefined
      || n.value.operation?.type!=='string' || !Object.hasOwn(operations,n.value.operation.value)
      || (n.value.slot && n.value.slot.type!=='string'))return false
    const key=JSON.stringify([n.value.type.value,n.value.id.value])
    if(seen.has(key))return false
    seen.add(key);return true
  })
}
export function patchAttribute(value:NbtValue,index:number,patch:Record<string,NbtValue>):NbtValue {
  if(value.type!=='list'||value.value[index]?.type!=='compound') throw Error('属性修改器结构无效')
  const next={...value.value[index],value:{...value.value[index].value,...patch}}
  if(!acceptsAttributes({type:'list',value:[next]})) throw Error('属性修改器字段无效')
  if(value.value.some((n,i)=>i!==index && n.type==='compound' && n.value.id?.value===next.value.id.value && n.value.type?.value===next.value.type.value)) throw Error('同一属性的修饰器 ID 重复')
  return {...value,value:value.value.map((v,i)=>i===index?next:v)}
}
export function newAttribute(value:NbtValue):NbtValue {
  const list=value.type==='list'?value.value:[]
  let index=1
  while(list.some(n=>n.type==='compound'&&n.value.id?.value===`hanshu:modifier_${index}`))index++
  return {type:'compound',value:{type:stringTag('minecraft:attack_damage'),id:stringTag(`hanshu:modifier_${index}`),amount:{type:'double',value:'1'},operation:stringTag('add_value'),slot:stringTag('mainhand')}}
}
export function setLiteralText(value:NbtValue|undefined,text:string):NbtValue {
  if(!value || value.type==='string')return stringTag(text)
  if(value.type==='compound'&&value.value.text?.type==='string')return {...value,value:{...value.value,text:stringTag(text)}}
  throw Error('复杂文本请在组件树中编辑')
}
export function literalText(value:NbtValue|undefined):string|undefined {
  if(!value)return ''
  if(value.type==='string')return value.value
  if(value.type==='compound'&&value.value.text?.type==='string')return value.value.text.value
  return undefined
}
