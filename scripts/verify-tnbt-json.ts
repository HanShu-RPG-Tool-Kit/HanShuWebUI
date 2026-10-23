import assert from 'node:assert/strict'
import { readNbt, readComponents, defaultNbt, NBT_TYPES } from '../src/workspaces/progress/tnbtJson'
import {createItem,parseItem,stringifyItem,itemFromItemStack} from '../src/workspaces/progress/itemDoc'
import {parseItemStack,stringifyItemStack,itemFingerprint} from '../src/workspaces/progress/itemstack'
import {parseJsonValue} from '../src/utils/strictJson'
const compound = {type:'compound',value:Object.fromEntries([
  ['',{type:'string',value:''}],['__proto__',{type:'int',value:1}],
  ['long',{type:'long',value:'9223372036854775807'}],
  ['special',{type:'double',value:'Infinity'}],['nan',{type:'float',value:'NaN'}],
  ['negativeZero',{type:'double',value:'-0'}],
  ['mixed',{type:'list',value:[{type:'byte',value:1},{type:'string',value:'x'}]}],
  ['bytes',{type:'byte_array',value:[-128,127]}],['ints',{type:'int_array',value:[-2147483648,2147483647]}],
  ['longs',{type:'long_array',value:['-9223372036854775808','9223372036854775807']}],
])}
for(const type of NBT_TYPES) assert.deepEqual(readNbt(defaultNbt(type)),defaultNbt(type))
assert.deepEqual(readNbt(compound),compound)
const doc=createItem();doc.item.components={'minecraft:custom_data':readNbt(compound),'example:unknown':{type:'short',value:42}}
assert.deepEqual(parseItem(stringifyItem(doc)),doc)
const file={format:'rpgtoolkit:itemstack',schemaVersion:3,item:{...doc.item,count:3}}
const parsed=parseItemStack(stringifyItemStack(file))
assert.deepEqual(parsed.item,file.item)
assert.deepEqual(itemFromItemStack(parsed).item,doc.item)
assert.equal(Object.getPrototypeOf(readNbt(compound).value),Object.prototype)
assert.throws(()=>parseItem(stringifyItem(doc).replace('"schemaVersion": 2','"schemaVersion": 1')))
assert.throws(()=>parseItemStack(stringifyItemStack(file).replace('"schemaVersion": 3','"schemaVersion": 2')))
for(const bad of [{type:'byte',value:128},{type:'int',value:1.1},{type:'long',value:42},{type:'long',value:'9223372036854775808'},{type:'float',value:'1e99'},{type:'double',value:'foo'},{type:'null',value:null},{type:'byte_array',value:[128]},{type:'long_array',value:[1]},{type:'string',value:'x',extra:1}]) assert.throws(()=>readNbt(bad),JSON.stringify(bad))
assert.throws(()=>readComponents({'damage':{type:'int',value:1}}))
assert.throws(()=>readComponents({'minecraft:damage':{remove:true}}))
assert.throws(()=>parseJsonValue('{"x":1,"x":2}'))
assert.notEqual(itemFingerprint({id:'minecraft:stick',components:{'example:x':{type:'int',value:1}}}),itemFingerprint({id:'minecraft:stick',components:{'example:x':{type:'byte',value:1}}}))
assert.equal(itemFingerprint({id:'minecraft:stick',components:{'example:x':{type:'compound',value:{b:{type:'int',value:2},a:{type:'int',value:1}}}}}),itemFingerprint({id:'minecraft:stick',components:{'example:x':{type:'compound',value:{a:{type:'int',value:1},b:{type:'int',value:2}}}}}))
console.log('TNBT JSON：12 类型、精度、特殊值、空/特殊键、异构列表、格式往返、旧格式拒绝、无效值与指纹检查通过')

const {acceptsEnchantments,acceptsAttributes,renameEnchantment,patchAttribute,newAttribute,literalText,setLiteralText,stringTag}=await import('../src/workspaces/progress/itemComponents/complexModel')
const ench={type:'compound',value:{'minecraft:sharpness':{type:'int',value:5},'example:custom':{type:'short',value:7}}} as const
assert.ok(acceptsEnchantments(ench))
assert.ok(!acceptsEnchantments({type:'compound',value:{'minecraft:sharpness':{type:'int',value:0}}}))
assert.throws(()=>renameEnchantment(ench,'minecraft:sharpness','example:custom'))
assert.deepEqual(renameEnchantment(ench,'minecraft:sharpness','example:renamed'),{...ench,value:{'example:renamed':{type:'int',value:5},'example:custom':{type:'short',value:7}}})
const attribute=newAttribute({type:'list',value:[]})
assert.ok(acceptsAttributes({type:'list',value:[attribute]}))
assert.notDeepEqual(newAttribute({type:'list',value:[attribute]}),attribute)
if(attribute.type!=='compound')throw Error('expected compound')
attribute.value['example:metadata']={type:'long',value:'9223372036854775807'}
const modifiers={type:'list',value:[attribute]} as const
const changed=patchAttribute({...modifiers,value:[...modifiers.value]},0,{amount:{type:'double',value:'2.5'}})
assert.equal(changed.type==='list'&&changed.value[0].type==='compound'&&changed.value[0].value['example:metadata'].value,'9223372036854775807')
const rich={type:'compound',value:{text:stringTag('before'),extra:{type:'list',value:[stringTag('suffix')]},color:stringTag('gold')}} as const
assert.equal(literalText(rich),'before')
assert.deepEqual(setLiteralText(rich,'after'),{...rich,value:{...rich.value,text:stringTag('after')}})
assert.throws(()=>setLiteralText({type:'compound',value:{translate:stringTag('key')}},'cannot flatten'))
console.log('复杂组件：附魔等级/重名、属性结构/唯一ID/额外字段、富文本无损局部修改检查通过')
