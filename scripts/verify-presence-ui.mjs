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
const bar=page=>page.getByRole('region',{name:'当前文件协作者',exact:true})
const title=page=>page.getByLabel('进度标题',{exact:true})
async function login(page,key,name){
  await page.goto(h.base)
  await page.getByRole('button',{name:'打开工程…',exact:true}).click()
  const form=page.getByRole('form',{name:'打开工程',exact:true})
  await form.getByLabel('服务地址',{exact:true}).fill(h.base)
  await form.getByLabel('主体凭证',{exact:true}).fill(key)
  await form.getByLabel('本端名称',{exact:true}).fill(name)
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions'&&r.request().method()==='POST')
  await form.getByRole('button',{name:'连接并打开工程',exact:true}).click()
  const {token}=await (await response).json()
  await page.locator('.project-service-bar').getByText('统一工程验收',{exact:true}).waitFor()
  const snapshot=await h.api(token,'/api/project')
  return {token,id:snapshot.session.id}
}
async function openProgress(page,name='example.progress'){
  await page.getByRole('tab',{name:'进度流程',exact:true}).click()
  await page.getByLabel('筛选资源',{exact:true}).fill(name)
  await page.locator(`[role=treeitem][title="${name}"]`).click()
  await title(page).waitFor()
  await bar(page).waitFor()
}
async function start(page){
  const resume=bar(page).getByRole('button',{name:'重新申请写权',exact:true})
  await (await resume.count()?resume:bar(page).getByRole('button',{name:'开始编辑',exact:true})).click()
  await until(()=>title(page).isEnabled(),'Explicit editing did not enable the form')
}
async function end(page){await bar(page).getByRole('button',{name:'结束编辑',exact:true}).click();await until(()=>title(page).isDisabled(),'Ending editing did not make the form read-only')}
async function capsule(page,client,activity){
  await until(async()=>await bar(page).locator(`[aria-label*="${client}"][aria-label*="${activity}"]`).count()>0,`Missing accessible ${activity} capsule for ${client}`)
}
async function state(){return h.api(setupToken,'/api/project')}
async function presence(session,path,activity){await until(async()=>{const p=(await state()).sessions.find(s=>s.id===session.id)?.filePresence;return path===null?p===null:p?.path===path&&(!activity||p.activity===activity)},`Wrong presence for ${session.id}: ${path} ${activity??''}`)}
async function save(page,name){await title(page).fill(name);await page.keyboard.press('Control+s');await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name===name,`Title not saved: ${name}`)}

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
  for(const page of pages){assert.ok(await title(page).isDisabled());await capsule(page,'窗口 A','查看中');await capsule(page,'窗口 B','查看中');await capsule(page,'管理窗口','查看中')}
  assert.equal((await state()).leases.length,0,'Viewing a progress document acquired a write lease')
  assert.ok(await bar(a).locator('[aria-label*="窗口 A"][aria-label*="自己"]').count(),'Current session needs an accessible self marker')
  passed('两个主体三个会话可见，同主体的两个标签分别显示；查看不占写权，表单默认只读')

  const extra=[]
  for(let i=1;i<=4;i++){const session=await h.login(author.credential,`附加查看窗口 ${i}`);extra.push(session);await h.api(session.token,'/api/presence','POST',{path:source})}
  const overflow=bar(a).getByLabel('另外 2 个窗口',{exact:true})
  // Exercise the native details/summary disclosure through its accessible name.
  await overflow.waitFor();await overflow.focus();await a.keyboard.press('Enter')
  assert.equal(await bar(a).locator('.file-presence-overflow').getAttribute('open'),'')
  await a.screenshot({path:join(output,'avatars-overflow.png')})
  const overflowBounds=await bar(a).locator('.file-presence-overflow > div').boundingBox()
  assert.ok(overflowBounds&&overflowBounds.width>=160,'Additional collaborators are squeezed into the width of the count badge')
  await a.keyboard.press('Enter')
  for(const session of extra)await h.api(session.token,'/api/sessions/current','DELETE')
  await until(async()=>await bar(a).locator('.file-presence-person').count()===3,'Departed viewers remained in the collaborator list')
  passed('更多查看者折叠为数量胶囊，可用键盘展开；会话离开后及时移除')

  await start(a)
  await presence(sa,source,'editing')
  await capsule(b,'窗口 A','编辑中')
  assert.ok(await title(b).isDisabled())
  const blocked=bar(b).getByRole('button',{name:'开始编辑',exact:true})
  if(await blocked.count()&&await blocked.isEnabled())await blocked.click()
  assert.ok(await title(b).isDisabled(),'A second editor enabled its form while another session owned the lease')
  await save(a,'会话 A 的首次保存')
  await until(async()=>await title(b).inputValue()==='会话 A 的首次保存','Watching client did not receive the saved title')
  await a.screenshot({path:join(output,'avatars-wide.png')})
  await a.setViewportSize({width:850,height:950})
  await a.screenshot({path:join(output,'avatars-narrow.png')})
  const bounds=await bar(a).boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=851,'Collaborator bar overflows its narrow viewport')
  await a.setViewportSize({width:1500,height:1050})
  await end(a)
  await presence(sa,source,'viewing')
  await start(b);await save(b,'交接到 B 的标题');await end(b)
  passed('显式开始编辑获得写权；其它会话显示持有者并只读；保存同步、结束编辑与交接可用')

  // A separate operation's lease is not owned by the progress viewing lifecycle.
  const unrelated=(await h.api(sa.token,'/api/files/leases','POST',{paths:['meta/docs/notes.md']}))[0]
  await start(a)
  await openProgress(a,'second.progress')
  await presence(sa,secondSource,'viewing')
  assert.ok((await state()).leases.some(l=>l.sessionId===sa.id&&l.resourceId===`file:${source}`),'Switching tabs unexpectedly dropped an explicit editing session')
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id),'File switch released a lease belonging to a separate operation')
  assert.ok(await title(a).isDisabled())
  await start(a)
  await a.getByRole('tab',{name:'剧本',exact:true}).click()
  await presence(sa,null)
  assert.ok((await state()).leases.some(l=>l.sessionId===sa.id&&l.resourceId===`file:${secondSource}`),'Switching workspaces unexpectedly dropped an explicit editing session')
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id),'Workspace switch released a lease belonging to a separate operation')
  await openProgress(a,'second.progress')
  assert.ok(await title(a).isEnabled(),'Returning to an active editing session lost its authority')
  await end(a)
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id),'Ending one document released an unrelated operation lease')
  assert.ok((await state()).leases.some(l=>l.sessionId===sa.id&&l.resourceId===`file:${source}`),'Ending one document released another document editing session')
  await openProgress(a)
  await presence(sa,source,'editing')
  await end(a)
  assert.ok((await state()).leases.some(l=>l.id===unrelated.id),'Ending editing released a lease belonging to a separate operation')
  await h.api(sa.token,'/api/files/leases','DELETE',{path:'meta/docs/notes.md',leaseId:unrelated.id})
  passed('切文件和切工作区准确更新查看状态并保留显式编辑会话；结束编辑仅释放当前文档写权')

  await start(a)
  await title(a).fill('接管时保留的本地草稿')
  await owner.getByRole('region',{name:'当前文件协作者',exact:true}).getByRole('button',{name:'接管编辑',exact:true}).click()
  await owner.getByRole('button',{name:'确认接管',exact:true}).click()
  await until(()=>title(owner).isEnabled(),'Owner takeover did not enable owner form')
  await until(()=>title(a).isDisabled(),'Prior writer stayed editable after takeover')
  await presence(so,source,'editing');await presence(sa,source,'viewing')
  assert.equal(await title(a).inputValue(),'接管时保留的本地草稿')
  const beforeTakeoverSave=commits.length
  await a.keyboard.press('Control+s');await sleep(300)
  assert.equal(commits.length,beforeTakeoverSave,'Revoked editor tried to commit instead of requiring a new editing session')
  assert.equal(await a.getByRole('button',{name:'重试原提交',exact:true}).count(),0,'A denied save created a frozen failed transaction that blocks saving after reacquisition')
  assert.equal(JSON.parse(await readFile(join(h.root,language),'utf8')).name,'交接到 B 的标题')
  await a.screenshot({path:join(output,'takeover-draft.png')})
  await end(owner)
  await start(a)
  assert.equal(await title(a).inputValue(),'接管时保留的本地草稿')
  await a.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name==='接管时保留的本地草稿','Draft could not be saved after explicit reacquisition')
  passed('管理者接管立即禁用旧会话编辑与提交，旧草稿保留，显式重新申请后可以保存')

  await title(a).fill('断线前尚未提交的草稿')
  await shared.setOffline(true)
  await until(()=>title(a).isDisabled(),'Disconnected client stayed editable',25000)
  const beforeOfflineSave=commits.length
  await a.keyboard.press('Control+s');await sleep(300)
  assert.equal(commits.length,beforeOfflineSave,'Disconnected editor attempted a file commit')
  assert.equal(await a.getByRole('button',{name:'重试原提交',exact:true}).count(),0,'An offline shortcut created a failed transaction before editing resumed')
  assert.equal(await title(a).inputValue(),'断线前尚未提交的草稿')
  await shared.setOffline(false)
  await until(async()=>!(await a.locator('.project-service-bar').innerText()).includes('已断开'),'Client did not reconnect')
  assert.ok(await title(a).isDisabled(),'Reconnecting silently restored editing authority')
  await bar(a).getByRole('button',{name:'重新申请写权',exact:true}).waitFor()
  await start(a)
  assert.equal(await title(a).inputValue(),'断线前尚未提交的草稿')
  await a.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,language),'utf8')).name==='断线前尚未提交的草稿','Reconnect lost the local draft')
  passed('断线禁编辑与提交且保留草稿；重连后必须显式重新申请写权')

  await title(a).fill('降权后保留的草稿')
  await h.api(setupToken,`/api/subjects/${author.subject.id}`,'PATCH',{role:'viewer',enabled:true})
  await until(()=>title(a).isDisabled(),'Role change failed to revoke editing')
  await presence(sa,source,'viewing')
  assert.equal(await title(a).inputValue(),'降权后保留的草稿')
  assert.ok(await title(b).isDisabled())
  assert.ok(!await bar(a).getByRole('button',{name:'开始编辑',exact:true}).count()||await bar(a).getByRole('button',{name:'开始编辑',exact:true}).isDisabled())
  passed('主体降为只读时全部会话失去写权，当前草稿仍然保留')
  assert.deepEqual(errors,[])
  await writeFile(join(output,'acceptance.json'),JSON.stringify({date:new Date().toISOString(),protocol:4,interface:lan.name,address:lan.address,physicalDevices:1,secondPhysicalDeviceTested:false,browserContexts:2,browserPages:3,browserClockOffsetsHours:[6,-4],results,commitRequestsObserved:commits.length},null,2))
  console.log(`协作编辑体验验收通过：${results.length} 组；${lan.name} ${lan.address}，同机真实 LAN HTTP。`)
}catch(error){
  for(const [i,page]of pages.entries()){console.error(`PRESENCE CLIENT ${i}:`,(await page.locator('body').innerText().catch(()=>'' )).slice(0,4500));await page.screenshot({path:join(output,`failed-client-${i}.png`)}).catch(()=>undefined)}
  throw error
}finally{clearInterval(heartbeat);if(browser)await browser.close();await h.stop()}
