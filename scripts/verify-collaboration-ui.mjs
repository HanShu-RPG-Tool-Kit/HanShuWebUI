import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'

// Cross-workspace C/S acceptance. Detailed progress conflicts/undo/reconnect now
// belong to verify-progress-collaboration-ui.mjs instead of raw-file merge dialogs.
const h=await harness(true), pages=[], errors=[], results=[]
let browser,ownerToken=''
const output=resolve('../output/collaboration-v2')
const heartbeat=setInterval(()=>{if(ownerToken)void h.api(ownerToken,'/api/heartbeat','POST',{resourceId:null,fileLeases:[]}).catch(()=>undefined)},8000)
async function until(fn,label){const deadline=Date.now()+20000;while(!await fn()){assert.ok(Date.now()<deadline,label);await new Promise(r=>setTimeout(r,75))}}
const active=page=>page.locator('.app-workspace-pane.active'),title=page=>active(page).getByLabel('进度标题',{exact:true}),status=page=>page.getByRole('region',{name:'工程提交状态',exact:true})
const passed=name=>{results.push({name,status:'passed'});console.log(`通过：${name}`)}
async function login(page,key,name){
  await page.goto(h.base);await page.getByRole('button',{name:'打开工程…',exact:true}).click()
  const form=page.getByRole('form',{name:'打开工程',exact:true})
  await form.getByLabel('服务地址',{exact:true}).fill(h.base);await form.getByLabel('主体凭证',{exact:true}).fill(key);await form.getByLabel('本端名称',{exact:true}).fill(name)
  await form.getByRole('button',{name:'连接并打开工程',exact:true}).click();await page.locator('.project-service-bar').getByText('统一工程验收',{exact:true}).waitFor()
}
async function progress(page){await page.getByRole('tab',{name:'进度流程',exact:true}).click();await page.getByRole('textbox',{name:'筛选资源',exact:true}).fill('example.progress');await page.locator('[role=treeitem][title="example.progress"]').click();await title(page).waitFor()}
try{
  await mkdir(output,{recursive:true})
  const owner=await h.login(h.credential,'setup');ownerToken=owner.token
  const editor=await h.api(owner.token,'/api/subjects','POST',{name:'创作者',kind:'account',role:'editor'})
  const reader=await h.api(owner.token,'/api/subjects','POST',{name:'只读工具',kind:'agent',role:'viewer'})
  browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
  for(let i=0;i<3;i++){
    const context=await browser.newContext({viewport:{width:1500,height:1050}})
    await context.addInitScript(()=>{window.__directProjectIo=0;Object.defineProperty(window,'showDirectoryPicker',{value:()=>{window.__directProjectIo++;throw new Error('C must not open an OS project directory')}});for(const [type,method]of [['FileSystemFileHandle','createWritable'],['FileSystemDirectoryHandle','removeEntry']])if(window[type])Object.defineProperty(window[type].prototype,method,{value:()=>{window.__directProjectIo++;throw new Error('Direct OS project write')}})})
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());pages.push(page)
  }
  const [a,b,v]=pages
  await Promise.all([login(a,editor.credential,'窗口 A'),login(b,editor.credential,'窗口 B'),login(v,reader.credential,'只读窗口')]);await Promise.all(pages.map(progress))
  await until(async()=>await title(a).inputValue()==='共同进度','Initial locale title missing')
  assert.ok(await title(a).isEnabled());assert.ok(await title(b).isEnabled());assert.ok(await title(v).isDisabled())
  assert.equal(await active(a).getByRole('button',{name:'开始编辑',exact:true}).count(),0)
  const semantic=[];a.on('request',request=>{if(new URL(request.url()).pathname==='/api/files/commit')semantic.push(request.postDataJSON())})
  await title(a).fill('从 A 自动保存的共同标题')
  await until(async()=>JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name==='从 A 自动保存的共同标题','Locale did not autosubmit')
  await until(async()=>await title(b).inputValue()==='从 A 自动保存的共同标题','B did not receive title')
  await active(a).getByRole('button',{name:'完成任一',exact:true}).click()
  await until(async()=>await active(b).getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed')==='true','B did not receive progress operation')
  assert.ok(semantic.length>0&&semantic.every(batch=>batch.changes.length===1&&batch.changes[0].op==='progress-command'))
  await active(b).getByRole('button',{name:'完成全部',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='all','B could not edit without handoff')
  assert.equal((await h.api(ownerToken,'/api/project')).leases.length,0)
  passed('三客户端共享进度：写者直接操作并自动同步、读者只读、语义提交不保留文件写权')

  // Ordinary source editors retain explicit save boundaries and durable retries.
  await a.getByRole('tab',{name:'剧本',exact:true}).click();await active(a).locator('.monaco-editor .view-lines').first().click();await a.keyboard.press('Control+a');await a.keyboard.type('shared script from client A\n')
  const before=await readFile(join(h.root,'src/hanshu/story.hs'),'utf8')
  let reject=true;const batches=[]
  await a.route('**/api/files/commit',async route=>{const body=route.request().postDataJSON();batches.push(body);if(reject){reject=false;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({transactionId:body.transactionId,status:'rejected',tree:null,error:{code:'locked',message:'测试中的临时写权冲突'}})})}else await route.continue()})
  await a.keyboard.press('Control+s');await status(a).getByText('测试中的临时写权冲突',{exact:true}).waitFor()
  assert.equal(await readFile(join(h.root,'src/hanshu/story.hs'),'utf8'),before)
  await status(a).getByRole('button',{name:'重试原提交',exact:true}).click()
  await until(async()=>(await readFile(join(h.root,'src/hanshu/story.hs'),'utf8')).includes('shared script from client A'),'Script retry did not save through S')
  assert.notEqual(batches[0].transactionId,batches[1].transactionId)
  assert.deepEqual(batches[0].changes.map(({leaseId,...change})=>change),batches[1].changes.map(({leaseId,...change})=>change))
  await a.unroute('**/api/files/commit')
  await b.getByRole('tab',{name:'剧本',exact:true}).click()
  await until(async()=>(await active(b).locator('.monaco-editor .view-lines').allTextContents()).join('').replace(/\u00a0/g,' ').includes('shared script from client A'),'B script did not update')
  passed('普通剧本保持保存边界；明确失败保留原提交，重试使用新事务编号并同步他端')

  await Promise.all([a,b].map(page=>page.getByRole('tab',{name:'皮肤管理器',exact:true}).click()))
  await a.getByRole('tree',{name:'文件夹树',exact:true}).click({button:'right'});await a.getByRole('menuitem',{name:'新建文件夹',exact:true}).click()
  const folder=a.getByRole('dialog',{name:'在根目录新建文件夹',exact:true})
  await folder.getByPlaceholder('文件夹名称').fill('共享皮肤分类');await folder.getByRole('button',{name:'创建',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'.hanshu/skinmanager/library.json'),'utf8')).folders.some(f=>f.name==='共享皮肤分类'),'Skin folder did not reach S')
  await until(async()=>(await b.getByRole('tree',{name:'文件夹树',exact:true}).innerText()).includes('共享皮肤分类'),'Peer skin library did not refresh')
  assert.equal((await h.api(owner.token,'/api/project')).sessions.filter(s=>s.subjectId===editor.subject.id).length,2,'Workspace switch opened extra sessions')
  for(const page of pages)assert.equal(await page.evaluate(()=>window.__directProjectIo),0,'C attempted direct OS project I/O')
  assert.deepEqual(errors,[]);await b.screenshot({path:join(output,'unified-project.png')})
  passed('皮肤与进度、剧本共用工程会话；皮肤操作同步，所有客户端直接工程文件系统写入为零')
  await writeFile(join(output,'acceptance.json'),JSON.stringify({date:new Date().toISOString(),protocol:10,browserContexts:3,results,progressDetailSuite:'verify-progress-collaboration-ui.mjs'},null,2))
}catch(error){for(const[i,page]of pages.entries()){console.error(`CLIENT ${i}:`,(await page.locator('body').innerText().catch(()=>'' )).slice(0,3500));await page.screenshot({path:join(output,`failed-client-${i}.png`)}).catch(()=>undefined)}throw error}
finally{clearInterval(heartbeat);if(browser)await browser.close();await h.stop()}
