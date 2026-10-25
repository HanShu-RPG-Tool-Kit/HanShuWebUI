import assert from 'node:assert/strict'
import {
  LOCALIZATION_PROTOCOL, localizedResultEdits, readLocaleTable,
  assertDisplaySessionUnchanged, commitLocalizedResult, preserveReadOnlyDisplayText, legacyLocalizedResultEdits, supportsDisplayLocalization, loadDisplayLocaleTables, prepareDisplayLocalization,
  type LocalizationSession,
} from '../src/gameDevServer/displayLocalization'
import {createItem, stringifyItem} from '../src/workspaces/progress/itemDoc'
import {createEntity} from '../src/workspaces/progress/entityDoc'
import {displayTextRuntimeKey, replaceDisplayText, getDisplayText} from '../src/workspaces/progress/displayTextLocale'
import {ProjectClient, type FileEdit} from '../src/project/serviceClient'
import {getProjectSession,setProjectSession} from '../src/project/projectSession'
import {createProject, type Workspace} from '../src/workspace'
import {ServiceError} from '../src/collab/protocol'

let checks=0
async function test(name:string,run:()=>void|Promise<void>){await run();checks++;console.log(`通过：${name}`)}
const runtime=displayTextRuntimeKey('item','display.custom_name','item-identity')
const doc=replaceDisplayText('item',createItem(),'item.custom_name',{translate:runtime,color:'gold',with:[{text:'参数'}],future_extension:{preserve:true}})
function fixture(){
  const client=new ProjectClient({url:'http://localization.test',token:''},{role:'editor',projectId:'test',session:{subjectId:'author'}} as never)
  const source=stringifyItem(doc)
  const session:LocalizationSession={
    client,documentKey:'item-doc',sourcePath:'src/items/sword.item',source,sourceVersion:'source-open-version',kind:'item',
    tables:new Map([
      ['zh_cn',{path:'assets/zh_cn/lang_item/sword.lang',content:'{"display.custom_name":"宝剑","unrelated":"保留"}',version:'zh-open-version',values:{'display.custom_name':'宝剑',unrelated:'保留'}}],
      ['en_us',{path:'assets/en_us/lang_item/sword.lang',content:'{"unrelated":"Keep"}',version:'en-open-version',values:{unrelated:'Keep'}}],
      ['ja_jp',{path:'assets/ja_jp/lang_item/sword.lang',content:null,version:null,values:{}}],
    ]),
    localization:{protocol:LOCALIZATION_PROTOCOL,activeLocale:'zh_cn',availableLocales:['zh_cn','en_us','ja_jp'],bindings:[{bindingId:'authorized-binding',field:'item.custom_name',semanticKey:'display.custom_name',runtimeKey:runtime,componentKind:'translate',translations:{zh_cn:'宝剑'}}]},
  }
  const workspace:Workspace={packages:[{...createProject('test'),scripts:[{id:session.documentKey,name:'sword.item',content:source,updatedAt:0}]}],activeScriptId:session.documentKey,activeAssetId:null}
  return {client,session,workspace}
}
const operation=(patch:Record<string,unknown>={})=>({op:'translation.set',bindingId:'authorized-binding',locale:'zh_cn',expected:'宝剑',value:'黄金宝剑',...patch})
const result=(operations:unknown[])=>({protocol:LOCALIZATION_PROTOCOL,operations})

await test('译文增量保留无关键、冻结版本，并将未改语言作为同批 CAS 条件',()=>{
  const {session}=fixture(),before=structuredClone(session.localization)
  const edits=localizedResultEdits(session,doc,result([operation(),operation({locale:'en_us',expected:null,value:'Golden Sword'})]))
  assert.deepEqual(edits.map(edit=>[edit.op,edit.path,edit.version,edit.adopt]),[
    ['write','assets/zh_cn/lang_item/sword.lang','zh-open-version',false],
    ['write','assets/en_us/lang_item/sword.lang','en-open-version',false],
    ['write','assets/ja_jp/lang_item/sword.lang',null,true],
  ])
  assert.deepEqual(readLocaleTable(edits[0].data as string),{'display.custom_name':'黄金宝剑',unrelated:'保留'})
  assert.deepEqual(readLocaleTable(edits[1].data as string),{unrelated:'Keep','display.custom_name':'Golden Sword'})
  assert.deepEqual(session.localization,before,'Validation must not mutate the authorized open snapshot')
  assert.equal(session.tables.get('zh_cn')!.values['display.custom_name'],'宝剑')
})
await test('缺失值用 null CAS；空字符串与缺失值不同，删除保持其他语言',()=>{
  const {session}=fixture()
  assert.throws(()=>localizedResultEdits(session,doc,result([operation({locale:'en_us',expected:'',value:'English'})])),/原值/)
  assert.throws(()=>localizedResultEdits(session,doc,result([operation({locale:'en_us',expected:undefined})])),/原值/)
  const seeded=localizedResultEdits(session,doc,result([operation({locale:'ja_jp',expected:null,value:''})]))
  assert.deepEqual(readLocaleTable(seeded[2].data as string),{'display.custom_name':''})
  assert.equal(seeded[2].version,null);assert.equal(seeded[2].adopt,false)
  const removed=localizedResultEdits(session,doc,result([{op:'translation.remove',bindingId:'authorized-binding',locale:'zh_cn',expected:'宝剑'}]))
  assert.deepEqual(readLocaleTable(removed[0].data as string),{unrelated:'保留'})
  assert.equal(removed[1].adopt,true)
})
await test('拒绝未授权绑定、语言、原值、未知操作和任意路径输入',()=>{
  const {session}=fixture()
  for(const invalid of [
    operation({bindingId:'forged-binding'}),operation({locale:'fr_fr'}),operation({expected:'过期'}),
    operation({op:'translation.rename'}),operation({path:'assets/forged.lang'}),operation({value:42}),null,
  ])assert.throws(()=>localizedResultEdits(session,doc,result([invalid])))
  assert.throws(()=>localizedResultEdits(session,doc,{protocol:'other-version',operations:[]}))
  assert.throws(()=>localizedResultEdits(session,doc,result([operation(),operation()])),/重复/)
  const tables=structuredClone(session.tables)
  assert.throws(()=>localizedResultEdits(session,doc,result([operation(),operation({locale:'en_us',expected:'wrong'})])))
  assert.deepEqual(session.tables,tables,'A later rejected operation must not leak earlier edits')
})
await test('所有授权 Component 都保留翻译引用，空增量也不能移除或伪造引用',()=>{
  const {session}=fixture()
  for(const changed of [{text:'literal'},{translate:'minecraft.external.key'},{translate:displayTextRuntimeKey('item','display.custom_name','forged')}]){
    const candidate=replaceDisplayText('item',doc,'item.custom_name',changed)
    assert.throws(()=>localizedResultEdits(session,candidate,result([operation()])),/翻译键/)
    assert.throws(()=>localizedResultEdits(session,candidate,result([])),/翻译键/)
  }
  const duplicate=replaceDisplayText('item',doc,'item.item_name',{translate:runtime})
  assert.throws(()=>localizedResultEdits(session,duplicate,result([])),/翻译键|重复/)
})
await test('实体 CustomName 遵循相同绑定与译文校验',()=>{
  const {session}=fixture()
  const entityRuntime=displayTextRuntimeKey('entity','display.custom_name','entity-identity')
  const entity=replaceDisplayText('entity',createEntity(),'entity.custom_name',{translate:entityRuntime})
  session.kind='entity';session.localization.bindings[0]={...session.localization.bindings[0],field:'entity.custom_name',runtimeKey:entityRuntime}
  assert.equal(readLocaleTable(localizedResultEdits(session,entity,result([operation()]))[0].data as string)['display.custom_name'],'黄金宝剑')
})

async function withActiveFixture(run:(f:ReturnType<typeof fixture>)=>Promise<void>){
  const previous=getProjectSession(),f=fixture()
  setProjectSession({workspace:f.workspace,binding:{handle:f.client.root(),manifest:{version:1,id:f.workspace.packages[0].id,name:'test'},folderName:'test'} as never})
  try{await run(f)}finally{setProjectSession(previous)}
}
await test('源文档和全部语言版本只提交一个事务，拒绝后保持当前草稿',()=>withActiveFixture(async({client,session})=>{
  const batches:FileEdit[][]=[]
  client.apply=async edits=>{batches.push(edits);throw new ServiceError('conflict','语言已被另一窗口修改')}
  const localeEdits=localizedResultEdits(session,doc,result([operation()]))
  await assert.rejects(commitLocalizedResult(session,'new source',localeEdits),/另一窗口/)
  assert.equal(batches.length,1)
  assert.deepEqual(batches[0],[{op:'write',path:session.sourcePath,data:'new source',version:'source-open-version'},...localeEdits])
  assert.equal(getProjectSession().workspace.packages[0].scripts[0].content,session.source)
}))
await test('只读、离线、工程切换及源文档/译文草稿改变阻止回包覆盖，并保留冻结结果',()=>withActiveFixture(async({client,session,workspace})=>{
  let sends=0;client.apply=async()=>{sends++}
  client.snapshot.role='viewer';assert.throws(()=>assertDisplaySessionUnchanged(session),/只读/);client.snapshot.role='editor'
  client.online=false;assert.throws(()=>assertDisplaySessionUnchanged(session),/离线/);client.online=true
  setProjectSession({binding:null});assert.throws(()=>assertDisplaySessionUnchanged(session),/切换/)
  setProjectSession({binding:{handle:client.root(),manifest:{version:1,id:workspace.packages[0].id,name:'test'},folderName:'test'} as never})
  const newer=structuredClone(workspace);newer.packages[0].scripts[0].content='new unsaved source';setProjectSession({workspace:newer})
  const edits=localizedResultEdits(session,doc,result([operation()]))
  await assert.rejects(commitLocalizedResult(session,'game result source',edits),/草稿已改变/)
  assert.equal(sends,0)
  const conflict=client.transactions.getSnapshot().transactions[0]
  assert.equal(conflict.phase,'conflict')
  assert.equal(client.transactions.submission(conflict.id)[0].data,'game result source')
  assert.deepEqual(client.transactions.submission(conflict.id).map(edit=>edit.version),['source-open-version','zh-open-version','en-open-version',null])
  setProjectSession({workspace})
  await client.transactions.stageWrite({op:'write',path:session.tables.get('zh_cn')!.path,data:'{"display.custom_name":"new draft"}',version:'zh-open-version'})
  assert.throws(()=>assertDisplaySessionUnchanged(session),/译文草稿已改变/)
}))
await test('旧端能力协商安全降级，只允许原样保留本地化 Component',async()=>{
  const calls:string[]=[]
  assert.equal(await supportsDisplayLocalization(async method=>{calls.push(method);return {protocols:[LOCALIZATION_PROTOCOL]}}),true)
  assert.deepEqual(calls,['localization.capabilities'])
  for(const response of [null,{protocols:[]},{protocols:['future-version']},{protocols:LOCALIZATION_PROTOCOL}])assert.equal(await supportsDisplayLocalization(async()=>response),false)
  assert.equal(await supportsDisplayLocalization(async()=>{throw Error('method_not_found')}),false)
  const {session}=fixture()
  const nonTextEdit={...doc,item:{...doc.item,id:'minecraft:diamond_sword'}}
  assert.ok(legacyLocalizedResultEdits(session,nonTextEdit).every(edit=>edit.adopt))
  const changed=replaceDisplayText('item',doc,'item.custom_name',{translate:runtime,color:'red'})
  assert.throws(()=>legacyLocalizedResultEdits(session,changed),/旧版 IBE/)
  const unbound=fixture();unbound.session.localization.bindings=[]
  assert.deepEqual(localizedResultEdits(unbound.session,createItem(),result([])),[],'An unbound source must not authorize otherwise unrelated language files')
})
await test('已确认源文档更新视图，提交期间新增译文草稿不会被旧回执清除',()=>withActiveFixture(async({client,session})=>{
  const oldTable=session.tables.get('zh_cn')!,newDraft='{"display.custom_name":"输入于提交期间"}'
  await client.transactions.stageWrite({op:'write',path:oldTable.path,data:oldTable.content!,version:oldTable.version})
  const nextSource=stringifyItem({...doc,item:{...doc.item,id:'minecraft:diamond_sword'}})
  let calls=0
  client.apply=async()=>{calls++;await client.transactions.stageWrite({op:'write',path:oldTable.path,data:newDraft,version:oldTable.version})}
  await commitLocalizedResult(session,nextSource,localizedResultEdits(session,doc,result([])))
  assert.equal(calls,1)
  assert.equal(getProjectSession().workspace.packages[0].scripts[0].content,nextSource)
  assert.equal(client.transactions.stagedText(oldTable.path),newDraft)
}))
await test('新绑定的未保存语言种子即使 IBE 无译文增量，也与源文档同批真实写入',()=>withActiveFixture(async({client,session})=>{
  const seedPath=session.tables.get('ja_jp')!.path,seed='{"display.custom_name":"新建时的译文种子"}'
  await client.transactions.stageWrite({op:'write',path:seedPath,data:seed,version:null})
  const loaded=await loadDisplayLocaleTables(client,'sword.item',['ja_jp'])
  assert.equal(loaded.get('ja_jp')!.staged,true)
  assert.equal(loaded.get('ja_jp')!.version,null)
  assert.equal(loaded.get('ja_jp')!.values['display.custom_name'],'新建时的译文种子')
  session.tables.set('ja_jp',loaded.get('ja_jp')!)
  const edits=localizedResultEdits(session,doc,result([])),seedEdit=edits.find(edit=>edit.path===seedPath)!
  assert.equal(seedEdit.adopt,false,'A still-unsaved locale is a write even when IBE did not edit it')
  assert.equal(seedEdit.version,null,'The seed keeps its original absent-file CAS version')
  assert.deepEqual(readLocaleTable(seedEdit.data as string),{'display.custom_name':'新建时的译文种子'})
  const unchanged=edits.find(edit=>edit.path===session.tables.get('zh_cn')!.path)!
  assert.equal(unchanged.adopt,true)
  assert.equal(unchanged.data,session.tables.get('zh_cn')!.content,'An adopt keeps exact frozen bytes instead of normalizing the language file')
  const batches:FileEdit[][]=[]
  client.apply=async batch=>{batches.push(batch);throw new ServiceError('conflict','并发修改种子文件')}
  await assert.rejects(commitLocalizedResult(session,session.source,edits),/并发修改/)
  assert.equal(batches.length,1)
  assert.equal(batches[0][0].path,session.sourcePath)
  assert.ok(batches[0].includes(seedEdit),'Source and new seed must share one transaction')
  assert.equal(client.transactions.stagedText(seedPath),seed,'Rejected batch keeps its seed draft')
}))
await test('没有本地化绑定的源文档保存，不清除未参与事务的语言草稿',()=>withActiveFixture(async({client,session})=>{
  const plainSource=stringifyItem(createItem()),live=structuredClone(getProjectSession().workspace)
  live.packages[0].scripts[0].content=plainSource;session.source=plainSource
  setProjectSession({workspace:live})
  session.localization.bindings=[]
  const unrelated=session.tables.get('zh_cn')!
  unrelated.staged=true
  await client.transactions.stageWrite({op:'write',path:unrelated.path,data:unrelated.content!,version:unrelated.version})
  const edits=localizedResultEdits(session,createItem(),result([]))
  assert.deepEqual(edits,[])
  const nextSource=stringifyItem(createItem('minecraft:diamond_sword')),batches:FileEdit[][]=[]
  client.apply=async batch=>{batches.push(batch)}
  await commitLocalizedResult(session,nextSource,edits)
  assert.deepEqual(batches.map(batch=>batch.map(edit=>edit.path)),[[session.sourcePath]])
  assert.equal(client.transactions.stagedText(unrelated.path),unrelated.content,'Unsubmitted language draft must survive the source-only acknowledgement')
  assert.equal(client.transactions.stagedWrites()[0].version,unrelated.version)
}))
await test('缺失但未修改的语言只登记不存在条件，不伪造空语言文件',()=>{
  const {session}=fixture(),missing=session.tables.get('ja_jp')!
  const edit=localizedResultEdits(session,doc,result([])).find(edit=>edit.path===missing.path)!
  assert.equal(edit.adopt,true)
  assert.equal(edit.version,null)
  assert.equal(edit.data,undefined)
})
await test('新源文件草稿的显式 null 版本不会被后来的工程基线替换',()=>withActiveFixture(async({client,session})=>{
  await client.transactions.stageWrite({op:'write',path:session.sourcePath,data:session.source,version:null})
  client.baseline.set(session.sourcePath,'remote-version-after-draft')
  const table=session.tables.get('zh_cn')!
  await client.transactions.stageWrite({op:'write',path:table.path,data:table.content!,version:table.version})
  client.readSnapshot=async()=>{throw Error('此回归测试应使用暂存语言，不读取工程文件')}
  const prepared=await prepareDisplayLocalization(session.documentKey,'item',doc)
  assert.equal(prepared.sourcePath,session.sourcePath)
  assert.equal(prepared.sourceVersion,null,'An explicit absent-file CAS must survive later baseline refreshes')
  assert.equal(client.baseline.get(session.sourcePath),'remote-version-after-draft')
}))
await test('旧端修改只读源文本时恢复原始 TNBT，同时保留其他物品修改',()=>{
  const {session}=fixture()
  const incoming=replaceDisplayText('item',doc,'item.custom_name',{text:'旧端有损转换'})
  incoming.item.id='minecraft:diamond_sword'
  const preserved=preserveReadOnlyDisplayText(session,incoming,true)
  assert.deepEqual(preserved.item.components['minecraft:custom_name'],doc.item.components['minecraft:custom_name'])
  assert.equal(preserved.item.id,'minecraft:diamond_sword')
  assert.doesNotThrow(()=>legacyLocalizedResultEdits(session,preserved))
  assert.equal(getDisplayText('item',incoming,'item.custom_name')&&JSON.stringify(getDisplayText('item',incoming,'item.custom_name')),JSON.stringify({text:'旧端有损转换'}),'Never mutate the received candidate')
})
await test('高级文本内嵌工程引用与未知结构在不支持的游戏端往返时原样保留',()=>{
  const {session}=fixture()
  const advanced={text:'前缀',extra:[{translate:runtime,unknown_future:{keep:true}}],click_event:{action:'run_command',command:'/say keep'}}
  const source=replaceDisplayText('item',doc,'item.custom_name',advanced)
  session.source=stringifyItem(source);session.localization.bindings=[]
  const incoming=replaceDisplayText('item',source,'item.custom_name',{text:'游戏端规范化了未知字段'})
  const preserved=preserveReadOnlyDisplayText(session,incoming)
  assert.deepEqual(preserved.item.components['minecraft:custom_name'],source.item.components['minecraft:custom_name'])
  assert.deepEqual(localizedResultEdits(session,preserved,result([])),[])
})
await test('未建立稳定绑定的高级 Lore 在冻结模式下保留完整原始顺序和结构',()=>{
  const {session}=fixture(),source=structuredClone(doc)
  source.item.components['minecraft:lore']={type:'list',value:[{type:'compound',value:{text:{type:'string',value:'高级行'},future:{type:'string',value:'保留'}}},{type:'string',value:'普通行'}]}
  session.source=stringifyItem(source);session.localization.readOnlyFields=['item.custom_name','item.lore.0'];session.localization.freezeLore=true
  const incoming=structuredClone(source);incoming.item.components['minecraft:lore']={type:'list',value:[{type:'string',value:'尝试删除或重排'}]}
  assert.deepEqual(preserveReadOnlyDisplayText(session,incoming).item.components['minecraft:lore'],source.item.components['minecraft:lore'])
})
await test('语言资产类型错误不能被空表覆盖',()=>{
  assert.deepEqual(readLocaleTable(null),{})
  for(const raw of ['[]','null','{"key":false}','{"key":{"text":"bad"}}'])assert.throws(()=>readLocaleTable(raw))
})
console.log(`显示文本本地化协议与事务：${checks} 项通过`)
