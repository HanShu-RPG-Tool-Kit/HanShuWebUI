import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'

const stub={
 name:'net.example.Foo',
 symbol:'Foo',
 module:'jvm_net_d_example_d_Foo',
 source:'declare namespace jvm_net_d_example_d_Foo { export class Foo { private brand: void; bar(): void; } }\n',
 dependencies:[],
}
const server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
let browser
try{
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/java-online-prefer-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor"></div>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/java-online-prefer-check`)
 const result=await page.evaluate(async stub=>{
  const control=await import('/src/gameDevServer/controlHub.ts')
  const requests=[]
  window.WebSocket=class{
   static OPEN=1;static CONNECTING=0;readyState=0
   constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.({})},0)}
   send(raw){const r=JSON.parse(raw);if(r.type!=='request')return;requests.push(r)
    let result
    if(r.method==='javascript.library.page'){
     result={schemaVersion:1,runtimeId:'online-prefer',classes:[stub],missing:[],next:1,total:1,done:true,javaVersion:'25'}
    }else if(r.method==='javascript.stubs'){
     result={schemaVersion:1,runtimeId:'online-prefer',classes:r.params.classes.includes(stub.name)?[stub]:[],missing:r.params.classes.filter(n=>n!==stub.name)}
    }else if(r.method==='javascript.classes.search'){
     result={schemaVersion:1,runtimeId:'online-prefer',classes:[{name:stub.name,symbol:stub.symbol,packageName:'net.example',origin:'游戏'}],hasMore:false}
    }else{
     result={schemaVersion:1,runtimeId:'online-prefer',revision:1,hooks:[{id:'tick',cancellable:false,eventClass:'net.example.Foo'}]}
    }
    setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:r.id,ok:true,result})}),5)
   }
   close(){this.readyState=3;this.onclose?.({code:1000})}
  }
  control.updateGameDevServerPrefs({autoConnect:true})
  for(let i=0;i<100&&!control.isControlConnected();i++)await new Promise(r=>setTimeout(r,20))
  const lib=await import('/src/monaco/javascript/javaLibrary.ts')
  await lib.syncJavaLibrary(new AbortController().signal,()=>{})
  const library=await lib.readJavaLibrary()
  if(!library)throw Error('library missing after sync')

  const {searchJavaClasses}=await import('/src/monaco/javascript/javaImportAction.ts')
  const beforeSearch=requests.length
  const onlineSearch=await searchJavaClasses('Foo')
  const searchOnline=requests.slice(beforeSearch).some(r=>r.method==='javascript.classes.search')

  const ui=await import('/scripts/javascript-diagnostics-ui-fixture.ts')
  const editor=await ui.mount({
   source:'import Foo from "net.example.Foo"\n@hook("tick")\nfunction on_tick(event: Foo, board: Blackboard): void {\n event.bar();\n}\n',
   readOnly:false,
   scriptType:'actor',
  })
  control.updateGameDevServerPrefs({autoConnect:true})
  for(let i=0;i<100&&!control.isControlConnected();i++)await new Promise(r=>setTimeout(r,20))
  const beforeLang=requests.length
  const {captureJavaScriptDiagnostics,peekJavaScriptHooks}=await import('/src/monaco/javascript/javascriptLanguage.ts')
  let report,hooks=[]
  for(let i=0;i<200;i++){
   report=await captureJavaScriptDiagnostics(editor.getModel(),null,null)
   hooks=peekJavaScriptHooks(editor.getModel())
   if(report.service.loadedClasses?.includes(stub.name)&&hooks.some(h=>h.id==='tick'))break
   await new Promise(r=>setTimeout(r,30))
  }
  const langOnline=requests.slice(beforeLang).some(r=>r.method==='javascript.stubs')&&requests.slice(beforeLang).some(r=>r.method==='javascript.actorHooks')

  control.updateGameDevServerPrefs({autoConnect:false})
  for(let i=0;i<100&&control.isControlConnected();i++)await new Promise(r=>setTimeout(r,20))
  const offlineSearch=await searchJavaClasses('Foo')
  const beforeOffline=requests.length
  for(let i=0;i<200;i++){
   report=await captureJavaScriptDiagnostics(editor.getModel(),null,null)
   hooks=peekJavaScriptHooks(editor.getModel())
   if(report.service.loadedClasses?.includes(stub.name)&&hooks.some(h=>h.id==='tick')&&!control.isControlConnected())break
   await new Promise(r=>setTimeout(r,30))
  }
  const offlineRequests=requests.slice(beforeOffline).filter(r=>r.method==='javascript.stubs'||r.method==='javascript.actorHooks'||r.method==='javascript.classes.search')
  return {
   onlineSearchRuntime:onlineSearch.runtimeId,
   searchOnline,
   langOnline,
   onlineHooks:hooks.map(h=>h.id),
   offlineSearchRuntime:offlineSearch.runtimeId,
   offlineSearchHit:offlineSearch.classes.some(c=>c.symbol==='Foo'),
   offlineHooks:hooks.map(h=>h.id),
   offlineLoaded:report.service.loadedClasses,
   offlineRequests,
   libraryId:library.id,
   connected:control.isControlConnected(),
  }
 },stub)
 assert.equal(result.onlineSearchRuntime,'online-prefer')
 assert(result.searchOnline)
 assert(result.langOnline)
 assert.deepEqual(result.onlineHooks,['tick'])
 assert.equal(result.offlineSearchRuntime,result.libraryId)
 assert(result.offlineSearchHit)
 assert.deepEqual(result.offlineHooks,['tick'])
 assert(result.offlineLoaded.includes(stub.name),JSON.stringify(result))
 assert.equal(result.offlineRequests.length,0)
 assert.equal(result.connected,false)
 assert.deepEqual(errors,[])
 console.log('PASS online prefers live protocols; offline falls back to local library without write-back')
}finally{await browser?.close();await server.close()}
