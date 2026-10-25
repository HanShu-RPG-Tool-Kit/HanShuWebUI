import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {readItemSync,defaultItemSync,synchronizeComponents,syncRuleErrors,TEMPLATE_COMPONENT} from '../src/workspaces/gameplay/itemSync'
import {createItem,parseItem,stringifyItem,itemFromItemStack} from '../src/workspaces/gameplay/itemDoc'
import {readComponents,type NbtValue} from '../src/workspaces/gameplay/tnbtJson'
import {itemTemplateArtifact} from '../src/export/compile/compilers/item'
const n=(v:number):NbtValue=>({type:'int',value:v})
const template=readComponents({'minecraft:custom_data':{type:'compound',value:{magazine:{type:'compound',value:{ammo:n(30),capacity:n(30)}},version:n(2)}}})
const instance=readComponents({'minecraft:custom_data':{type:'compound',value:{magazine:{type:'compound',value:{ammo:n(7),capacity:n(99),extra:n(1)}},version:n(1),rogue:n(1)}},'minecraft:repair_cost':n(5)})
const field={component:'minecraft:custom_data',path:['magazine','ammo']}
let sync={...defaultItemSync(),instanceFields:[field]}
let expected=structuredClone(template)
if(expected['minecraft:custom_data'].type==='compound') {
 const magazine=expected['minecraft:custom_data'].value.magazine
 if(magazine.type==='compound')magazine.value.ammo=n(7)
}
assert.deepEqual(synchronizeComponents(template,instance,sync),expected,'only declared leaf survives')
assert.deepEqual(synchronizeComponents(template,instance,defaultItemSync()),template,'closed: delete unknown components and fields')
const subtree={...sync,instanceFields:[{...field,path:['magazine']}]}
const subtreeResult=synchronizeComponents(template,instance,subtree)['minecraft:custom_data']
assert.equal(subtreeResult.type,'compound')
if(subtreeResult.type==='compound')assert.deepEqual(subtreeResult.value.magazine,(instance['minecraft:custom_data'] as {type:'compound';value:Record<string,NbtValue>}).value.magazine)
const absent=synchronizeComponents(template,{},sync)['minecraft:custom_data']
assert.equal(absent.type,'compound')
if(absent.type==='compound'&&absent.value.magazine.type==='compound')assert.equal(Object.hasOwn(absent.value.magazine.value,'ammo'),false,'absence preserved')
assert.equal(Object.hasOwn(synchronizeComponents(template,instance,{...sync,instanceComponents:['minecraft:repair_cost']}),'minecraft:repair_cost'),true)
assert.equal(Object.hasOwn(synchronizeComponents(template,instance,{...sync,allowExtraComponents:true}),'minecraft:repair_cost'),true)
assert.equal(Object.hasOwn(synchronizeComponents(template,{...instance,[TEMPLATE_COMPONENT]:{type:'string',value:'foreign'}},{...sync,allowExtraComponents:true}),TEMPLATE_COMPONENT),false)
assert.deepEqual(readItemSync({...sync,instanceFields:[field,{...field,path:['magazine']},field]}).instanceFields,[{...field,path:['magazine']}])
assert.deepEqual(readItemSync({...sync,instanceComponents:['minecraft:custom_data']}).instanceFields,[])
assert.throws(()=>readItemSync({...sync,instanceComponents:[TEMPLATE_COMPONENT]}))
assert.throws(()=>readItemSync({...sync,instanceFields:[{...field,path:[]}]}))
assert.equal(syncRuleErrors(sync,{}).length,1)
assert.throws(()=>synchronizeComponents({},instance,sync))
const emptyKey=readComponents({'minecraft:custom_data':{type:'compound',value:{'':n(1)}}})
assert.deepEqual(synchronizeComponents(emptyKey,{}, {...sync,instanceFields:[{...field,path:['']}]}),{'minecraft:custom_data':{type:'compound',value:{}}})
const before=JSON.stringify({template,instance});synchronizeComponents(template,instance,sync);assert.equal(JSON.stringify({template,instance}),before)
const doc=createItem('minecraft:stick');doc.item.components=template;doc.sync=sync;doc.tags=[' 装备 ','WEAPON','weapon','Cafe\u0301']
assert.deepEqual(parseItem(stringifyItem(doc)).sync,sync)
assert.deepEqual(parseItem(stringifyItem({...doc,item:{...doc.item,id:'minecraft:apple'}})).sync,sync)
assert.throws(()=>itemTemplateArtifact({...doc,item:{...doc.item,components:{}}}))
assert.equal(Object.hasOwn(itemFromItemStack({format:'rpgtoolkit:itemstack',schemaVersion:3,item:{id:'minecraft:stick',count:1,components:{[TEMPLATE_COMPONENT]:{type:'string',value:'original'}}}}).item.components,TEMPLATE_COMPONENT),false)
const artifact=itemTemplateArtifact(doc)
assert.equal(artifact.componentMode,'complete');assert.deepEqual(artifact.sync,sync)
assert.deepEqual(artifact.tags,['装备','WEAPON','Café'])
assert.equal(Object.hasOwn(artifact,'revision'),false)
if(process.env.ITEM_TEMPLATE_EXPORT_PATH)await writeFile(process.env.ITEM_TEMPLATE_EXPORT_PATH,JSON.stringify(artifact,null,2)+'\n')
console.log('通过：封闭同步、组件/字段/子树开放、缺失、额外组件、规则归并与校验、导出与往返')
