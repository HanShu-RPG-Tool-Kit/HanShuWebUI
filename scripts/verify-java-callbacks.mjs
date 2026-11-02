import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'
const fixture=JSON.parse(await readFile('../ModRPGToolKit/build/javascript-callback-stubs-test.json','utf8'))
const api=fixture.classes.find(c=>c.symbol==='Api')
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
let browser
try{
 browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage()
 await page.route('**/java-callback-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor"></div>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/java-callback-check`)
 const result=await page.evaluate(async({fixture,api})=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts'),{buildJavaFiles}=await import('/src/monaco/javascript/stubs.ts')
  const client=new TsserverClient()
  const lines=[
   `declare var api: ${api.module}.${api.symbol};`,
   'api.players().forEach(function(player) { player.getHealth(); });',
   'api.players().removeIf(function(player) { return player.getHealth() <= 0; });',
   'api.inheritedPlayers().forEach(function(player) { player.getHealth(); });',
   'api.inherited(function(player) { player.getHealth(); });',
   'api.objectMethods(function(player) { return player.getHealth() > 0; });',
   'var names=api.players().stream().map(function(player) { return player.getScoreboardName(); });',
   'names.forEach(function(name) { name.toUpperCase(); });',
   'api.players().sort(function(first, second) { return first.getHealth() - second.getHealth(); });',
   'api.overload(function(player) { return player.getHealth() > 0; });',
   'declare var predicate: jvm_java_d_util_d_function_d_Predicate.Predicate<jvm_net_d_minecraft_d_server_d_level_d_ServerPlayer.ServerPlayer>;',
   'api.players().removeIf(predicate);',
   'api.players().removeIf(function(player) { return "wrong"; });',
   'api.players().forEach(function(player) { player.missingCallbackMember(); });',
   'api.notSam(function(value) { return value; });',
   'api.names(function(player) { return 123; });',
  ]
  try{
   await client.writeFiles({...buildJavaFiles(fixture.classes),'/callbacks.ts':lines.join('\n')})
   const diagnostics=await client.request('diagnostics',{file:'/callbacks.ts'}),hovers=[]
   for(const line of [2,3,4,5,6,7,8,9,10]){
    const text=lines[line-1],token=line===8?'name.to':line===9?'first.get':'player.get',column=text.indexOf(token)+1
    hovers.push({line,...await client.request('hover',{file:'/callbacks.ts',line,column})})
   }
   const completion=await client.request('completion',{file:'/callbacks.ts',line:2,column:lines[1].indexOf('player.get')+'player.'.length+1})
   const names=await client.request('hover',{file:'/callbacks.ts',line:7,column:6}),returned=await client.request('hover',{file:'/callbacks.ts',line:7,column:lines[6].indexOf('getScoreboardName')+1})
   return {diagnostics,hovers,completion,names,returned}
  }finally{client.dispose()}
 },{fixture,api})
 assert(!result.diagnostics.some(d=>d.start.line<=12),JSON.stringify(result,null,2))
 for(const hover of result.hovers)assert(hover.text.includes(hover.line===8?'string':'ServerPlayer')&&!hover.text.includes(': any'),JSON.stringify({hover,names:result.names,returned:result.returned}))
 assert(result.completion.some(c=>c.name==='getHealth'))
 assert(result.diagnostics.some(d=>d.start.line===13&&d.message.includes('boolean')),JSON.stringify(result.diagnostics))
 assert(result.diagnostics.some(d=>d.start.line===14&&d.message.includes('missingCallbackMember')),JSON.stringify(result.diagnostics))
 assert(result.diagnostics.some(d=>d.start.line===15),JSON.stringify(result.diagnostics))
 assert(result.diagnostics.some(d=>d.start.line===16&&d.message.includes('string')),JSON.stringify(result.diagnostics))
 console.log('PASS real Java declarations: List/ArrayList inherited generics, Consumer/Predicate/Comparator/Function, stream map return inference, overloads, Java-object alternative, invalid return and non-SAM rejection')
 const cold=await page.evaluate(async({fixture,api})=>{
  const {monaco}=await import('/scripts/javascript-language-ui-fixture.ts'),{JavaScriptLanguage}=await import('/src/monaco/javascript/javascriptLanguage.ts'),control=await import('/src/gameDevServer/controlHub.ts')
  const Original=window.WebSocket,requested=[]
  window.WebSocket=class{
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
   send(raw){const r=JSON.parse(raw);if(r.type!=='request')return;requested.push(...r.params.classes??[]);const result={schemaVersion:1,runtimeId:'callback-cold',classes:fixture.classes.filter(c=>(r.params.classes??[]).includes(c.name)),missing:(r.params.classes??[]).filter(n=>!fixture.classes.some(c=>c.name===n))};setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),1)}
   close(){this.readyState=3;this.onclose?.({code:1000})}
  }
  control.updateGameDevServerPrefs({autoConnect:true})
  for(let i=0;i<100&&!control.isControlConnected();i++)await new Promise(r=>setTimeout(r,10))
  const errors=[],service=new JavaScriptLanguage(monaco,e=>errors.push(String(e)),'common')
  const source=`import Api from "${api.name}"\nvar api=new Api();\nfunction inspect(): void {\n api.players().forEach(function(player) { player.getHealth(); });\n api.players().removeIf(function(player) { return "wrong"; });\n}`
  const model=monaco.editor.createModel(source,'hanshu-javascript'),detach=service.attach(model)
  try{
   let markers=[],hover
   for(let i=0;i<200;i++){markers=monaco.editor.getModelMarkers({resource:model.uri,owner:'hanshu-tsserver'});const doc=service.documents.get(model.uri.toString());hover=await service.client.request('hover',{file:doc.file,line:4,column:source.split('\n')[3].indexOf('player.get')+1});if(markers.length===1&&markers[0].startLineNumber===5&&hover?.text.includes('ServerPlayer'))break;await new Promise(r=>setTimeout(r,30))}
   const report=await service.captureDiagnostics(model,null,null),doc=service.documents.get(model.uri.toString()),apiHover=await service.client.request('hover',{file:doc.file,line:2,column:6})
   return {markers,hover,errors,requested,apiHover,loaded:report.service.loadedClasses,missing:report.service.missingClasses,source:doc.source}
  }finally{detach();service.dispose();model.dispose();control.disconnectGameDevControl();window.WebSocket=Original}
 },{fixture,api})
 assert.equal(cold.markers.length,1,JSON.stringify(cold))
 assert.equal(cold.markers[0].startLineNumber,5)
 assert(cold.markers[0].message.includes('boolean'))
 assert(cold.hover.text.includes('ServerPlayer')&&!cold.hover.text.includes(': any'))
 assert.deepEqual(cold.errors,[])
 console.log('PASS cold Monaco service: lazy callback dependencies hydrate without hover/edit, player type inferred and genuine return error retained')
}finally{await browser?.close();await server.close()}
