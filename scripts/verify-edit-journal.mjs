import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { chromium } from 'playwright'

// Exercise the actual browser module and actual IndexedDB/BroadcastChannel, with
// multiple pages in ONE browser context (the collision hidden by isolated contexts).
const bundled = await build({entryPoints:['src/project/editJournal.ts'],bundle:true,format:'esm',platform:'browser',write:false})
const html = '<!doctype html><meta charset="utf-8"><title>Journal verification</title><script type="module">import {openEditJournal} from "/journal.js";window.openEditJournal=openEditJournal;window.ready=true</script>'
const server = createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store')
  if(req.url==='/journal.js'){res.setHeader('Content-Type','text/javascript');res.end(bundled.outputFiles[0].text)}
  else{res.setHeader('Content-Type','text/html');res.end(html)}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
const context=await browser.newContext()
const errors=[]
context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)))
let checks=0
async function test(name,run){await run();checks++;console.log(`通过：${name}`)}
async function page(){const p=await context.newPage();await p.goto(base);await p.waitForFunction(()=>window.ready);return p}
async function open(p){return p.evaluate(async()=>{window.journal=window.openEditJournal('project:subject');const records=await window.journal.load();return{id:sessionStorage.getItem('hanshu.editWindow'),records}})}
const record=(text)=>[{id:1,requestId:`request-${text}`,label:text,phase:'uncertain',message:'lost reply',code:'commit_uncertain',edits:[{op:'write',path:'src/a.hs',data:text,version:null}],stagedPaths:[]}]
async function save(p,text){await p.evaluate(records=>window.journal.save(records),record(text))}
async function load(p){return p.evaluate(()=>window.journal.load())}
try{
  const a=await page();const initial=await open(a);await save(a,'A pending')
  let b;let bScope
  await test('复制页面继承sessionStorage但不会读取原页面的待确认提交',async()=>{
    const popup=context.waitForEvent('page')
    await a.evaluate(url=>window.open(url,'_blank'),base)
    b=await popup;await b.waitForFunction(()=>window.ready)
    assert.equal(await b.evaluate(()=>sessionStorage.getItem('hanshu.editWindow')),initial.id,'The test must actually copy sessionStorage')
    bScope=await open(b)
    assert.notEqual(bScope.id,initial.id)
    assert.deepEqual(bScope.records,[])
    assert.deepEqual(await load(a),record('A pending'))
  })
  await test('同context两页同时写同工程主体的提交日志，内容各自保留',async()=>{
    await Promise.all([save(a,'A latest'),save(b,'B latest')])
    assert.deepEqual(await load(a),record('A latest'))
    assert.deepEqual(await load(b),record('B latest'))
  })
  await test('各自刷新恢复原scope与原提交，同页面重连复用owner',async()=>{
    await a.reload();await a.waitForFunction(()=>window.ready)
    const restoredA=await open(a)
    assert.equal(restoredA.id,initial.id);assert.deepEqual(restoredA.records,record('A latest'))
    await b.reload();await b.waitForFunction(()=>window.ready)
    const restoredB=await open(b)
    assert.equal(restoredB.id,bScope.id);assert.deepEqual(restoredB.records,record('B latest'))
    const repeated=await a.evaluate(async()=>{
      const [one,two]=await Promise.all([window.openEditJournal('project:subject').load(),window.openEditJournal('project:subject').load()])
      return{id:sessionStorage.getItem('hanshu.editWindow'),one,two}
    })
    assert.equal(repeated.id,initial.id);assert.deepEqual(repeated.one,record('A latest'));assert.deepEqual(repeated.two,repeated.one)
  })
  await test('同时启动的重复scope候选由握手与IDB原子claim分开',async()=>{
    for(let round=0;round<4;round++){
      const c=await page();const d=await page();const shared=randomUUID()
      await Promise.all([c,d].map(p=>p.evaluate(id=>sessionStorage.setItem('hanshu.editWindow',id),shared)))
      const [left,right]=await Promise.all([open(c),open(d)])
      assert.notEqual(left.id,right.id)
      assert.equal([left,right].filter(result=>result.id===shared).length,1)
      await Promise.all([save(c,`left-${round}`),save(d,`right-${round}`)])
      assert.deepEqual(await load(c),record(`left-${round}`));assert.deepEqual(await load(d),record(`right-${round}`))
      await Promise.all([c.close(),d.close()])
    }
  })
  await test('pagehide/pageshow恢复会重新claim，存在新活owner时旧句柄不能写',async()=>{
    const sleeping=await page();const original=await open(sleeping);await save(sleeping,'sleeping pending')
    await sleeping.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})))
    const replacement=await page()
    await replacement.evaluate(id=>sessionStorage.setItem('hanshu.editWindow',id),original.id)
    assert.equal((await open(replacement)).id,original.id)
    await save(replacement,'replacement pending')
    await sleeping.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})))
    const result=await sleeping.evaluate(async records=>{try{await window.journal.save(records);return 'unexpected success'}catch(error){return String(error)}},record('stale overwrite'))
    assert.match(result,/占用|写权已变化/)
    assert.deepEqual(await load(replacement),record('replacement pending'))
    await sleeping.close();await replacement.close()
  })
  await test('IDB写入时校验owner，迟到页面无法覆盖另一instance已接管的记录',async()=>{
    const stale=await page();const original=await open(stale);await save(stale,'protected pending')
    await b.evaluate(async id=>{
      const connection=await new Promise((resolve,reject)=>{const r=indexedDB.open('hanshu.editJournal.v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
      await new Promise((resolve,reject)=>{const tx=connection.transaction('windows','readwrite');tx.objectStore('windows').put('replacement-instance',id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})
      connection.close()
    },original.id)
    const result=await stale.evaluate(async records=>{try{await window.journal.save(records);return 'unexpected success'}catch(error){return String(error)}},record('stale overwrite'))
    assert.match(result,/写权已变化/)
    const protectedRecords=await b.evaluate(async id=>{
      const connection=await new Promise((resolve,reject)=>{const r=indexedDB.open('hanshu.editJournal.v1',2);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
      const records=await new Promise((resolve,reject)=>{const r=connection.transaction('submissions').objectStore('submissions').get(`project:subject:${id}`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
      connection.close();return records
    },original.id)
    assert.deepEqual(protectedRecords,record('protected pending'))
    const reconnected=await open(stale)
    assert.equal(reconnected.id,original.id,'An invalidated cached owner must be claimable again on reconnect')
    assert.deepEqual(reconnected.records,record('protected pending'))
    await save(stale,'reconnected pending')
    assert.deepEqual(await load(stale),record('reconnected pending'))
    await stale.close()
  })
  assert.deepEqual(errors,[])
  console.log(`真实多页面提交日志验证完成：${checks} 项，所有页面共享同一 browser context。`)
}finally{
  await context.close();await browser.close();await new Promise(resolve=>server.close(resolve))
}
