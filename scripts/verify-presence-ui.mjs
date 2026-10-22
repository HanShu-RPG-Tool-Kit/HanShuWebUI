import {projectMenu,waitProject,collaboration,closeCollaboration} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { networkInterfaces } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness, progress } from './collaboration-harness.mjs'

// Real HTTP/WebSocket over this machine's LAN interface. No secure-context
// override, second device, firewall change, or network discovery is involved.
const interfaces=Object.entries(networkInterfaces()).flatMap(([name,entries])=>(entries??[]).filter(e=>e.family==='IPv4'&&!e.internal).map(e=>({name,address:e.address})))
const lan=process.env.HANSHU_TEST_HOST?interfaces.find(e=>e.address===process.env.HANSHU_TEST_HOST):interfaces.find(e=>!/vEthernet|virtual|docker|wsl|loopback|vpn|tun/i.test(e.name))??interfaces[0]
assert.ok(lan,'An existing non-loopback IPv4 address is required')
const h=await harness({web:true,host:lan.address})
const output=resolve('../output/collaboration-presence')
const results=[],pages=[],errors=[],commits=[]
let browser,setupToken=''
const heartbeat=setInterval(()=>{if(setupToken)void h.api(setupToken,'/api/heartbeat','POST',{resourceId:null,fileLeases:[]}).catch(()=>undefined)},8000)
const source='src/progress/example.progress',secondSource='src/progress/second.progress'
const language='assets/zh_cn/lang_progress/example.lang'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn,label,timeout=20000){const deadline=Date.now()+timeout;while(!await fn()){assert.ok(Date.now()<deadline,label);await sleep(100)}}
function passed(name){results.push({name,status:'passed'});console.log(`通过：${name}`)}
const bar=page=>page.getByRole('region',{name:'协作面板',exact:true})
const title=page=>page.getByLabel('进度标题',{exact:true})
async function login(page,key,name){
  await page.addInitScript(value=>sessionStorage.setItem('hanshu.windowName',value),name)
  await page.goto(h.base)
  await projectMenu(page,'连接其他服务器…')
  const form=page.getByRole('form',{name:'连接其他服务器',exact:true})
  await form.getByLabel('服务地址',{exact:true}).fill(h.base)
  await form.getByLabel('主体凭证',{exact:true}).fill(key)

  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions'&&r.request().method()==='POST')
  await form.getByRole('button',{name:'连接并打开工程',exact:true}).click()
  const {token}=await (await response).json()
  await waitProject(page,'统一工程验收')
  const snapshot=await h.api(token,'/api/project')
  return {token,id:snapshot.session.id}
}
async function openProgress(page,name='example.progress'){
  await page.getByRole('tab',{name:'进度流程',exact:true}).click()
  await page.getByLabel('筛选资源',{exact:true}).fill(name)
  await page.locator(`[role=treeitem][title="${name}"]`).click()
  await title(page).waitFor()
  await closeCollaboration(page)
  await until(()=>title(page).isEnabled(),'Progress snapshot did not finish loading')
}
async function capsule(page,client,activity){
  await collaboration(page);await until(async()=>await bar(page).locator(`[aria-label*="${client}"][aria-label*="${activity}"]`).count()>0,`Missing accessible ${activity} capsule for ${client}`)
}
async function state(){return h.api(setupToken,'/api/project')}
async function presence(session,path,activity){await until(async()=>{const p=(await state()).sessions.find(s=>s.id===session.id)?.filePresence;return path===null?p===null:p?.path===path&&(!activity||p.activity===activity)},`Wrong presence for ${session.id}: ${path} ${activity??''}`)}
async function save(page,name){await title(page).fill(name);await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name===name,`Title not saved: ${name}`)}

try{
  await mkdir(output,{recursive:true})
  await writeFile(join(h.root,secondSource),JSON.stringify({...progress,id:'second-progress'}))
  await writeFile(join(h.root,'assets/zh_cn/lang_progress/second.lang'),JSON.stringify({name:'第二个进度',description:'用于切换编辑会话'}))
  const setup=await h.login(h.credential,'验收 API')
  setupToken=setup.token
  const author=await h.api(setupToken,'/api/subjects','POST',{name:'创作者',kind:'account',role:'editor'})
  browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
  // A/B deliberately share one browser context as well as one subject.
  const shared=await browser.newContext({viewport:{width:1500,height:1050}})
  const ownerContext=await browser.newContext({viewport:{width:1500,height:1050}})
  await shared.addInitScript(()=>{const actual=Date.now.bind(Date);Date.now=()=>actual()+6*60*60*1000})
  await ownerContext.addInitScript(()=>{const actual=Date.now.bind(Date);Date.now=()=>actual()-4*60*60*1000})
  const a=await shared.newPage(),b=await shared.newPage(),owner=await ownerContext.newPage()
  pages.push(a,b,owner)
  for(const page of pages){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());page.on('request',r=>{if(new URL(r.url()).pathname==='/api/files/commit')commits.push({page:pages.indexOf(page),body:r.postDataJSON()})})}
  const [sa,sb,so]=await Promise.all([login(a,author.credential,'窗口 A'),login(b,author.credential,'窗口 B'),login(owner,h.credential,'管理窗口')])
  await Promise.all(pages.map(page=>openProgress(page)))
  assert.equal(await a.evaluate(()=>window.isSecureContext),false,'This must be ordinary insecure LAN HTTP')
  await Promise.all([presence(sa,source,'viewing'),presence(sb,source,'viewing'),presence(so,source,'viewing')])
  for(const page of pages){await collaboration(page);await until(()=>title(page).isEnabled(),'Progress snapshot did not finish loading');await capsule(page,'窗口 A','查看中');await capsule(page,'窗口 B','查看中');await capsule(page,'管理窗口','查看中')}
  assert.equal((await state()).leases.length,0,'Viewing a progress document acquired a write lease')
  assert.ok(await bar(a).locator('[aria-label*="窗口 A"][aria-label*="自己"]').count(),'Current session needs an accessible self marker')
  passed('两个主体三个会话可见，同主体的两个标签分别显示；查看不占写权，写者可直接操作表单')

  const extra=[]
  for(let i=1;i<=4;i++){const session=await h.login(author.credential,`附加查看窗口 ${i}`);extra.push(session);await h.api(session.token,'/api/presence','POST',{path:source})}
  await collaboration(a)
  await until(async()=>await bar(a).locator('.collab-session').count()===8,'All windows must be listed')
  assert.equal(await bar(a).locator('.collab-members article').count(),2,'Windows of one identity should be grouped')
  await a.screenshot({path:join(output,'floating-many-windows.png')})
  for(const session of extra)await h.api(session.token,'/api/sessions/current','DELETE')
  await until(async()=>await bar(a).locator('.collab-session').count()===4,'Departed viewers remained')
  passed('悬浮窗按主体分组多个窗口，完整列出焦点并及时移除离开的窗口')

  // Hold an IME composition long enough to observe editing intent without
  // submitting half-composed text or retaining a source lease.
  await title(a).dispatchEvent('compositionstart',{data:''})
  await title(a).fill('会话 A 的首次自动保存')
  await presence(sa,source,'editing');await capsule(b,'窗口 A','编辑中')
  assert.ok(await title(b).isEnabled(),'Another editing intent disabled the form')
  assert.equal((await state()).leases.length,0)
  await title(a).dispatchEvent('compositionend',{data:'会话 A 的首次自动保存'})
  await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name==='会话 A 的首次自动保存','Composition did not autosubmit')
  await until(async()=>await title(b).inputValue()==='会话 A 的首次自动保存','Watching client did not receive title')
  await presence(sa,source,'viewing')
  await a.screenshot({path:join(output,'avatars-wide.png')})
  await a.setViewportSize({width:850,height:950});await a.screenshot({path:join(output,'avatars-narrow.png')})
  const bounds=await bar(a).boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=851,'Collaborator bar overflows its narrow viewport')
  await a.setViewportSize({width:1500,height:1050})
  await closeCollaboration(b);await save(b,'B 可以直接继续编辑')
  await until(async()=>await title(a).inputValue()==='B 可以直接继续编辑','A did not observe B operation')
  passed('输入意图显示编辑胶囊，双方表单保持可用；组合输入结束自动保存，完成后回到查看状态且不占写权')

  // An unrelated operation's lease must survive view and workspace navigation.
  const unrelated=(await h.api(sa.token,'/api/files/leases','POST',{paths:['meta/docs/notes.md']}))[0]
  await openProgress(a,'second.progress');await presence(sa,secondSource,'viewing')
  assert.ok(await title(a).isEnabled())
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id))
  assert.ok(!(await state()).leases.some(l=>l.resourceId.endsWith('.progress')))
  await a.getByRole('tab',{name:'剧本',exact:true}).click();await presence(sa,'src/hanshu/story.hs','viewing')
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id),'Workspace switch released an unrelated lease')
  await openProgress(a);await presence(sa,source,'viewing')
  assert.ok(await title(a).isEnabled())
  await h.api(sa.token,'/api/files/leases','DELETE',{path:'meta/docs/notes.md',leaseId:unrelated.id})
  passed('切换文件与工作区准确更新焦点，不创建长期进度写权，也不释放独立操作持有的租约')

  // Semantic edit rejection retains the draft; retry after the real temporary
  // lease is released needs no manual progress editing session.
  const lock=(await h.api(so.token,'/api/files/leases','POST',{paths:[source]}))[0]
  await title(a).fill('临时写权冲突保留的草稿')
  const active=a.locator('.app-workspace-pane.active')
  await active.getByRole('button',{name:'保留我的修改并重试',exact:true}).waitFor()
  assert.equal(await title(a).inputValue(),'临时写权冲突保留的草稿')
  assert.equal(JSON.parse(await readFile(join(h.root,language),'utf8')).name,'B 可以直接继续编辑')
  assert.ok(await title(a).isEnabled())
  await h.api(so.token,'/api/files/leases','DELETE',{path:source,leaseId:lock.id})
  await active.getByRole('button',{name:'保留我的修改并重试',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name==='临时写权冲突保留的草稿','Retry after short lease release failed')
  await presence(sa,source,'viewing')
  assert.equal((await state()).leases.length,0)
  passed('真实临时写权冲突保留输入；释放后显式重试原字段修改，无需申请长期编辑会话')

  await title(a).dispatchEvent('compositionstart',{data:''});await title(a).fill('降权后保留的草稿')
  await presence(sa,source,'editing')
  await h.api(setupToken,`/api/subjects/${author.subject.id}`,'PATCH',{role:'viewer',enabled:true})
  await until(()=>title(a).isDisabled(),'Role change failed to revoke editing')
  await presence(sa,source,'viewing');assert.ok(await title(b).isDisabled())
  await title(a).dispatchEvent('compositionend',{data:'降权后保留的草稿'})
  assert.equal(await title(a).inputValue(),'降权后保留的草稿')
  await sleep(800)
  assert.equal(JSON.parse(await readFile(join(h.root,language),'utf8')).name,'临时写权冲突保留的草稿')
  assert.equal(await bar(a).getByRole('button',{name:'开始编辑',exact:true}).count(),0)
  passed('主体降权立即将全部会话夹为查看状态并禁止提交，未确认的本地输入仍保留')
  assert.deepEqual(errors,[])
  await writeFile(join(output,'acceptance.json'),JSON.stringify({date:new Date().toISOString(),protocol:10,interface:lan.name,address:lan.address,physicalDevices:1,secondPhysicalDeviceTested:false,browserContexts:2,browserPages:3,browserClockOffsetsHours:[6,-4],results,commitRequestsObserved:commits.length},null,2))
  console.log(`协作编辑体验验收通过：${results.length} 组；${lan.name} ${lan.address}，同机真实 LAN HTTP。`)
}catch(error){
  for(const [i,page]of pages.entries()){console.error(`PRESENCE CLIENT ${i}:`,(await page.locator('body').innerText().catch(()=>'' )).slice(0,4500));await page.screenshot({path:join(output,`failed-client-${i}.png`)}).catch(()=>undefined)}
  throw error
}finally{clearInterval(heartbeat);if(browser)await browser.close();await h.stop()}
