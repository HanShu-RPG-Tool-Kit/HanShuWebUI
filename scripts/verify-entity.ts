import assert from 'node:assert/strict'
import {createEntity,parseEntity,stringifyEntity} from '../src/workspaces/gameplay/entityDoc'
import {decodeEntityFrame,entityFingerprint} from '../src/workspaces/gameplay/entitySnapshot'
import {sourcePathOf,defaultPlaneForFile} from '../src/workspace'
import {packageIdOfExt,PROGRESS_SOURCE_EXTS} from '../src/project/projectSession'
import {packageAllowsDocuments,packageDocumentExt,FLOW_PACKAGE_ORDER,packageAcceptsImportFile} from '../src/workspaces/gameplay/library'
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

const {registerEntityFieldEditor,entityFieldEditors,applyEntityFieldEdit}=await import('../src/workspaces/gameplay/entityFields/registry')
const original={custom:{type:'int' as const,value:1},other:{type:'string' as const,value:'keep'}}
const edited=applyEntityFieldEdit(original,['custom'],{custom:{type:'int',value:2},other:{type:'string',value:'overwrite'}})
assert.equal(edited.other.value,'keep');assert.equal(edited.custom.value,2);assert.equal(original.custom.value,1)
assert(!Object.hasOwn(applyEntityFieldEdit(original,['custom'],{}),'custom'))
const card={id:'test:custom',title:'自定义',fields:['custom'],Editor:()=>null}
const dispose=registerEntityFieldEditor(card);assert(entityFieldEditors().includes(card));assert.throws(()=>registerEntityFieldEditor(card));assert.throws(()=>registerEntityFieldEditor({...card,id:'test:other'}));dispose();assert(!entityFieldEditors().includes(card))
const {withLibraryTables,stripLibraryTables,isReadonlyExplorerKey,isEntityDocument,ENTITY_LIBRARY_TABLE_KEY}=await import('../src/workspaces/gameplay/library')
const empty={documents:[],folders:[]} as never,virtual=withLibraryTables(empty)
assert(virtual.documents.some(d=>d.key===ENTITY_LIBRARY_TABLE_KEY));assert(isReadonlyExplorerKey(ENTITY_LIBRARY_TABLE_KEY));assert(!isEntityDocument(virtual.documents.find(d=>d.key===ENTITY_LIBRARY_TABLE_KEY)!));assert.equal(stripLibraryTables(virtual).documents.length,0);assert.equal(withLibraryTables(virtual),virtual)
console.log('PASS entity registry: ownership, preservation, duplicate rejection, disposal and virtual library persistence boundary')

const {readEntityStreamFrame}=await import('../src/workspaces/gameplay/entitySnapshot')
const jpegHeader=new ArrayBuffer(36),jh=new DataView(jpegHeader);jh.setUint32(0,0x52505346,true);jh.setUint16(4,32,true);jh.setUint16(6,2,true);jh.setUint32(8,64,true);jh.setUint32(12,48,true);assert.equal(readEntityStreamFrame(jpegHeader).encoding,'jpeg');jh.setUint32(16,256,true);assert.throws(()=>readEntityStreamFrame(jpegHeader));assert.equal(readEntityStreamFrame(buffer).encoding,'rgba')
