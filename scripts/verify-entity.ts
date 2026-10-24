import assert from 'node:assert/strict'
import {createEntity,parseEntity,stringifyEntity} from '../src/workspaces/progress/entityDoc'
import {decodeEntityFrame,entityFingerprint} from '../src/workspaces/progress/entitySnapshot'
import {sourcePathOf,defaultPlaneForFile} from '../src/workspace'
import {packageIdOfExt,PROGRESS_SOURCE_EXTS} from '../src/project/projectSession'
import {packageAllowsDocuments,packageDocumentExt,FLOW_PACKAGE_ORDER,packageAcceptsImportFile} from '../src/workspaces/progress/library'
import {entityCompiler} from '../src/export/compile/compilers/entity'
const doc=createEntity();doc.entity.data.value.Health={type:'float',value:'35'};doc.entity.data.value.custom={type:'long',value:'9223372036854775807'}
assert.deepEqual(parseEntity(stringifyEntity(doc)),doc)
assert.equal(sourcePathOf({name:'卫兵.entity'}),'src/entities/卫兵.entity');assert.equal(defaultPlaneForFile('卫兵.entity'),'server')
assert.equal(packageIdOfExt('.entity'),'entities');assert(PROGRESS_SOURCE_EXTS.has('.entity'));assert(FLOW_PACKAGE_ORDER.includes('entities'));assert(packageAllowsDocuments('entities'));assert.equal(packageDocumentExt('entities'),'.entity');assert(packageAcceptsImportFile('entities','a.entity'))
const bad=structuredClone(doc);bad.entity.data.value.equipment={type:'compound',value:{mainhand:{type:'compound',value:{components:{type:'compound',value:{'rpgtoolkit:item_template':{type:'string',value:'blade'}}}}}}};assert.throws(()=>parseEntity(stringifyEntity(bad)),/不能绑定/)
assert.throws(()=>parseEntity(stringifyEntity({...doc,entity:{...doc.entity,id:'minecraft:player'}})))
const f=entityFingerprint(doc);assert.equal(entityFingerprint({...doc,tags:['boss']}),f)
const buffer=new ArrayBuffer(32+16);const v=new DataView(buffer);v.setUint32(0,0x52505346,true);v.setUint16(4,32,true);v.setUint16(6,1,true);v.setUint32(8,2,true);v.setUint32(12,2,true);v.setUint32(16,8,true);assert.equal(decodeEntityFrame(buffer).pixels.length,16);assert.throws(()=>decodeEntityFrame(buffer.slice(0,40)));assert.throws(()=>decodeEntityFrame(new ArrayBuffer(16)))
const file={name:'卫兵.entity',content:stringifyEntity(doc),srcKind:'entities'};const diagnostics:unknown[]=[]
const result=await entityCompiler.compile(file as never,{index:{package:{name:'test'}},report:(d:unknown)=>diagnostics.push(d)} as never)
assert.equal(result[0].path,'entities/卫兵.entity');assert.equal(result[0].plane,'server');assert.deepEqual(diagnostics,[])
console.log('PASS entity model: TNBT roundtrip, no template binding, source/export paths, display fingerprint and frame validation')
