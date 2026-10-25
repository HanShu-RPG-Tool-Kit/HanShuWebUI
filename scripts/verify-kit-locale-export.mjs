import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import JSZip from 'jszip'

const server=await createServer({configFile:false,appType:'custom',server:{host:'127.0.0.1',port:0},optimizeDeps:{include:['jszip']}})
server.middlewares.use((req,res,next)=>{if(req.url!=='/kit-locale-test')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Kit locale export regression</title>')})
let browser
try {
 await server.listen()
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage()
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/kit-locale-test`)
 const result=await page.evaluate(async()=>{
  const {putAssetBlob}=await import('/src/assets/idb.ts')
  const {exportPaks}=await import('/src/export/pack/exportPaks.ts')
  const {createProject}=await import('/src/workspace.ts')
  const {createKit,stringifyKit}=await import('/src/workspaces/quest/kit.ts')
  const pkg=createProject('kit-locale-regression')
  for(const id of ['starter','other']){
   const kit=createKit();kit.feedback.message='feedback.message'
   pkg.scripts.push({id,name:`${id}.kit`,content:stringifyKit(kit),updatedAt:0})
  }
  pkg.scripts.push({id:'story',name:'story.hs',content:'narrator:7f3a91c2//',updatedAt:0})
  const tables={
   'assets/zh_cn/lang_kit/starter.lang':{name:'新手礼包','feedback.message':'领取成功','custom.note':'保留文档内语义键'},
   'assets/en_us/lang_kit/starter.lang':{name:'Starter kit','feedback.message':'Granted'},
   'assets/zh_cn/lang_kit/other.lang':{name:'另一个礼包','feedback.message':'另一个反馈'},
   'assets/zh_cn/lang_kit/orphan.lang':{name:'未导出源文件'},
   'assets/zh_cn/lang_hs/story.lang':{'7f3a91c2':'剧本正文','deadbeef':'未引用','name':'不是 kit 名称'},
  }
  for(const [path,table] of Object.entries(tables)){
   const blob=new Blob([JSON.stringify(table)],{type:'application/json'})
   pkg.assets.push({id:path,path,mime:blob.type,size:blob.size,updatedAt:0})
   await putAssetBlob(pkg.id,path,blob)
  }
  const output=await exportPaks({packages:[pkg],activeScriptId:null,activeAssetId:null},{targets:['combined','server','client']})
  return {diagnostics:output.diagnostics,packs:await Promise.all(output.packs.map(async p=>({target:p.target,bytes:Array.from(new Uint8Array(await p.blob.arrayBuffer()))})))}
 })
 assert.equal(result.diagnostics.filter(d=>d.severity==='error').length,0,JSON.stringify(result.diagnostics))
 for(const pack of result.packs){
  const zip=await JSZip.loadAsync(Uint8Array.from(pack.bytes))
  const starter=JSON.parse(await zip.file('assets/zh_cn/lang_kit/starter.lang').async('string'))
  assert.deepEqual(starter,{name:'新手礼包','feedback.message':'领取成功','custom.note':'保留文档内语义键'})
  assert.equal(JSON.parse(await zip.file('assets/zh_cn/lang_kit/other.lang').async('string')).name,'另一个礼包')
  assert.equal(JSON.parse(await zip.file('assets/en_us/lang_kit/starter.lang').async('string')).name,'Starter kit')
  assert.equal(zip.file('assets/zh_cn/lang_kit/orphan.lang'),null)
  assert.equal(Boolean(zip.file('gift/starter.kit')),pack.target!=='client')
  if(pack.target!=='server')assert.deepEqual(JSON.parse(await zip.file('assets/zh_cn/lang_hs/story.lang').async('string')),{'7f3a91c2':'剧本正文'})
  if(pack.target==='combined'&&process.env.KIT_LOCALE_PAK_PATH)await writeFile(process.env.KIT_LOCALE_PAK_PATH,Uint8Array.from(pack.bytes))
 }
 console.log('通过：真实 IndexedDB → 编译图 → combined/server/client PAK；kit 多文档多语言语义键保留，HS 仍按引用裁剪，无全局键冲突。')
} finally {await browser?.close();await server.close()}
