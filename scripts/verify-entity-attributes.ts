import assert from 'node:assert/strict'
import {ENTITY_ATTRIBUTES_PROTOCOL,prepareEntityAttributes,applyEntityAttributeResult,assertEntityAttributesUnchanged,supportsEntityAttributes,type EntityAttributeDelta} from '../src/gameDevServer/entityAttributes'
import {createEntity,parseEntity,stringifyEntity} from '../src/workspaces/quest/entityDoc'
import type {NbtValue} from '../src/workspaces/quest/tnbtJson'
const string=(value:string):NbtValue=>({type:'string',value})
const modifier=(id:string,amount=2):NbtValue=>({type:'compound',value:{id:string(id),amount:{type:'int',value:amount},operation:string('add_value'),custom:{type:'long',value:'9223372036854775807'}}})
const attribute=(id:string,base=20,modifiers:NbtValue[]=[]):NbtValue=>({type:'compound',value:{id:string(id),base:{type:'double',value:String(base)},modifiers:{type:'list',value:modifiers}}})
const doc=createEntity();doc.entity.data.value.Health={type:'float',value:'7'}
const original=attribute('minecraft:max_health',20,[modifier('test:buff')]) as Extract<NbtValue,{type:'compound'}>
original.value.custom={type:'long',value:'9223372036854775807'}
doc.entity.data.value.attributes={type:'list',value:[original,attribute('minecraft:attack_damage',2),attribute('minecraft:attack_damage',3),{type:'compound',value:{legacy:string('keep')}}]}
doc.entity.data.value.Attributes={type:'compound',value:{legacy:string('do not rewrite')}}
const session=prepareEntityAttributes(doc),health=session.context.bindings.find(b=>b.attributeId==='minecraft:max_health')!,movement=session.context.bindings.find(b=>b.attributeId==='minecraft:movement_speed')!
assert(!session.context.bindings.some(b=>b.attributeId==='minecraft:attack_damage'))
const run=(ops:unknown[],candidate=doc)=>applyEntityAttributeResult(session,candidate,{protocol:ENTITY_ATTRIBUTES_PROTOCOL,operations:ops})
const base={op:'attribute.base.set',bindingId:health.bindingId,expected:20,value:40}
const change={op:'attribute.modifier.set',bindingId:health.bindingId,modifierId:'test:buff',expected:{amount:2,operation:'add_value'},value:{amount:3.5,operation:'add_multiplied_base'}}
const added={op:'attribute.modifier.set',bindingId:health.bindingId,modifierId:'test:new',expected:null,value:{amount:1,operation:'add_value'}}
const result=run([base,change,added]),nodes=result.entity.data.value.attributes
assert.equal(nodes.type,'list');if(nodes.type!=='list')throw Error('list expected')
const edited=nodes.value[0] as Extract<NbtValue,{type:'compound'}>
assert.equal(edited.value.base.value,'40');assert.deepEqual(edited.value.custom,original.value.custom)
assert.equal(edited.value.modifiers.type,'list');if(edited.value.modifiers.type!=='list')throw Error('list expected')
const changed=edited.value.modifiers.value[0] as Extract<NbtValue,{type:'compound'}>
assert.equal(changed.value.amount.value,'3.5');assert.deepEqual(changed.value.custom,{type:'long',value:'9223372036854775807'})
assert.deepEqual(nodes.value.slice(1),(doc.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>).value.slice(1))
assert.deepEqual(result.entity.data.value.Attributes,doc.entity.data.value.Attributes);assert.deepEqual(result.entity.data.value.Health,doc.entity.data.value.Health)
assert.equal(run([]),doc)
assert.deepEqual(run([{...base,value:20},{...change,value:{amount:2,operation:'add_value'}}]),doc)
assert.deepEqual(parseEntity(stringifyEntity(result)),result)
assert.throws(()=>run([{...base,bindingId:'unbound'}]),/未授权/)
assert.throws(()=>run([{...base,expected:19}]),/原值冲突/)
assert.throws(()=>run([{...change,expected:{amount:1,operation:'add_value'}}]),/原值冲突/)
assert.throws(()=>run([{...added,modifierId:'invalid id'}]),/修饰器/)
assert.throws(()=>run([{...base,path:'attributes.0.base'}]),/未授权字段/)
assert.throws(()=>run([{...base,op:'attribute.replace'}]),/未知/)
assert.throws(()=>run([base,base]),/重复/)
assert.throws(()=>run([change,change]),/重复/)
for(const value of [NaN,Infinity,-Infinity,1e13]){assert.throws(()=>run([{...base,value}]),/有限数值/);assert.throws(()=>run([{...change,value:{amount:value,operation:'add_value'}}]),/有限数值/)}
assert.throws(()=>run([{...change,value:{amount:1,operation:'unsafe'}}]),/运算方式/)
const overwritten=structuredClone(doc);delete overwritten.entity.data.value.attributes
assert.throws(()=>run([],overwritten),/不能覆盖/)
const legacy=structuredClone(doc);delete legacy.entity.data.value.Attributes;assert.throws(()=>assertEntityAttributesUnchanged(doc,legacy),/不能覆盖/)
const reordered=structuredClone(doc);if(reordered.entity.data.value.attributes.type==='list'){const node=reordered.entity.data.value.attributes.value[0];if(node.type==='compound')node.value=Object.fromEntries(Object.entries(node.value).reverse())}assertEntityAttributesUnchanged(doc,reordered)
assert.throws(()=>run([{op:'attribute.base.remove',bindingId:health.bindingId,expected:20}]),/清空修饰器/)
assert.throws(()=>run([{op:'attribute.modifier.remove',bindingId:health.bindingId,modifierId:'test:buff',expected:{amount:2,operation:'add_value'}},{op:'attribute.base.remove',bindingId:health.bindingId,expected:20}]),/未知属性字段/)
const newModifier={op:'attribute.modifier.set',bindingId:movement.bindingId,modifierId:'test:movement',expected:null,value:{amount:0.5,operation:'add_multiplied_total'}}
assert.throws(()=>run([newModifier]),/同时设置/)
const created=run([{op:'attribute.base.set',bindingId:movement.bindingId,expected:null,value:0.3},newModifier])
const createdList=created.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>
assert.equal(createdList.value.length,5)
const createdNode=createdList.value.at(-1) as Extract<NbtValue,{type:'compound'}>;assert.equal(createdNode.value.base.value,'0.3')
const simple=createEntity();simple.entity.data.value.attributes={type:'list',value:[attribute('minecraft:max_health',20,[modifier('test:buff')])]}
const simpleSession=prepareEntityAttributes(simple),binding=simpleSession.context.bindings.find(b=>b.attributeId==='minecraft:max_health')!
const removeOps:EntityAttributeDelta[]=[{op:'attribute.base.remove',bindingId:binding.bindingId,expected:20},{op:'attribute.modifier.remove',bindingId:binding.bindingId,modifierId:'test:buff',expected:{amount:2,operation:'add_value'}}]
const removed=applyEntityAttributeResult(simpleSession,simple,{protocol:ENTITY_ATTRIBUTES_PROTOCOL,operations:removeOps})
assert.deepEqual(removed.entity.data.value.attributes,{type:'list',value:[]})
const movedRow={bindingId:movement.bindingId,modifierId:'test:renamed',value:{amount:2,operation:'add_value'},origin:{bindingId:health.bindingId,modifierId:'test:buff'}}
const projection={op:'attribute.modifiers.replace',rows:[movedRow]}
const moved=run([projection,{op:'attribute.base.set',bindingId:movement.bindingId,expected:null,value:0.3}])
const movedNodes=(moved.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>).value
const destination=movedNodes.at(-1) as Extract<NbtValue,{type:'compound'}>
const movedModifier=(destination.value.modifiers as Extract<NbtValue,{type:'list'}>).value[0] as Extract<NbtValue,{type:'compound'}>
assert.deepEqual(movedModifier.value.custom,{type:'long',value:'9223372036854775807'})
assert.deepEqual(movedModifier.value.amount,{type:'int',value:2})
assert.equal(movedModifier.value.id.value,'test:renamed')
assert.deepEqual(movedNodes.slice(1,4),(doc.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>).value.slice(1))
assert.throws(()=>run([projection]),/同时设置/)
assert.throws(()=>run([{...projection,rows:[movedRow,movedRow]}]),/重复/)
assert.throws(()=>run([{...projection,rows:[{...movedRow,origin:{bindingId:health.bindingId,modifierId:'test:forged'}}]}]),/未授权/)
assert.throws(()=>run([{...projection,rows:[movedRow,{...movedRow,modifierId:'test:other'}]}]),/重复使用/)
assert(!await supportsEntityAttributes(async()=>({protocols:['hanshu-entity-attributes-v1']})))
// Later mutation of the caller's draft cannot revise open's expected values.
;(doc.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>).value[0]=attribute('minecraft:max_health',99)
assert.equal(session.context.bindings.find(b=>b.attributeId==='minecraft:max_health')!.base,20)
assert.equal((session.original.entity.data.value.attributes as Extract<NbtValue,{type:'list'}>).value[0].type,'compound')
const duplicateModifiers=createEntity();duplicateModifiers.entity.data.value.attributes={type:'list',value:[attribute('minecraft:max_health',20,[modifier('test:duplicate'),modifier('test:duplicate')])]}
assert(!prepareEntityAttributes(duplicateModifiers).context.bindings.some(binding=>binding.attributeId==='minecraft:max_health'))
const oversized=createEntity();oversized.entity.data.value.attributes={type:'list',value:[attribute('minecraft:max_health',1e13),attribute('minecraft:attack_damage',2,[modifier('test:huge',1e13)])]}
assert(!prepareEntityAttributes(oversized).context.bindings.some(binding=>binding.attributeId==='minecraft:max_health'||binding.attributeId==='minecraft:attack_damage'))
const malformed=createEntity();malformed.entity.data.value.attributes={type:'compound',value:{keep:string('advanced')}}
assert.deepEqual(prepareEntityAttributes(malformed).context.bindings,[])
assert(await supportsEntityAttributes(async()=>({protocols:[ENTITY_ATTRIBUTES_PROTOCOL]})))
assert(!await supportsEntityAttributes(async()=>({protocols:['hanshu-localization-v1']})))
assert(!await supportsEntityAttributes(async()=>{throw Error('old peer')}))
console.log('PASS entity attributes: granular CAS, explicit authority, native/legacy replacement rejection, unknown metadata preservation, add/remove, immutable baseline, duplicate IDs and capability fallback')

assert(prepareEntityAttributes(createEntity(),["minecraft:armor"]).context.bindings.some(b=>b.attributeId==="minecraft:armor"))
