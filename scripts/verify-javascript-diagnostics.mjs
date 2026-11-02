import assert from 'node:assert/strict'
import {createServer} from 'vite'
import {chromium} from 'playwright'
import {readFile} from 'node:fs/promises'
const server=await createServer({cacheDir:'node_modules/.cache/javascript-diagnostics-ui',server:{host:'127.0.0.1',port:0,hmr:false}})
await server.listen()
let browser
try{
 browser=await chromium.launch({headless:true,channel:'chrome'})
 const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/javascript-diagnostics-check',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="editor" style="height:500px"></div>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/javascript-diagnostics-check`)
 await page.evaluate(async()=>{
  const Original=window.Worker
  window.silenceLanguageWorker=false
  window.Worker=class extends Original{
   constructor(...args){super(...args);this.language=String(args[0]).includes('tsserver.worker')}
   postMessage(message,...args){if(this.language&&window.silenceLanguageWorker)return;super.postMessage(message,...args)}
  }
  const fixture=await import('/scripts/javascript-diagnostics-ui-fixture.ts')
  window.diagnosticFixture=fixture;window.diagnosticEditor=await fixture.mount()
 })
 await page.waitForFunction(()=>window.diagnosticFixture.monaco.editor.getModelMarkers({resource:window.diagnosticEditor.getModel().uri,owner:'hanshu-tsserver'}).some(marker=>marker.startLineNumber===2))
 async function downloadReport(description){
  await page.getByRole('button',{name:'导出语言服务诊断',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'导出语言服务诊断'})
  await dialog.getByLabel('问题现象与复现步骤（可选）').fill(description)
  const downloaded=page.waitForEvent('download')
  await dialog.getByRole('button',{name:'下载诊断文件'}).click()
  const download=await downloaded
  assert(download.suggestedFilename().includes('language-diagnostics'))
  return JSON.parse(await readFile(await download.path(),'utf8'))
 }
 const report=await downloadReport('第 2 行类型错误；预期 number，实际 string。')
 assert.equal(report.format,'hanshu.javascript-language-diagnostics')
 assert.equal(report.version,1)
 assert.equal(report.document.source,'function count(value: number): number {\n    return "wrong";\n}\n')
 assert(report.document.editorTransform.source.includes('value: number'))
 assert(!report.document.runtimeTransform.source.includes('value: number'))
 assert(report.markers.some(marker=>marker.startLineNumber===2&&marker.message.includes('number')))
 assert.equal(report.service.connected,false)
 assert(report.worker.submittedFiles['/host.d.ts'])
 assert(report.actualWorker.typescriptVersion)
 assert(report.actualWorker.files.some(file=>file.name===report.document.virtualFile&&file.text.includes('"wrong"')))
 assert(report.history.some(entry=>entry.event==='response'&&entry.detail.method==='diagnostics'))
 assert(report.description.includes('第 2 行'))
 assert(!JSON.stringify(report).includes('diagnostic-private-password'))
 console.log('PASS readonly/offline editor diagnostics button: downloaded source, both transforms, real Worker files, markers, history and description; connection credentials excluded')
 await page.evaluate(()=>{window.silenceLanguageWorker=true})
 const started=Date.now(),hung=await downloadReport('语言服务卡住')
 assert.equal(hung.actualWorker.unavailable,true)
 assert(hung.actualWorker.error.message.includes('超时'))
 assert.equal(hung.document.source,report.document.source)
 assert(Date.now()-started<10_000,'export must stay usable while Worker is unresponsive')
 assert(hung.history.some(entry=>entry.event==='request-error'&&entry.detail.method==='snapshot'))
 await page.evaluate(()=>{window.silenceLanguageWorker=false})
 console.log('PASS unresponsive Worker: export finishes with source and timeout evidence')
 const failure=await page.evaluate(async()=>{
  const {TsserverClient}=await import('/src/monaco/javascript/tsserverClient.ts')
  const {languageDiagnosticHistory,stringifyLanguageDiagnostics}=await import('/src/monaco/javascript/diagnostics.ts')
  const fake={postMessage(){},terminate(){},onmessage:null,onerror:null,onmessageerror:null}
  const client=new TsserverClient(fake)
  const request=client.request('completion',{file:'/missing.ts',line:2,column:3}).catch(error=>error.message)
  const pending=client.diagnosticSnapshot().pending
  fake.onerror({message:'injected Worker crash',filename:'worker.js',lineno:7,colno:3})
  const error=await request;client.dispose()
  const redacted=stringifyLanguageDiagnostics({url:'ws://local/ws?password=secret&token=abc',authorization:'Bearer xyz'},'','secret')
  return {pending,error,history:languageDiagnosticHistory(),redacted}
 })
 assert.equal(failure.pending[0].method,'completion')
 assert.equal(failure.pending[0].params.column,3)
 assert.equal(failure.error,'injected Worker crash')
 assert(failure.history.some(entry=>entry.event==='worker-error'&&entry.detail.line===7))
 assert(!failure.redacted.includes('secret')&&!failure.redacted.includes('abc')&&!failure.redacted.includes('xyz'))
 await page.evaluate(()=>window.diagnosticFixture.unmount())
 assert.deepEqual(errors,[])
 console.log('PASS Worker crash/pending request evidence, credential redaction and cleanup without unhandled errors')
}finally{await browser?.close();await server.close()}
