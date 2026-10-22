import {testAccount} from './test-accounts.mjs'
import {submission,closeCollaboration,loginProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'
import { chromium } from 'playwright'

// This verifies real TCP through a non-loopback interface, not a second physical
// computer. It deliberately never discovers neighbours or changes firewall rules.
const interfaces=Object.entries(networkInterfaces()).flatMap(([name,entries])=>
  (entries??[]).filter(e=>e.family==='IPv4'&&!e.internal).map(e=>({name,address:e.address})))
const lan=process.env.HANSHU_TEST_HOST
  ?interfaces.find(e=>e.address===process.env.HANSHU_TEST_HOST)
  :interfaces.find(e=>!/vEthernet|virtual|docker|wsl|loopback|vpn|tun/i.test(e.name))??interfaces[0]
assert.ok(lan,'No non-loopback IPv4 interface; set HANSHU_TEST_HOST to an existing local interface')
const results=[]
let upstream,offline=false,delayMs=0,dropCommitResponse=false
const sockets=new Set(),observed=[]
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const proxy=createServer(async(req,res)=>{
  if(offline){req.socket.destroy();return}
  if(delayMs)await sleep(delayMs)
  const chunks=[];for await(const c of req)chunks.push(c)
  const body=Buffer.concat(chunks)
  if(req.url==='/api/files/commit')observed.push(JSON.parse(body.toString()))
  const target=new URL(req.url,upstream)
  const outgoing=httpRequest(target,{method:req.method,headers:{...req.headers,host:target.host}},async response=>{
    const responseChunks=[];for await(const c of response)responseChunks.push(c)
    const responseBody=Buffer.concat(responseChunks)
    if(req.url==='/api/files/commit'&&dropCommitResponse){
      dropCommitResponse=false
      assert.equal(JSON.parse(responseBody).status,'committed','Fault must happen after an applied commit')
      // Flush a partial response before breaking TCP. Chromium can transparently
      // retry a connection closed before any headers; partial body loss exercises
      // the application's uncertain-result path deterministically instead.
      res.writeHead(response.statusCode,{'Content-Type':'application/json','Content-Length':responseBody.length})
      res.write(responseBody.subarray(0,Math.max(1,Math.floor(responseBody.length/2))))
      setTimeout(()=>res.destroy(),20);return
    }
    res.writeHead(response.statusCode,response.headers);res.end(responseBody)
  })
  outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end(JSON.stringify({code:'unavailable',message:'Injected network outage'}))})
  outgoing.end(body)
})
proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
proxy.on('upgrade',(req,socket,head)=>{
  if(offline){socket.destroy();return}
  const target=new URL(upstream)
  const remote=connect(Number(target.port),target.hostname,()=>{
    remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
    for(const [key,value]of Object.entries(req.headers))remote.write(`${key}: ${key==='host'?target.host:value}\r\n`)
    remote.write('\r\n');if(head.length)remote.write(head)
    socket.pipe(remote);remote.pipe(socket)
  })
  remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy())
})
await new Promise((r,j)=>{proxy.once('error',j);proxy.listen(0,lan.address,r)})
const base=`http://${lan.address}:${proxy.address().port}`
const h=await harness({web:true,origins:[base]});upstream=h.base
const localTokens=new Set()
async function api(token,path,method='GET',body,status=200){
  if(localTokens.has(token))return h.api(token,path,method,body,status)
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base,...token?{Authorization:`Bearer ${token}`}:{}} ,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
  const value=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(value)}`);return value
}
async function login(credential,name){const account=testAccount(credential);if(account.local){const value=await h.login(credential,name);localTokens.add(value.token);return value}return api('','/api/sessions','POST',{username:account.username,password:account.password,clientName:name})}
async function prepare(token,edits){
  const tree=await api(token,'/api/files')
  const plan=await api(token,'/api/files/plan','POST',{operations:edits.map(e=>({op:e.op??'write',path:e.path,destination:e.destination??null}))})
  const leases=await api(token,'/api/files/leases','POST',{paths:plan.leasePaths})
  return {transactionId:randomUUID(),changes:edits.map(e=>({op:e.op??'write',path:e.path,version:tree.entries.find(f=>f.path===e.path)?.version??null,content:e.content===undefined?null:Buffer.from(e.content).toString('base64'),destination:e.destination??null,destinationVersion:tree.entries.find(f=>f.path===e.destination)?.version??null,leaseId:leases.find(l=>l.resourceId===`file:${e.path}`).id,...e.version!==undefined?{version:e.version}:{}}))}
}
const submit=(token,request)=>api(token,'/api/files/commit','POST',request)
const receipt=(token,id,status=200)=>api(token,`/api/files/transactions/${id}`,'GET',undefined,status)
function passed(name){results.push({name,status:'passed'});console.log(`通过：${name}`)}
async function until(fn,label,timeout=20000){const deadline=Date.now()+timeout;while(!await fn()){assert.ok(Date.now()<deadline,label);await sleep(100)}}
async function browserLogin(page,key,name,navigate=true){
  return loginProject(page,base,key,name,navigate)
}
async function openProgress(page,name='example.progress'){ await closeCollaboration(page);
  await page.getByRole('tab',{name:'进度流程',exact:true}).click()
  await page.getByLabel('筛选资源',{exact:true}).fill(name)
  await page.locator(`[role=treeitem][title="${name}"]`).click()
  await page.getByLabel('进度标题',{exact:true}).waitFor()
}
async function beginEditing(page){await until(()=>page.getByLabel('进度标题',{exact:true}).isEnabled(),'Progress form must be editable without manually acquiring a lease');assert.equal(await page.locator('.app-workspace-pane.active').getByRole('button',{name:'开始编辑',exact:true}).count(),0)}
async function settled(page){await until(async()=>await (await submission(page)).getByRole('status').innerText()==='修改已保存','Client did not acknowledge operation'); await closeCollaboration(page)}
let browser,acceptRemoval=false,browserContexts=0
const pages=[],pageErrors=[]
let apiTokens=[]
const heartbeat=setInterval(()=>{for(const token of apiTokens)void api(token,'/api/heartbeat','POST',{resourceId:null,fileLeases:[]}).catch(()=>undefined)},8000)
try{
  assert.equal((await api('','/health')).protocol,11)
  let owner=await login(h.credential,'LAN owner')
  const author=await api(owner.token,'/api/subjects','POST',{name:'LAN editor',kind:'account',role:'editor'})
  const spectator=await api(owner.token,'/api/subjects','POST',{name:'LAN viewer',kind:'agent',role:'viewer'})
  let a=await login(author.credential,'LAN A'),b=await login(author.credential,'LAN B')
  const viewer=await login(spectator.credential,'LAN read-only')
  apiTokens=[owner.token,a.token,b.token,viewer.token]
  await receipt(a.token,randomUUID(),404)

  const write=await prepare(a.token,[{path:'meta/docs/network.md',content:'Response was lost after this write.'}])
  dropCommitResponse=true
  await assert.rejects(submit(a.token,write))
  const confirmed=await receipt(a.token,write.transactionId)
  assert.equal(confirmed.status,'committed')
  assert.equal(await readFile(join(h.root,'meta/docs/network.md'),'utf8'),'Response was lost after this write.')
  assert.deepEqual(await receipt(b.token,write.transactionId),confirmed,'Same subject in another session may reconcile its transaction')
  await receipt(viewer.token,write.transactionId,403);await receipt(owner.token,write.transactionId,403)
  await api(owner.token,'/api/files/commit','POST',write,403)
  await api(a.token,'/api/files/commit','POST',{...write,changes:write.changes.map(c=>({...c,content:Buffer.from('different').toString('base64')}))},409)
  const revisionBefore=(await api(a.token,'/api/files')).revision
  assert.deepEqual(await submit(b.token,{...write,changes:write.changes.map(c=>({...c,leaseId:'expired-lease-is-not-replayed'}))}),confirmed)
  assert.equal((await api(a.token,'/api/files')).revision,revisionBefore)
  passed('丢失成功回复后可查回结果；同主体跨会话可查，其他主体（含 owner）不可查；重复提交不再落盘')

  await h.release(a.token)
  const move=await prepare(a.token,[{op:'move',path:'meta/docs/network.md',destination:'meta/docs/network-renamed.md'}])
  dropCommitResponse=true;await assert.rejects(submit(a.token,move))
  const moved=await receipt(a.token,move.transactionId)
  assert.equal(moved.status,'committed');assert.deepEqual(await submit(a.token,move),moved)
  assert.equal(await readFile(join(h.root,'meta/docs/network-renamed.md'),'utf8'),'Response was lost after this write.')
  const remove=await prepare(a.token,[{op:'remove',path:'meta/docs/network-renamed.md'}])
  dropCommitResponse=true;await assert.rejects(submit(a.token,remove))
  const removed=await receipt(a.token,remove.transactionId)
  assert.equal(removed.status,'committed');assert.deepEqual(await submit(a.token,remove),removed)
  assert.ok(!(await api(a.token,'/api/files')).entries.some(e=>e.path==='meta/docs/network-renamed.md'))
  passed('移动与删除在回复丢失后重复请求只执行一次')

  await h.release(a.token)
  const stale=await prepare(a.token,[{path:'meta/docs/notes.md',content:'local stale draft'}])
  await h.release(a.token)
  const peer=await prepare(b.token,[{path:'meta/docs/notes.md',content:'peer version'}]);assert.equal((await submit(b.token,peer)).status,'committed')
  await api(a.token,'/api/files/leases','POST',{paths:['meta/docs/notes.md']},423)
  const independent=await prepare(a.token,[{path:'meta/docs/independent.md',content:'different resource'}]);assert.equal((await submit(a.token,independent)).status,'committed')
  await api(owner.token,'/api/files/leases','POST',{paths:['meta/docs/notes.md'],force:true})
  const revoked=await submit(b.token,{...peer,transactionId:randomUUID()})
  assert.equal(revoked.status,'rejected');assert.equal(revoked.error.code,'locked')
  await h.release(owner.token)
  const refreshed=await prepare(a.token,[{path:'meta/docs/notes.md',content:'local stale draft'}])
  stale.changes[0].leaseId=refreshed.changes[0].leaseId
  const rejected=await submit(a.token,stale)
  assert.equal(rejected.status,'rejected');assert.equal(rejected.error.code,'conflict')
  assert.deepEqual(await receipt(a.token,stale.transactionId),rejected)
  assert.deepEqual(await submit(a.token,stale),rejected)
  assert.equal((await submit(a.token,refreshed)).status,'committed')
  passed('独立文件并行提交、同文件租约冲突、owner 接管、过期版本拒绝与新事务重试')

  const atomic=await prepare(a.token,[{path:'meta/docs/atomic-one.md',content:'must not persist'},{path:'meta/docs/notes.md',content:'must not replace',version:'stale-version'}])
  const rejectedBatch=await submit(a.token,atomic)
  assert.equal(rejectedBatch.status,'rejected');assert.equal(rejectedBatch.error.code,'conflict')
  assert.ok(!(await api(a.token,'/api/files')).entries.some(e=>e.path==='meta/docs/atomic-one.md'))
  assert.equal(await readFile(join(h.root,'meta/docs/notes.md'),'utf8'),'local stale draft')
  passed('多文件事务有一处冲突时全部不落盘')

  const checked=await prepare(a.token,[{op:'check',path:'meta/docs/notes.md'},{path:'meta/docs/checked.md',content:'checked together'}])
  const staleCheck={...checked,transactionId:randomUUID(),changes:checked.changes.map((c,i)=>i===0?{...c,version:'stale-check'}:c)}
  const failedCheck=await submit(a.token,staleCheck)
  assert.equal(failedCheck.status,'rejected');assert.equal(failedCheck.error.code,'conflict')
  assert.ok(!(await api(a.token,'/api/files')).entries.some(e=>e.path==='meta/docs/checked.md'))
  assert.equal((await submit(a.token,checked)).status,'committed')
  assert.equal(await readFile(join(h.root,'meta/docs/notes.md'),'utf8'),'local stale draft')
  assert.equal(await readFile(join(h.root,'meta/docs/checked.md'),'utf8'),'checked together')
  passed('采用服务器版本的 check 与本地写入在同一事务中原子校验')

  delayMs=200
  const start=Date.now();await api(a.token,'/api/files');assert.ok(Date.now()-start>=180)
  delayMs=0;offline=true
  await assert.rejects(api(a.token,'/api/files'))
  offline=false;assert.ok((await api(a.token,'/api/files')).entries.length)
  const oldPort=Number(new URL(h.base).port);await h.stop();await h.start(oldPort);upstream=h.base
  await api(a.token,'/api/files','GET',undefined,401)
  a=await login(author.credential,'LAN A after restart');b=await login(author.credential,'LAN B after restart');owner=await login(h.credential,'LAN owner after restart')
  apiTokens=[owner.token,a.token,b.token]
  assert.deepEqual(await receipt(a.token,write.transactionId),confirmed)
  assert.deepEqual(await receipt(b.token,move.transactionId),moved)
  assert.deepEqual(await receipt(a.token,remove.transactionId),removed)
  assert.deepEqual(await receipt(a.token,stale.transactionId),rejected)
  assert.deepEqual(await submit(a.token,move),moved)
  assert.equal((await api(owner.token,'/api/project')).leases.length,0)
  passed('真实非回环 HTTP 延迟、断线恢复与 S 重启后持久回执（包含成功和拒绝）')

  if(!process.argv.includes('--api-only')){
  browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
  for(let i=0;i<2;i++){
    const context=await browser.newContext({viewport:{width:1500,height:1050}})
    browserContexts++
    const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',d=>acceptRemoval&&d.type()==='confirm'?d.accept():d.dismiss());pages.push(page)
  }
  const [pageA,pageB]=pages
  await Promise.all([browserLogin(pageA,author.credential,'LAN browser A'),browserLogin(pageB,author.credential,'LAN browser B')])
  await Promise.all(pages.map(page=>openProgress(page)))
  assert.equal(await pageA.evaluate(()=>window.isSecureContext),false,'This must exercise ordinary LAN HTTP without a secure-origin override')
  await until(async()=>await pageA.getByLabel('进度标题',{exact:true}).inputValue()==='共同进度','Initial progress locale missing')
  await beginEditing(pageA);await beginEditing(pageB)
  const priorRequests=observed.length
  delayMs=120;dropCommitResponse=true
  await pageA.getByLabel('进度标题',{exact:true}).fill('LAN 回复丢失后的标题')
  await (await submission(pageA)).getByText('结果待确认',{exact:true}).waitFor()
  const uncertainRequest=observed[priorRequests]
  assert.ok(uncertainRequest?.transactionId)
  assert.equal(uncertainRequest.changes[0].op,'progress-command')
  await until(async()=>await pageB.getByLabel('进度标题',{exact:true}).inputValue()==='LAN 回复丢失后的标题','Peer failed to synchronize committed unknown outcome')
  // A newer operation must survive confirming an older receipt after reload.
  await pageB.getByRole('button',{name:'完成任一',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='any','Peer could not continue during unknown outcome')
  await settled(pageB)
  await pageA.reload();await browserLogin(pageA,author.credential,'LAN A restored outbox',false);await openProgress(pageA)
  await (await submission(pageA)).getByText('结果待确认',{exact:true}).waitFor()
  await (await submission(pageA)).getByRole('button',{name:'查询提交结果',exact:true}).click()
  await settled(pageA)
  assert.equal(observed.filter(r=>r.transactionId===uncertainRequest.transactionId).length,1,'Confirmed transaction was sent again')
  await until(async()=>await pageA.getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed')==='true','Historical receipt overwrote newer peer state')
  assert.equal(JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion,'any')
  delayMs=0
  assert.ok(!(await api(owner.token,'/api/project')).leases.some(l=>l.resourceId.endsWith('.progress')))
  passed('普通 LAN HTTP 自动提交丢失成功回复后刷新恢复 outbox，按原事务确认且不重复写入，并保留他端之后的修改')
  // Exercise UUID generation and SHA-256 from an insecure LAN origin, including
  // newly-created source documents and a real binary skin resource.
  await pageA.getByLabel('筛选资源',{exact:true}).fill('')
  for(const item of [{category:'进度',command:'新建进度',input:'新进度名称',name:'lan-created',path:'src/progress/lan-created.progress'},{category:'故事流程',command:'新建流程',input:'新流程名称',name:'lan-flow',path:'src/story/lan-flow.hflow'}]){
    await pageA.locator(`[role=treeitem][title="${item.category}"]`).click({button:'right'})
    await pageA.getByRole('menuitem',{name:item.command,exact:true}).click()
    await pageA.getByLabel(item.input,{exact:true}).fill(item.name)
    await pageA.getByLabel(item.input,{exact:true}).press('Enter')
    if(item.path.endsWith('.progress'))await beginEditing(pageA)
    await pageA.keyboard.press('Control+s')
    await until(async()=>(await api(a.token,'/api/files')).entries.some(e=>e.path===item.path),`LAN creation failed: ${item.path}`)
    await until(async()=>await (await submission(pageA)).getByRole('status').innerText()==='修改已保存',`Client did not finish acknowledging creation: ${item.path}`)
  }
  acceptRemoval=true;dropCommitResponse=true
  const beforeRemove=observed.length
  await pageA.locator('[role=treeitem][title="lan-flow.hflow"]').click({button:'right'})
  await pageA.getByRole('menuitem',{name:'移除流程…',exact:true}).click()
  await (await submission(pageA)).getByText('结果待确认',{exact:true}).waitFor()
  acceptRemoval=false
  const removeRequest=observed[beforeRemove]
  assert.ok(removeRequest.changes.some(c=>c.op==='remove'&&c.path==='src/story/lan-flow.hflow'))
  await pageA.reload();await browserLogin(pageA,author.credential,'LAN A restored removal',false)
  await (await submission(pageA)).getByText('结果待确认',{exact:true}).waitFor()
  await (await submission(pageA)).getByRole('button',{name:'查询提交结果',exact:true}).click()
  await until(async()=>await (await submission(pageA)).getByRole('status').innerText()==='修改已保存','Restored deletion was not confirmed')
  assert.equal(observed.filter(r=>r.transactionId===removeRequest.transactionId).length,1)
  assert.ok(!(await api(a.token,'/api/files')).entries.some(e=>e.path==='src/story/lan-flow.hflow'))
  passed('删除回复丢失后刷新页面，从持久 outbox 确认同一事务，未重复执行删除')
  await pageA.getByRole('tab',{name:'皮肤管理器',exact:true}).click()
  await pageA.getByText('皮肤库为空。右键空白处可新建文件夹或导入皮肤。',{exact:true}).click({button:'right'})
  await pageA.getByRole('menuitem',{name:'导入到这里',exact:true}).click()
  const importDialog=pageA.getByRole('dialog',{name:'导入皮肤',exact:true})
  const png=await pageA.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.fillStyle='#28618b';context.fillRect(0,0,64,64);return canvas.toDataURL('image/png').split(',')[1]})
  const chooserPromise=pageA.waitForEvent('filechooser')
  await importDialog.getByRole('button',{name:'添加文件…',exact:true}).click()
  await (await chooserPromise).setFiles({name:'lan-skin.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
  await importDialog.getByRole('button',{name:'导入选中的 1 项',exact:true}).waitFor()
  await importDialog.getByRole('button',{name:'导入选中的 1 项',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'.hanshu/skinmanager/library.json'),'utf8')).entries.length===1,'LAN binary skin import failed')
  const skinTree=await api(a.token,'/api/files')
  assert.ok(skinTree.entries.some(e=>e.kind==='file'&&e.path.startsWith('.hanshu/skinmanager/objects/')))
  assert.deepEqual(pageErrors,[])
  passed('普通 LAN HTTP 下新建进度、流程和导入二进制皮肤（安全 UUID 与哈希回退）')

  // Unlike isolated contexts above, these pages deliberately share localStorage
  // and IndexedDB. Draft bytes and journal ownership must still be per tab.
  const sharedSource='src/progress/shared-tabs.progress',sharedLang='assets/zh_cn/lang_progress/shared-tabs.lang'
  const sharedDoc=JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8'));sharedDoc.completion='all';sharedDoc.id='same-context-tabs'
  const sharedSeed=await prepare(owner.token,[{path:sharedSource,content:JSON.stringify(sharedDoc)},{path:sharedLang,content:JSON.stringify({name:'共享浏览器里的服务器标题',description:''})}])
  assert.equal((await submit(owner.token,sharedSeed)).status,'committed');await h.release(owner.token)
  const sharedContext=await browser.newContext({viewport:{width:1500,height:1050}});browserContexts++
  const tabA=await sharedContext.newPage(),tabB=await sharedContext.newPage()
  for(const page of [tabA,tabB]){pages.push(page);page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',d=>d.dismiss())}
  await browserLogin(tabA,author.credential,'same-context tab A');await openProgress(tabA,'shared-tabs.progress')
  await until(async()=>await tabA.getByLabel('进度标题',{exact:true}).inputValue()==='共享浏览器里的服务器标题','Shared-context initial title missing')
  await browserLogin(tabB,author.credential,'same-context tab B');await openProgress(tabB,'shared-tabs.progress')
  await beginEditing(tabA);await beginEditing(tabB)
  await tabA.getByLabel('进度标题',{exact:true}).dispatchEvent('compositionstart',{data:''})
  await tabA.getByLabel('进度标题',{exact:true}).fill('只有 A 尚在输入的标题')
  await sleep(800)
  assert.equal(await tabB.getByLabel('进度标题',{exact:true}).inputValue(),'共享浏览器里的服务器标题','B read another tab’s unfinished language draft')
  const beforeTabB=observed.length
  await tabB.getByRole('button',{name:'完成任一',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,sharedSource),'utf8')).completion==='any','B source operation did not complete')
  await settled(tabB)
  assert.equal(JSON.parse(await readFile(join(h.root,sharedLang),'utf8')).name,'共享浏览器里的服务器标题','B accidentally submitted A draft')
  assert.ok(observed.slice(beforeTabB).every(r=>r.changes.every(c=>c.op!=='progress-command'||!JSON.parse(Buffer.from(c.content,'base64').toString()).changes.some(e=>e.target.kind==='locale'))),'B source operation contained another tab language effects')
  assert.equal(await tabA.getByLabel('进度标题',{exact:true}).inputValue(),'只有 A 尚在输入的标题','Peer source update overwrote A draft')
  await tabA.getByLabel('进度标题',{exact:true}).dispatchEvent('compositionend',{data:'只有 A 尚在输入的标题'})
  await until(async()=>JSON.parse(await readFile(join(h.root,sharedLang),'utf8')).name==='只有 A 尚在输入的标题','A did not autosubmit its isolated draft')
  await settled(tabA)
  assert.equal(JSON.parse(await readFile(join(h.root,sharedSource),'utf8')).completion,'any')
  assert.ok(!(await api(a.token,'/api/project')).leases.some(l=>l.resourceId===`file:${sharedSource}`||l.resourceId===`file:${sharedLang}`))
  passed('同一浏览器上下文双标签共享 IndexedDB 时，组合输入草稿隔离，双方独立字段自动提交且不串写')
  if(!process.argv.includes('--skip-duplicate-tab')){
  await beginEditing(tabA)
  const beforeDuplicate=observed.length;dropCommitResponse=true
  await tabA.getByLabel('进度标题',{exact:true}).fill('仅原标签页持有的待确认提交')
  await (await submission(tabA)).getByText('结果待确认',{exact:true}).waitFor()
  const originalRequest=observed[beforeDuplicate]
  const originalWindowId=await tabA.evaluate(()=>sessionStorage.getItem('hanshu.editWindow'))
  const popupPromise=sharedContext.waitForEvent('page')
  await tabA.evaluate(url=>window.open(url,'_blank'),base)
  const duplicateTab=await popupPromise;pages.push(duplicateTab);duplicateTab.on('pageerror',e=>pageErrors.push(e.message));duplicateTab.on('dialog',d=>d.dismiss())
  await browserLogin(duplicateTab,author.credential,'duplicate tab',false)
  assert.notEqual(await duplicateTab.evaluate(()=>sessionStorage.getItem('hanshu.editWindow')),originalWindowId,'window.open copied the original outbox owner ID')
  assert.ok(!(await (await submission(duplicateTab)).innerText()).includes('结果待确认'),'Duplicate tab restored the original tab’s pending outbox')
  await tabA.reload();await browserLogin(tabA,author.credential,'original tab reloaded',false)
  await (await submission(tabA)).getByText('结果待确认',{exact:true}).waitFor()
  await (await submission(tabA)).getByRole('button',{name:'查询提交结果',exact:true}).click()
  await until(async()=>await (await submission(tabA)).getByRole('status').innerText()==='修改已保存','Original tab lost its outbox after another tab was cloned')
  assert.equal(observed.filter(r=>r.transactionId===originalRequest.transactionId).length,1)
  assert.deepEqual(pageErrors,[])
  passed('真实 window.open 复制 sessionStorage 后分离 outbox 所有权，原标签刷新仍可恢复并确认自己的提交')
  }
  }

  const output=resolve('../output/collaboration-network');await mkdir(output,{recursive:true})
  for(const [i,page]of pages.entries())await page.screenshot({path:join(output,`lan-client-${i}.png`)})
  await writeFile(join(output,'acceptance.json'),JSON.stringify({date:new Date().toISOString(),transport:'TCP IPv4 HTTP/WebSocket',interface:lan.name,address:lan.address,physicalDevices:1,browserContexts,browserPages:pages.length,secondPhysicalDeviceTested:false,scope:'Same host through real non-loopback interface; no firewall or neighbour probing',proxyFaults:['200ms latency','disconnect','successful commit response loss'],results,commitRequestsObserved:observed.length},null,2))
  console.log(`网络验收通过：${lan.name} ${lan.address}；同机非回环接口，不代表两台物理设备验收。`)
}catch(error){
  console.error('Recent commits:',observed.slice(-5).map(r=>({transactionId:r.transactionId,changes:r.changes.map(c=>({op:c.op,path:c.path}))})))
  const output=resolve('../output/collaboration-network');await mkdir(output,{recursive:true})
  for(const [i,page]of pages.entries()){
    console.error(`LAN CLIENT ${i}:`,(await page.locator('body').innerText().catch(()=>'' )).slice(0,3000))
    await page.screenshot({path:join(output,`failed-client-${i}.png`)}).catch(()=>undefined)
  }
  throw error
}finally{
  clearInterval(heartbeat);if(browser)await browser.close();await h.stop();for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r))
}
