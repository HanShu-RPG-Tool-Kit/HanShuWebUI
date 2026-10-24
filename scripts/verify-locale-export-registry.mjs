import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import JSZip from 'jszip'

const server=await createServer({configFile:false,appType:'custom',server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['jszip']}})
server.middlewares.use((req,res,next)=>{if(req.url!=='/locale-registry-test')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Locale export registry</title>')})
let browser
try {
 await server.listen()
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage()
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/locale-registry-test`)
 const result=await page.evaluate(async()=>{
  const api=await import('/src/export/compile/index.ts')
  const registry=await import('/src/export/compile/registry.ts')
  const {exportPaks}=await import('/src/export/pack/exportPaks.ts')
  const {putAssetBlob}=await import('/src/assets/idb.ts')
  const {createProject}=await import('/src/workspace.ts')
  const check=(condition,message)=>{if(!condition)throw new Error(message)}
  registry.clearCompileRegistry();api.ensureBuiltinCompilers()
  check(registry.listFileCompilers().length===3,'clear/reinstall builtin compilers')
  check(api.listLocaleExportRules().length===6,'builtin locale rules missing')
  let rejected=false
  try{api.registerLocaleExportRule({id:'ambiguous',sourceExt:'hs',text:{plane:'client',keys:'all'}})}catch{rejected=true}
  check(rejected,'ambiguous extension registration accepted')
  api.registerLocaleExportRule({id:'widget',sourceExt:'widget',
   text:{plane:'server',keys:'referenced',references:({source})=>JSON.parse(source.content).keys},
   voice:{plane:'client',keys:'all'},
  })
  api.registerFileCompiler({id:'widget',match:file=>file.name.endsWith('.widget'),async compile(file,ctx){return [{path:`widgets/${file.name}`,bytes:file.content,plane:'server',sourcePath:file.name,packageName:ctx.index.package.name,requires:JSON.parse(file.content).keys.map(id=>({kind:'localeKey',id}))}]}})
  const pkg=createProject('locale-registry')
  for(const [name,content] of Object.entries({
   'a.hs':'narrator:7f3a91c2//','nested/b.hs':'narrator:7f3a91c2//',
   'hero.char':'name:12345678','quest.progress':'{}','story.hflow':'{}','point.nav':'{}',
   'panel.widget':JSON.stringify({keys:['title']}),
  }))pkg.scripts.push({id:name,name,content,updatedAt:0})
  async function asset(path,content,refTarget){const blob=new Blob([typeof content==='string'?content:JSON.stringify(content)]);pkg.assets.push({id:path,path,size:blob.size,mime:'application/octet-stream',updatedAt:0,...(refTarget?{refTarget}:{})});await putAssetBlob(pkg.id,path,blob)}
  await asset('assets/zh_cn/lang_hs/a.lang',{'7f3a91c2':'A中文','deadbeef':'裁剪'})
  await asset('assets/en_us/lang_hs/a.lang',{'7f3a91c2':'A English'})
  await asset('assets/zh_cn/lang_hs/nested/b.lang',{'7f3a91c2':'B中文'})
  await asset('assets/zh_cn/voice_hs/a/7f3a91c2.ogg','direct-A')
  await asset('assets/zh_cn/voice_hs/nested/b/7f3a91c2.ref','assets/raw/b.ogg','assets/raw/b.ogg')
  await asset('assets/raw/b.ogg','materialized-B')
  await asset('assets/zh_cn/voice_hs/a/7f3a91c2.ref','missing','assets/missing.ogg')
  await asset('assets/zh_cn/voice_hs/a/deadbeef.ogg','unused-voice')
  await asset('assets/zh_cn/lang_char/hero.lang',{'12345678':'角色名'})
  await asset('assets/zh_cn/lang_progress/quest.lang',{name:'任务',description:'说明'})
  await asset('assets/zh_cn/lang_hflow/story.lang',{'entry.title':'流程'})
  await asset('assets/zh_cn/lang_nav/point.lang',{label:'导航'})
  await asset('assets/zh_cn/lang_widget/panel.lang',{title:'Panel',unused:'裁剪'})
  await asset('assets/zh_cn/voice_widget/panel/intro.ref','assets/raw/b.ogg','assets/raw/b.ogg')
  await asset('assets/zh_cn/lang_widget/orphan.lang',{title:'孤立'})
  await asset('assets/zh_cn/lang_unknown/unregistered.lang',{name:'未知规则'})
  const output=await exportPaks({packages:[pkg],activeScriptId:null,activeAssetId:null},{targets:['combined','server','client']})
  check(!output.diagnostics.some(d=>d.severity==='error'),'duplicate locale keys/languages/media failed linking')
  check(output.warnings.some(s=>s.includes('未注册本地化导出规则')),'unknown rule warning missing')
  // A missing translation cannot be satisfied by another source's same key.
  const graph=await api.buildCompileGraph({packages:[{...pkg,assets:pkg.assets.filter(a=>!a.path.includes('lang_hs/a.lang'))}],activeScriptId:null,activeAssetId:null})
  check(graph.diagnostics.some(d=>d.code==='missing_require'&&d.sourcePath==='a.hs'),'foreign document satisfied missing locale key')
  // References remain strictly checked even for a custom type.
  pkg.assets.find(a=>a.path==='assets/zh_cn/voice_widget/panel/intro.ref').refTarget='assets/missing.ogg'
  let missingRef=false
  try{await api.buildCompileGraph({packages:[pkg],activeScriptId:null,activeAssetId:null})}catch{missingRef=true}
  check(missingRef,'dangling voice ref accepted')
  // Overrides survive ensureBuiltinCompilers; reset cleanly restores the standard policy.
  api.registerLocaleExportRule({id:'kit',sourceExt:'kit',text:{plane:'server',keys:'all'}})
  api.ensureBuiltinCompilers();check(api.listLocaleExportRules().find(r=>r.id==='kit').text.plane==='server','builtin overwrote explicit override')
  registry.clearCompileRegistry();api.ensureBuiltinCompilers()
  check(api.listLocaleExportRules().find(r=>r.id==='kit').text.plane==='shared','reset did not restore defaults')
  check(!api.listLocaleExportRules().some(r=>r.id==='widget'),'clear left custom rule')
  return await Promise.all(output.packs.map(async p=>({target:p.target,bytes:Array.from(new Uint8Array(await p.blob.arrayBuffer()))})))
 })
 for(const pack of result){
  const zip=await JSZip.loadAsync(Uint8Array.from(pack.bytes))
  for(const path of ['assets/zh_cn/lang_progress/quest.lang','assets/zh_cn/lang_hflow/story.lang','assets/zh_cn/lang_nav/point.lang'])assert.ok(zip.file(path),`${pack.target}: ${path}`)
  assert.equal(Boolean(zip.file('assets/zh_cn/lang_widget/panel.lang')),pack.target!=='client')
  assert.equal(Boolean(zip.file('assets/zh_cn/voice_widget/panel/intro.ogg')),pack.target!=='server')
  assert.equal(zip.file('assets/zh_cn/lang_widget/orphan.lang'),null)
  assert.equal(zip.file('assets/zh_cn/lang_unknown/unregistered.lang'),null)
  if(pack.target!=='server'){
   assert.deepEqual(JSON.parse(await zip.file('assets/zh_cn/lang_hs/a.lang').async('string')),{'7f3a91c2':'A中文'})
   assert.equal(await zip.file('assets/zh_cn/voice_hs/a/7f3a91c2.ogg').async('string'),'direct-A')
   assert.equal(await zip.file('assets/zh_cn/voice_hs/nested/b/7f3a91c2.ogg').async('string'),'materialized-B')
   assert.equal(zip.file('assets/zh_cn/voice_hs/a/deadbeef.ogg'),null)
   assert.ok(zip.file('assets/en_us/lang_hs/a.lang'))
   assert.ok(zip.file('assets/zh_cn/lang_char/hero.lang'))
  }
  if(pack.target!=='client')assert.deepEqual(JSON.parse(await zip.file('assets/zh_cn/lang_widget/panel.lang').async('string')),{title:'Panel'})
 }
 console.log('通过：内置规则、自定义注册、覆盖/重置、文本/配音独立平面、文档与语种隔离、引用裁剪、OGG优先与ref落地、缺失诊断。')
} finally {await browser?.close();await server.close()}
