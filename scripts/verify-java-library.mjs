import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'
const fixture=JSON.parse(await readFile('../ModRPGToolKit/build/javascript-stubs-test.json','utf8'))
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
let browser
try{
 browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/java-library-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor"></div><div id="dialog"></div>'}))
 const url=`http://127.0.0.1:${server.httpServer.address().port}/java-library-check`
 await page.goto(url)
 await page.evaluate(async fixture=>{
  const control=await import('/src/gameDevServer/controlHub.ts')
  const Original=window.WebSocket,requests=[]
  window.WebSocket=class{
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
   send(raw){const r=JSON.parse(raw);if(r.type!=='request')return;requests.push(r)
    let result
    if(r.method==='javascript.library.page'){
     if(window.failSync){this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:false,error:{code:'injected',message:'injected failure'}})});return}
     const next=Math.min(r.params.offset+8,fixture.classes.length)
     result={schemaVersion:1,runtimeId:'library-fixture',classes:fixture.classes.slice(r.params.offset,next),missing:[],next,total:fixture.classes.length,done:next===fixture.classes.length,javaVersion:'25'}
    }else if(r.method==='javascript.stubs')result={schemaVersion:1,runtimeId:'library-fixture',classes:fixture.classes.filter(c=>r.params.classes.includes(c.name)),missing:[]}
    else result={schemaVersion:1,runtimeId:'library-fixture',revision:1,hooks:[{id:'tick',cancellable:false,eventClass:'mchhui.rpgtoolkit.feature.actor.hook.ActorEvent'}]}
    setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),5)
   }
   close(){this.readyState=3;this.onclose?.({code:1000})}
  }
  control.updateGameDevServerPrefs({autoConnect:true})
  window.libTest={control,Original,requests}
 },fixture)
 await page.waitForFunction(()=>window.libTest.control.isControlConnected())
 // Opening the menu dialog must not start a full download.
 await page.evaluate(async()=>{
  const {globalMenuContribution}=await import('/src/chrome/menu/globalMenus.ts')
  if(!globalMenuContribution.menus.find(m=>m.id==='edit').items.some(i=>i.id==='sync-java-library'))throw Error('missing Edit menu command')
  const {mountLibraryDialog}=await import('/scripts/javascript-diagnostics-ui-fixture.ts')
  mountLibraryDialog()
 })
 await page.getByRole('button',{name:'开始同步'}).waitFor()
 assert.equal(await page.evaluate(()=>window.libTest.requests.filter(r=>r.method==='javascript.library.page').length),0)
 await page.getByRole('button',{name:'开始同步'}).click()
 await page.getByRole('status').filter({hasText:'同步完成'}).waitFor()
 const synced=await page.evaluate(async()=>{
  const lib=await import('/src/monaco/javascript/javaLibrary.ts'),library=await lib.readJavaLibrary()
  window.failSync=true
  let failed=false;try{await lib.syncJavaLibrary(new AbortController().signal,()=>{})}catch{failed=true}
  const afterFailure=await lib.readJavaLibrary();window.failSync=false
  const cancel=new AbortController();let cancelled=false
  try{await lib.syncJavaLibrary(cancel.signal,()=>cancel.abort())}catch{cancelled=true}
  const afterCancel=await lib.readJavaLibrary()
  return {library,failed,cancelled,preserved:library.id===afterFailure.id&&library.id===afterCancel.id}
 })
 assert.equal(synced.library.classes.length,fixture.classes.length)
 assert(synced.failed&&synced.cancelled&&synced.preserved)
 console.log('PASS Edit menu dialog: explicit sync only, paged IndexedDB snapshot; failure/cancel retain previous complete library')
 // With a local library still present, a live connection must prefer online protocols and not read the snapshot.
 const onlinePrefer=await page.evaluate(async()=>{
  const control=await import('/src/gameDevServer/controlHub.ts')
  const ui=await import('/scripts/javascript-diagnostics-ui-fixture.ts')
  // mount() 会关掉 autoConnect；测在线优先前先恢复连接
  const editor=await ui.mount({source:'import ServerPlayer from "net.minecraft.server.level.ServerPlayer"\nfunction inspect(player: ServerPlayer): void {\n var level=player.level();\n}',readOnly:false,scriptType:'actor'})
  control.updateGameDevServerPrefs({autoConnect:true})
  for(let i=0;i<100&&!control.isControlConnected();i++)await new Promise(r=>setTimeout(r,20))
  const {searchJavaClasses}=await import('/src/monaco/javascript/javaImportAction.ts')
  const before=window.libTest.requests.length
  const search=await searchJavaClasses('ServerPlayer')
  const afterSearch=window.libTest.requests.slice(before)
  const {captureJavaScriptDiagnostics,peekJavaScriptHooks}=await import('/src/monaco/javascript/javascriptLanguage.ts')
  let report
  for(let i=0;i<200;i++){
   report=await captureJavaScriptDiagnostics(editor.getModel(),null,null)
   if(report.service.loadedClasses?.includes('net.minecraft.server.level.ServerLevel')&&peekJavaScriptHooks(editor.getModel()).some(h=>h.id==='tick'))break
   await new Promise(r=>setTimeout(r,30))
  }
  const related=window.libTest.requests.filter(r=>r.method==='javascript.stubs'||r.method==='javascript.actorHooks'||r.method==='javascript.classes.search')
  return {
   connected:control.isControlConnected(),
   searchRuntime:search.runtimeId,
   searchHit:search.classes.some(c=>c.symbol==='ServerPlayer'),
   searchOnline:afterSearch.some(r=>r.method==='javascript.classes.search'),
   hooks:peekJavaScriptHooks(editor.getModel()).map(h=>h.id),
   loaded:report.service.loadedClasses,
   usedOnline:related.some(r=>r.method==='javascript.stubs')&&related.some(r=>r.method==='javascript.actorHooks'),
  }
 })
 assert.equal(onlinePrefer.connected,true)
 assert.equal(onlinePrefer.searchRuntime,'library-fixture')
 assert(onlinePrefer.searchHit)
 assert(onlinePrefer.searchOnline)
 assert.deepEqual(onlinePrefer.hooks,['tick'])
 assert(onlinePrefer.loaded.includes('net.minecraft.server.level.ServerLevel'),JSON.stringify(onlinePrefer))
 assert(onlinePrefer.usedOnline,JSON.stringify(onlinePrefer))
 console.log('PASS connected with local library: online stubs/hooks/search preferred, snapshot not authoritative')
 // Reload drops all JavaScript memory; the persisted snapshot must work without a game.
 await page.reload()
 const offline=await page.evaluate(async()=>{
  const ui=await import('/scripts/javascript-diagnostics-ui-fixture.ts'),control=await import('/src/gameDevServer/controlHub.ts')
  control.updateGameDevServerPrefs({autoConnect:false})
  const {readJavaLibrary}=await import('/src/monaco/javascript/javaLibrary.ts'),library=await readJavaLibrary()
  const editor=await ui.mount({source:'import ServerPlayer from "net.minecraft.server.level.ServerPlayer"\nfunction inspect(player: ServerPlayer): void {\n var level=player.level();\n level.sendParticles;\n level.notReal;\n}',readOnly:false})
  const {captureJavaScriptDiagnostics}=await import('/src/monaco/javascript/javascriptLanguage.ts')
  let report
  for(let i=0;i<200;i++){report=await captureJavaScriptDiagnostics(editor.getModel(),null,null);if(report.service.loadedClasses?.includes('net.minecraft.server.level.ServerLevel')&&report.markers.filter(m=>m.owner==='hanshu-tsserver').length===1)break;await new Promise(r=>setTimeout(r,30))}
  const {searchJavaClasses,applyJavaImport}=await import('/src/monaco/javascript/javaImportAction.ts'),search=await searchJavaClasses('ServerPlayer')
  editor.getModel().setValue('function inspect(): void {}')
  await applyJavaImport({editor,model:editor.getModel(),version:editor.getModel().getVersionId(),query:'ServerPlayer',connection:control.controlConnectionGeneration(),project:undefined},search.classes.find(c=>c.symbol==='ServerPlayer'),'',search.runtimeId,ui.monaco)
  const imported=editor.getValue()
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts'),{buildJavaFiles}=await import('/src/monaco/javascript/stubs.ts'),{readLibraryClasses}=await import('/src/monaco/javascript/javaLibrary.ts')
  const client=new TsserverClient();let hover
  try{await client.writeFiles({...buildJavaFiles(await readLibraryClasses(library,['net.minecraft.server.level.ServerPlayer','net.minecraft.server.level.ServerLevel'])),'/offline.ts':'declare var player: jvm_net_d_minecraft_d_server_d_level_d_ServerPlayer.ServerPlayer;\nplayer.level()'});hover=await client.request('hover',{file:'/offline.ts',line:2,column:9})}finally{client.dispose()}
  return {library:library.id,markers:report.markers,loaded:report.service.loadedClasses,search,hover,imported,connected:control.isControlConnected()}
 })
 assert.equal(offline.library,synced.library.id)
 assert.equal(offline.connected,false)
 assert(offline.loaded.includes('net.minecraft.server.level.ServerLevel'),JSON.stringify(offline))
 assert.equal(offline.markers.filter(m=>m.owner==='hanshu-tsserver').length,1,JSON.stringify(offline.markers))
 assert(offline.markers.some(m=>m.message.includes('notReal')))
 assert(offline.search.classes.some(c=>c.symbol==='ServerPlayer'))
 assert(offline.hover.text.includes('ServerLevel'),JSON.stringify(offline.hover))
 assert(offline.imported.includes('import ServerPlayer from "net.minecraft.server.level.ServerPlayer"'),offline.imported)
 assert.deepEqual(errors,[])
 console.log('PASS fresh offline page: persistent library, lazy Java return types, hover, genuine diagnostics and local class search')
}finally{await browser?.close();await server.close()}
