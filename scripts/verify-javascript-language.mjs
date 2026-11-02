import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {readFile,readdir} from 'node:fs/promises'
const server=await createServer({cacheDir:'node_modules/.cache/javascript-ui',server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
const browser=await chromium.launch({headless:true,channel:"chrome"})
try {
 const page=await browser.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message))
 await page.route('**/javascript-language-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor" style="height:500px"></div>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/javascript-language-check`)
 const result=await page.evaluate(async()=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts')
  const {transformDialect}=await import('/src/monaco/javascript/dialect.ts')
  const client=new TsserverClient()
  try {
   await client.writeFiles({'/host.d.ts':'declare namespace jvm_game_d_Player {class Player { static create():Player; level():Level; health:number; }} interface JavaTypeMap {"game.Player":typeof jvm_game_d_Player.Player} declare const Java:{type<K extends keyof JavaTypeMap>(name:K):JavaTypeMap[K]}; declare class Level { sendParticles(count:number):void; } declare var exports:any; interface CommonModules {fx:typeof import("/common/fx")} declare function __require<K extends keyof CommonModules>(id:K):CommonModules[K];','/common/fx.ts':'function answer(): number { return 42; }\nexports.answer = answer;', '/a.ts':transformDialect('import Player from "game.Player"\nvar p = Player.create();\np.','editor').source})
   const completion=await client.request('completion',{file:'/a.ts',line:3,column:3})
   await client.writeFiles({'/a.ts':transformDialect('import Player from "game.Player"\nvar p = Player.create();\np.level().sendParticles("bad");','editor').source})
   const diagnostics=await client.request('diagnostics',{file:'/a.ts'})
   const hover=await client.request('hover',{file:'/a.ts',line:3,column:11})
   await client.writeFiles({'/a.ts':transformDialect('require fx from "fx"\nfx.answer().','editor').source})
   const common=await client.request('completion',{file:'/a.ts',line:2,column:13})
   await client.writeFiles({'/common/fx.ts':'function answer(): number { return 42; }\nfunction hidden(): void { exports.nested = 1; }\nvar sample="exports.fake = 1";\nexports.answer = answer;','/a.ts':transformDialect('require fx from "fx"\nfx.','editor').source})
   const commonMembers=await client.request('completion',{file:'/a.ts',line:2,column:4})
   const typedSource='import Player from "game.Player"\nfunction health(p: Player): number { return p.health; }\nvar count=health("bad");\nfunction wrong(): number { return "bad"; }'
   const typed=transformDialect(typedSource,'editor'),runtime=transformDialect(typedSource)
   await client.writeFiles({'/a.ts':typed.source})
   const typedDiagnostics=await client.request('diagnostics',{file:'/a.ts'})
   const missing=transformDialect('function missing(value) { return value; }','editor').diagnostics
   const hook=transformDialect('@hook("tick")\nfunction tick(event: Player,board: any): void {}','editor').source
   await client.writeFiles({'/b.ts':'var isolated = 123;','/a.ts':'isolated;'})
   const isolation=await client.request('diagnostics',{file:'/a.ts'})
   return {completion,diagnostics,hover,common,commonMembers,isolation,typed,runtime,typedDiagnostics,missing,hook}
  }finally{client.dispose()}
 })
 assert(result.completion.some(x=>x.name==='level'))
 assert(result.completion.some(x=>x.name==='health'))
 assert(result.diagnostics.some(x=>x.start.line===3&&x.message.includes('number')))
 assert(result.hover?.text.includes('sendParticles'))
 assert(result.common.some(x=>x.name==='toFixed'),'common export return types must be inferred')
 assert.deepEqual(result.commonMembers.map(x=>x.name),['answer'],'only actual top-level exports form the common module type surface')
 assert(result.isolation.some(x=>x.message.includes('isolated')),'documents must not leak globals')
 assert(result.typed.source.includes('p: Player')&&result.typed.source.includes('): number'),'virtual TS must preserve explicit signatures')
 assert(!result.runtime.source.includes('p: Player')&&!result.runtime.source.includes('): number'),'PAK JS must strip signature types')
 assert(result.typedDiagnostics.some(x=>x.start.line===3&&x.message.includes('Player')),'typed Java parameter must reject a string argument')
 assert(result.typedDiagnostics.some(x=>x.start.line===4&&x.message.includes('number')),'explicit return type must be checked')
 assert(result.missing.length>0,'missing author types must fail the dialect gate')
 assert(result.hook.startsWith('//@hook("tick")\n')&&!result.hook.includes('@param'),'hook virtual line must be only a comment, without inferred JSDoc')
 console.log('PASS browser TypeScript Worker: Java class/member/return types, source diagnostic line, common export inference, document isolation')
 const fixture=JSON.parse(await readFile(process.env.JAVASCRIPT_STUB_FIXTURE??'../ModRPGToolKit/build/javascript-stubs-test.json','utf8'))
 const real=await page.evaluate(async fixture=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts'),{buildJavaFiles}=await import('/src/monaco/javascript/stubs.ts')
  const client=new TsserverClient()
  try{
   await client.writeFiles({...buildJavaFiles(fixture.classes),'/a.ts':'declare var player: jvm_net_d_minecraft_d_server_d_level_d_ServerPlayer.ServerPlayer;\nvar count=player.getInventory().getItem(0).getCount();\nvar time=player.level().getGameTime();\ncount.toFixed(2);'})
   const diagnostics=await client.request('diagnostics',{file:'/a.ts'})
   const count=await client.request('hover',{file:'/a.ts',line:2,column:6}),time=await client.request('hover',{file:'/a.ts',line:3,column:6})
   await client.writeFiles({'/a.ts':'declare var player: jvm_net_d_minecraft_d_server_d_level_d_ServerPlayer.ServerPlayer;\nplayer.getInventory().getItem(0).getCount('})
   const signature=await client.request('signature',{file:'/a.ts',line:2,column:'player.getInventory().getItem(0).getCount('.length+1})
   return {diagnostics,count,time,signature}
  }finally{client.dispose()}
 },fixture)
 assert.deepEqual(real.diagnostics,[])
 assert(real.count.text.includes('number'));assert(real.time.text.includes('number'));assert(real.signature.signatures[0].label.includes('getCount'))
 console.log('PASS actual Mod reflection stubs: player inventory/item/count and level/time chains, hover and signature')
 const lifecycle=await page.evaluate(async()=>{
  const {monaco,attachJavaScript}=await import('/scripts/javascript-language-ui-fixture.ts')
  const Original=window.Worker;let created=0,terminated=0
  window.Worker=class extends Original{constructor(...args){super(...args);this.tracked=String(args[0]).includes('tsserver.worker');if(this.tracked)created++}terminate(){if(this.tracked)terminated++;super.terminate()}}
  const errors=[],a=monaco.editor.createModel('require("bad")','javascript'),b=monaco.editor.createModel('var x=1; x.missing();','javascript')
  const first=attachJavaScript(monaco,a,e=>errors.push(String(e)),'common'),same=attachJavaScript(monaco,a,e=>errors.push(String(e)),'common'),second=attachJavaScript(monaco,b,e=>errors.push(String(e)),'common')
  try{
   for(let n=0;n<100&&!monaco.editor.getModelMarkers({resource:b.uri,owner:'hanshu-tsserver'}).length;n++)await new Promise(r=>setTimeout(r,50))
   const gate=monaco.editor.getModelMarkers({resource:a.uri,owner:'hanshu-dialect'}),type=monaco.editor.getModelMarkers({resource:b.uri,owner:'hanshu-tsserver'})
   first.dispose();a.setValue('load("bad")');await new Promise(r=>setTimeout(r,300))
   const retained=monaco.editor.getModelMarkers({resource:a.uri,owner:'hanshu-dialect'}).length>0
   same.dispose();const midway=terminated;second.dispose()
   return {created,terminated,midway,retained,gate:gate.length,type:type.length,errors}
  }finally{a.dispose();b.dispose();window.Worker=Original}
 })
 assert.equal(lifecycle.created,1);assert.equal(lifecycle.midway,0);assert.equal(lifecycle.terminated,1);assert(lifecycle.retained&&lifecycle.gate&&lifecycle.type);assert.deepEqual(lifecycle.errors,[])
 console.log('PASS actual Monaco integration: dialect/type markers, shared Worker, duplicate model references and final disposal')
 const cancelled=await page.evaluate(async()=>{
  const {monaco,attachJavaScript}=await import('/scripts/javascript-language-ui-fixture.ts'),errors=[]
  const model=monaco.editor.createModel('var value=1;','javascript'),binding=attachJavaScript(monaco,model,error=>errors.push(String(error)),'common')
  binding.dispose();model.dispose();await new Promise(resolve=>setTimeout(resolve,100))
  return errors
 })
 assert.deepEqual(cancelled,[])
 const hooks=await page.evaluate(async fixture=>{
  const {monaco}=await import('/scripts/javascript-language-ui-fixture.ts'),{JavaScriptLanguage}=await import('/src/monaco/javascript/javascriptLanguage.ts'),control=await import('/src/gameDevServer/controlHub.ts')
  const Original=window.WebSocket;let socket,revision=1
  const snapshots={player:'mchhui.rpgtoolkit.feature.script.player.PlayerEvent$Hurt',actor:'mchhui.rpgtoolkit.feature.actor.hook.ActorHurtEvent'}
  window.WebSocket=class {
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
   send(raw){const request=JSON.parse(raw);if(request.type!=='request')return;let result
    if(request.method==='javascript.stubs')result={...fixture,classes:fixture.classes.filter(c=>request.params.classes.includes(c.name)),missing:request.params.classes.filter(n=>!fixture.classes.some(c=>c.name===n))}
    else {const type=request.method.includes('player')?'player':'actor';result={schemaVersion:1,runtimeId:'hook-test',revision,hooks:[{id:revision===2?'custom_hurt':'hurt',cancellable:true,eventClass:snapshots[type]}]}}
    setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:request.id,ok:true,result})}),5)
   }
   close(){this.readyState=3;this.onclose?.({code:1000})}
  }
  const results=[],errors=[]
  try{
   control.updateGameDevServerPrefs({autoConnect:true})
   for(let i=0;i<50&&!control.isControlConnected();i++)await new Promise(r=>setTimeout(r,10))
   for(const type of ['player','actor']){
    revision=1
    const service=new JavaScriptLanguage(monaco,e=>errors.push(String(e)),type),model=monaco.editor.createModel(`import Hurt from "${snapshots[type]}"\n@hook("hurt")\nfunction damage(event: Hurt,board: Blackboard): void {\n event.\n}`,'javascript'),detach=service.attach(model)
    try{
     let entries=[]
     for(let i=0;i<100;i++){const doc=service.documents.get(model.uri.toString());entries=await service.client.request('completion',{file:doc.file,line:4,column:8});if(entries.some(e=>e.name==='amount'))break;await new Promise(r=>setTimeout(r,30))}
     results.push({type,amount:entries.some(e=>e.name==='amount'),setAmount:entries.some(e=>e.name==='setAmount'),sourceEntity:entries.some(e=>e.name==='sourceEntity')})
     revision=2;socket.onmessage({data:JSON.stringify({type:'notify',method:`javascript.${type}Hooks.changed`,params:{runtimeId:'hook-test',revision}})})
     for(let i=0;i<100&&!monaco.editor.getModelMarkers({resource:model.uri,owner:'hanshu-dialect'}).some(m=>m.message.includes('未注册'));i++)await new Promise(r=>setTimeout(r,20))
     results.at(-1).changed=monaco.editor.getModelMarkers({resource:model.uri,owner:'hanshu-dialect'}).some(m=>m.message.includes('未注册'))
     revision=1;socket.onmessage({data:JSON.stringify({type:'notify',method:`javascript.${type}Hooks.changed`,params:{runtimeId:'hook-test',revision}})})
     await new Promise(r=>setTimeout(r,50));results.at(-1).staleIgnored=monaco.editor.getModelMarkers({resource:model.uri,owner:'hanshu-dialect'}).some(m=>m.message.includes('未注册'))
    }finally{detach();service.dispose();model.dispose()}
   }
  }finally{control.disconnectGameDevControl();window.WebSocket=Original}
  return {results,errors}
 },fixture)
 for(const h of hooks.results)assert(h.amount&&(h.type==='player'?h.setAmount:h.sourceEntity&&!h.setAmount)&&h.changed&&h.staleIgnored,JSON.stringify(h))
 assert.deepEqual(hooks.errors,[])
 console.log('PASS dynamic Control hook snapshots: actual player/actor Hurt members, revision updates and stale response rejection')
 const production=(await readdir('dist/assets')).find(name=>name.startsWith('tsserver.worker-')&&name.endsWith('.js'))
 assert(production,'build production Worker before this verification')
 const prod=await page.evaluate(async name=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts'),client=new TsserverClient(new Worker(`/dist/assets/${name}`))
  try{await client.writeFiles({'/test.ts':'var count=123;\ncount.'});return await client.request('completion',{file:'/test.ts',line:2,column:7})}finally{client.dispose()}
 },production)
 assert(prod.some(e=>e.name==='toFixed'))
 console.log('PASS built production Worker')
 assert.deepEqual(pageErrors,[],'worker cancellation must not leak unhandled page errors')
}finally{await browser.close();await server.close()}
