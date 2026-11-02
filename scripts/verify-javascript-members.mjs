import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'

const fixture=JSON.parse(await readFile('../ModRPGToolKit/build/javascript-stubs-test.json','utf8'))
const template=(await readFile('src/scriptResources/templates/player/default.js','utf8')).replaceAll('{{name}}','player template')
const server=await createServer({cacheDir:'node_modules/.cache/javascript-diagnostics-ui',server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
let browser
try{
 browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage(),pageErrors=[]
 page.on('pageerror',error=>pageErrors.push(error.message))
 await page.route('**/javascript-members-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor" style="height:500px"></div>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/javascript-members-check`)
 await page.evaluate(async({fixture,template})=>{
  const ui=await import('/scripts/javascript-diagnostics-ui-fixture.ts')
  const control=await import('/src/gameDevServer/controlHub.ts')
  const {javaModule}=await import('/src/monaco/javascript/stubs.ts')
  const additional=[['net.minecraft.world.entity.player.Abilities','mayfly:boolean; flying:boolean;'],['mchhui.rpgtoolkit.feature.script.player.PlayerEvent','']].map(([name,body])=>({name,module:javaModule(name),symbol:name.split('.').at(-1),dependencies:[],source:`declare namespace ${javaModule(name)} { class ${name.split('.').at(-1)} {${body}} } interface JavaTypeMap {${JSON.stringify(name)}:typeof ${javaModule(name)}.${name.split('.').at(-1)}}`}))
  const classes=[...fixture.classes,...additional],Original=window.WebSocket,requests=[]
  window.WebSocket=class{
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
   send(raw){const request=JSON.parse(raw);if(request.type!=='request')return;requests.push(request)
    const result=request.method==='javascript.stubs'?{schemaVersion:1,runtimeId:'member-regression',classes:classes.filter(c=>request.params.classes.includes(c.name)),missing:request.params.classes.filter(name=>!classes.some(c=>c.name===name))}:{schemaVersion:1,runtimeId:'member-regression',revision:1,hooks:[{id:'join',cancellable:false,eventClass:'mchhui.rpgtoolkit.feature.script.player.PlayerEvent'},{id:'tick',cancellable:false,eventClass:'mchhui.rpgtoolkit.feature.script.player.PlayerEvent'}]}
    setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:request.id,ok:true,result})}),5)
   }
   close(){this.readyState=3;this.onclose?.({code:1000})}
  }
  window.memberFixture={ui,control,Original,requests}
  window.memberEditor=await ui.mount({source:template,scriptType:'player',readOnly:false})
  control.updateGameDevServerPrefs({autoConnect:true})
 },{fixture,template})
 await page.waitForFunction(()=>window.memberFixture.requests.some(r=>r.method==='javascript.stubs'&&r.params.classes.includes('mchhui.rpgtoolkit.feature.script.player.PlayerEvent')))
 const initial=await page.evaluate(async()=>{
  const {monaco}=window.memberFixture.ui,model=window.memberEditor.getModel()
  for(let i=0;i<100;i++){
   const {captureJavaScriptDiagnostics}=await import('/src/monaco/javascript/javascriptLanguage.ts')
   const snapshot=await captureJavaScriptDiagnostics(model,null,null)
   if(snapshot.actualWorker?.files.some(file=>file.name.includes('PlayerEvent.d.ts')&&file.text?.includes('interface JavaTypeMap')))break
   await new Promise(resolve=>setTimeout(resolve,20))
  }
  // Simulate a built-in JS validation request that was already in flight when the language switched.
  monaco.editor.setModelMarkers(model,'javascript',[{severity:monaco.MarkerSeverity.Error,message:'Type annotations can only be used in TypeScript files.',startLineNumber:6,startColumn:25,endLineNumber:6,endColumn:36}])
  const ordinary=monaco.editor.createModel('var ordinary=1;','javascript')
  monaco.editor.setModelMarkers(ordinary,'javascript',[{severity:monaco.MarkerSeverity.Error,message:'ordinary JavaScript diagnostic',startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4}])
  await new Promise(resolve=>setTimeout(resolve,150))
  const result={language:model.getLanguageId(),markers:monaco.editor.getModelMarkers({resource:model.uri}),ordinary:monaco.editor.getModelMarkers({resource:ordinary.uri}).some(m=>m.message==='ordinary JavaScript diagnostic')}
  ordinary.dispose();return result
 })
 assert.equal(initial.language,'hanshu-javascript')
 assert(!initial.markers.some(marker=>marker.owner==='javascript'),JSON.stringify(initial.markers))
 assert(!initial.markers.some(marker=>marker.severity===8),JSON.stringify(initial.markers))
 assert(initial.ordinary,'ordinary JS diagnostics must not be disabled globally')
 console.log('PASS real player template: dialect language from creation, stale built-in JS errors removed, ordinary JavaScript checks retained')

 const lazy=await page.evaluate(async()=>{
  const {JavaScriptLanguage}=await import('/src/monaco/javascript/javascriptLanguage.ts'),{monaco}=window.memberFixture.ui
  const errors=[],service=new JavaScriptLanguage(monaco,error=>errors.push(String(error)),'common')
  const source='import ServerPlayer from "net.minecraft.server.level.ServerPlayer"\nfunction inspect(player: ServerPlayer): void {\n var level=player.level();\n level.playSound;\n level.sendParticles;\n var abilities=player.getAbilities();\n abilities.mayfly=false;\n abilities.flying=false;\n abilities.notARealField=1;\n}'
  const model=monaco.editor.createModel(source,'hanshu-javascript'),detach=service.attach(model)
  try{
   let markers=[]
   for(let i=0;i<150;i++){
    markers=monaco.editor.getModelMarkers({resource:model.uri,owner:'hanshu-tsserver'})
    if(markers.length===1&&markers[0].message.includes('notARealField'))break
    await new Promise(resolve=>setTimeout(resolve,30))
   }
   const report=await service.captureDiagnostics(model,null,null)
   return {markers,loaded:report.service.loadedClasses,errors,requested:window.memberFixture.requests.filter(r=>r.method==='javascript.stubs').flatMap(r=>r.params.classes)}
  }finally{detach();service.dispose();model.dispose()}
 })
 assert.equal(lazy.markers.length,1,JSON.stringify(lazy))
 assert(lazy.markers[0].message.includes('notARealField'),JSON.stringify(lazy))
 assert(lazy.loaded.includes('net.minecraft.server.level.ServerLevel'))
 assert(lazy.loaded.includes('net.minecraft.world.entity.player.Abilities'))
 assert.deepEqual(lazy.errors,[])
 console.log('PASS cold diagnostics without hover/edit: real ServerLevel methods and Abilities fields load on demand; genuine missing-field error remains')

 async function accept(prefix,suffix=''){
  await page.evaluate(({prefix,suffix})=>{
   const source=`import ServerPlayer from "net.minecraft.server.level.ServerPlayer"\nfunction inspect(player: ServerPlayer): void {\n    player.${prefix}${suffix}\n}`
   window.memberEditor.getModel().setValue(source)
   window.memberEditor.setPosition({lineNumber:3,column:`    player.${prefix}`.length+1})
   window.memberEditor.focus()
  },{prefix,suffix})
  await page.keyboard.press('Alt+/')
  await page.locator('.suggest-widget.visible .monaco-list-row.focused').waitFor({state:'visible'})
  const icon=await page.locator('.suggest-widget.visible .monaco-list-row.focused .suggest-icon').getAttribute('class')
  await page.keyboard.press('Tab')
  return {...await page.evaluate(()=>({source:window.memberEditor.getValue(),position:window.memberEditor.getPosition()})),icon}
 }
 const method=await accept('lev')
 assert(method.source.includes('player.level()'),method.source)
 assert(method.icon.includes('symbol-method'),method.icon)
 assert.equal(method.position.column,'    player.level()'.length+1)
 const field=await accept('hurtM')
 assert(field.source.includes('player.hurtMarked'),field.source)
 assert(!field.source.includes('hurtMarked('),field.source)
 assert(field.icon.includes('symbol-field'),field.icon)
 const argumentsMethod=await accept('setDel')
 assert(argumentsMethod.source.includes('player.setDeltaMovement()'),argumentsMethod.source)
 assert.equal(argumentsMethod.position.column,'    player.setDeltaMovement('.length+1,'argument-taking methods put the caret inside parentheses')
 const existing=await accept('lev','()')
 assert(existing.source.includes('player.level()')&&!existing.source.includes('level()()'),existing.source)
 console.log('PASS actual suggestion acceptance: level() and field icons differ, fields keep bare names, argument caret is inside call, existing parentheses are not duplicated')

 const callable=await page.evaluate(async()=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts'),{stringifyLanguageDiagnostics}=await import('/src/monaco/javascript/diagnostics.ts')
  const client=new TsserverClient()
  try{
   await client.writeFiles({'/host.d.ts':'declare const callbacks:{run:(value:number)=>void;flag:boolean};','/test.ts':'callbacks.'})
   const entries=await client.request('completion',{file:'/test.ts',line:1,column:11})
   await client.writeFiles({'/overloads.ts':'declare function choose(value: string): string;\ndeclare function choose(value: number, radix: number): number;\nchoose(1, '})
   const overloads=await client.request('signature',{file:'/overloads.ts',line:3,column:11})
   const redacted=JSON.parse(stringifyLanguageDiagnostics({document:{source:'import X from "mchhui.rpgtoolkit.X"'},typeText:'jvm_mchhui_d_rpgtoolkit',error:{message:'password=mchhui'}},'','mchhui'))
   return {entries,redacted,overloads}
  }finally{client.dispose()}
 })
 assert.equal(callable.entries.find(entry=>entry.name==='run').callable,true)
 assert.equal(callable.entries.find(entry=>entry.name==='run').parameterCount,1)
 assert.equal(callable.entries.find(entry=>entry.name==='flag').callable,false)
 assert.equal(callable.overloads.signatures.length,2)
 assert(callable.overloads.signatures[0].label.includes('value: string'))
 assert(callable.overloads.signatures[1].label.includes('radix: number'))
 assert.equal(callable.overloads.activeSignature,1)
 assert.equal(callable.overloads.activeParameter,1)
 assert(callable.redacted.document.source.includes('mchhui.rpgtoolkit'))
 assert(callable.redacted.typeText.includes('mchhui'))
 assert(!callable.redacted.error.message.includes('mchhui'))
 await page.evaluate(()=>{window.memberFixture.control.disconnectGameDevControl();window.WebSocket=window.memberFixture.Original;window.memberFixture.ui.unmount()})
 assert.deepEqual(pageErrors,[])
 console.log('PASS callable properties versus data fields; diagnostic credential redaction preserves Java package/type/source identifiers')
}finally{await browser?.close();await server.close()}
