import assert from 'node:assert/strict'
import { mkdir,readFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { projectMenu, collaboration, closeCollaboration } from './project-ui-helpers.mjs'
import { until } from './progress-collaboration-helpers.mjs'
import { skinFixture } from './history-test-helpers.mjs'
const h=await harness({web:true,localProjects:true})
const output=resolve('../output/account-collaboration');await mkdir(output,{recursive:true})
let browser
const active=p=>p.locator('.app-workspace-pane.active')
const disk=async path=>readFile(join(h.root,path),'utf8')
async function openProgress(p){await closeCollaboration(p);await p.getByRole('tab',{name:'进度流程',exact:true}).click();await active(p).getByLabel('筛选资源',{exact:true}).fill('example.progress');await active(p).locator('[role=treeitem][title="example.progress"]').click();await until(()=>active(p).getByLabel('进度标题',{exact:true}).isEnabled(),'Progress not ready')}
async function sync(p){await collaboration(p,'修改');await p.getByRole('button',{name:'放弃冲突修改并同步修改',exact:true}).click();await p.getByRole('dialog',{name:'正在同步修改',exact:true}).waitFor({state:'hidden'});assert.equal(await p.getByRole('alert').filter({hasText:'仍有'}).count(),0)}
try {
  const admin=await h.api('','/api/local-session','POST',{credential:h.credential,clientName:'验收准备'})
  await h.commit(admin.token,[{path:'src/script/common/conflict.py',content:'print("base")\n'},{path:'src/script/common/safe.py',content:'print("safe")\n'}]);await h.release(admin.token)
  const skin=skinFixture()
  await h.commit(admin.token,[{path:skin.objectPath,content:skin.object},{path:'.hanshu/skinmanager/library.json',content:JSON.stringify({schemaVersion:5,revision:1,folders:[],entries:[skin.entry('sync-skin','同步皮肤')]})}]);await h.release(admin.token)
  const peerUser=await h.api(admin.token,'/api/accounts','POST',{username:'peer',nickname:'作者 B',password:'Peer-password-123',role:'editor'})
  const peer=await h.api('','/api/sessions','POST',{username:peerUser.user.username,password:'Peer-password-123',clientName:'API B'})
  browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
  const owner=await browser.newPage({viewport:{width:1500,height:1050}})
  await owner.goto(h.base);await projectMenu(owner,'打开工程…');await owner.getByRole('button',{name:'打开本机工程…',exact:true}).click();await owner.getByRole('button',{name:'默认工程',exact:true}).click();await owner.getByRole('button',{name:'打开此文件夹',exact:true}).click()
  await owner.locator('.collab-widget[data-project-name="统一工程验收"]').waitFor()
  await collaboration(owner,'用户管理')
  const create=owner.getByRole('form',{name:'创建用户',exact:true})
  await create.getByLabel('新用户用户名').fill('writer');await create.getByLabel('新用户昵称').fill('作者 A');await create.getByLabel('新用户密码').fill('Writer-password-123');await create.getByRole('button',{name:'创建用户',exact:true}).click()
  await owner.getByText('@writer',{exact:true}).waitFor()
  await closeCollaboration(owner);await projectMenu(owner,'分享工程…')
  await until(()=>owner.getByRole('switch',{name:'局域网共享'}).isEnabled(),'Share not ready');await owner.getByRole('switch',{name:'局域网共享'}).click()
  const link=owner.getByLabel('工程分享链接');await link.waitFor();const url=await link.inputValue();await owner.getByRole('button',{name:'完成',exact:true}).click()
  const pages=[]
  for(const [username,password] of [['writer','Writer-password-123'],['peer','Peer-password-123']]) {
    const p=await browser.newPage({viewport:{width:1500,height:1050}});pages.push(p);p.on('dialog',d=>d.accept());await p.goto(url)
    const form=p.getByRole('form',{name:'登录共享工程',exact:true});await form.getByLabel('用户名',{exact:true}).fill(username);await form.getByLabel('密码',{exact:true}).fill(password);await form.getByRole('button',{name:'登录工程',exact:true}).click();await p.locator('.collab-widget[data-project-name="统一工程验收"]').waitFor()
  }
  const [a,b]=pages
  await collaboration(a);await a.locator('.collab-members strong').filter({hasText:'作者 A'}).waitFor();assert.equal(await a.getByRole('button',{name:'用户管理',exact:true}).count(),0);await closeCollaboration(a)
  console.log('通过：本机 Admin 界面创建账号，分享页面用户名密码登录，协作显示昵称，远端没有用户管理入口')
  for(const file of ['conflict.py','safe.py']) {
    await active(a).getByText(file,{exact:true}).first().click();await active(a).locator('.monaco-editor .view-lines').first().click({position:{x:80,y:15}});await a.keyboard.press('Control+End');await a.keyboard.type('\n# A local draft')
  }
  await h.commit(peer.token,[{path:'src/script/common/conflict.py',content:'print("server B")\n'}]);await h.release(peer.token)
  await a.keyboard.press('Control+s');await a.locator('.collab-attention-label').waitFor();await sync(a)
  assert.equal(await disk('src/script/common/conflict.py'),'print("server B")\n');assert.ok((await disk('src/script/common/safe.py')).includes('A local draft'))
  await a.screenshot({path:join(output,'synchronized.png')})
  console.log('通过：失败的多文件保存仅放弃冲突文件，其余文件提交落盘，最终视图跟随服务器')
  await Promise.all(pages.map(openProgress))
  const title=active(a).getByLabel('进度标题',{exact:true}),description=active(a).getByLabel('进度描述',{exact:true})
  await title.dispatchEvent('compositionstart',{data:''});await title.fill('A 冲突标题');await description.fill('A 可以提交的描述')
  await active(b).getByLabel('进度标题',{exact:true}).fill('B 的服务器标题');await active(b).getByLabel('进度标题',{exact:true}).press('Tab')
  await until(async()=>JSON.parse(await disk('assets/zh_cn/lang_progress/example.lang')).name==='B 的服务器标题','Peer title did not save')
  await title.dispatchEvent('compositionend',{data:'A 冲突标题'})
  await a.locator('.collab-attention-label').waitFor();await sync(a)
  const language=JSON.parse(await disk('assets/zh_cn/lang_progress/example.lang'))
  assert.equal(language.name,'B 的服务器标题');assert.equal(language.description,'A 可以提交的描述')
  assert.equal(await title.inputValue(),'B 的服务器标题');assert.equal(await description.inputValue(),'A 可以提交的描述')
  console.log('通过：同一进度内放弃冲突标题，保留并提交不冲突的描述，不整份覆盖语言文件')
  await closeCollaboration(a);await a.getByRole('tab',{name:'剧本',exact:true}).click()
  await active(a).getByText('safe.py',{exact:true}).first().click();await active(a).locator('.monaco-editor .view-lines').first().click({position:{x:80,y:15}});await a.keyboard.press('Control+End');await a.keyboard.type('\n# confirmed once')
  let commits=0
  await a.route('**/api/files/commit',async route=>{commits++;const response=await route.fetch();assert.equal((await response.json()).status,'committed');await route.fulfill({status:200,contentType:'application/json',body:'{"incomplete":true}'})})
  await a.keyboard.press('Control+s');await a.locator('.collab-attention-label').waitFor()
  await a.route('**/api/files/transactions/*',route=>route.fulfill({status:404,contentType:'application/json',body:'{"code":"not_found","message":"暂未查到回执"}'}))
  await collaboration(a,'修改');await a.getByRole('button',{name:'放弃冲突修改并同步修改',exact:true}).click();await a.getByRole('dialog',{name:'正在同步修改',exact:true}).waitFor({state:'hidden'})
  await a.getByRole('alert').filter({hasText:'仍有结果待确认'}).first().waitFor();assert.equal(commits,1)
  await a.unroute('**/api/files/transactions/*');await a.unroute('**/api/files/commit');await sync(a)
  assert.equal(commits,1);assert.equal((await disk('src/script/common/safe.py')).split('confirmed once').length-1,1)
  console.log('通过：回执未查明时不丢草稿或重发；查询确认成功后同步，不重复提交已落盘内容')
  await closeCollaboration(a);await a.getByRole('tab',{name:'皮肤管理器',exact:true}).click()
  await active(a).locator('.skinWorkspaceCenter').getByRole('button').filter({has:a.getByText('同步皮肤',{exact:true})}).first().click()
  const details=active(a).locator('aside.skinWorkspaceRight');await details.getByTitle('点击编辑名称',{exact:true}).click();await details.getByLabel('名称',{exact:true}).fill('A 的冲突皮肤名')
  const patch=await h.prepare(peer.token,[{op:'skin-entry-patch',path:'.hanshu/skinmanager/library.json',content:JSON.stringify({entryId:'sync-skin',expectedRevision:1,changes:{name:'B 的服务器皮肤名'}})}])
  assert.equal((await h.api(peer.token,'/api/files/commit','POST',patch)).status,'committed');await h.release(peer.token)
  await details.getByLabel('备注',{exact:true}).fill('A 的独立皮肤备注')
  await a.locator('.collab-attention-label').waitFor();await sync(a)
  const savedSkin=JSON.parse(await disk('.hanshu/skinmanager/library.json')).entries[0]
  assert.equal(savedSkin.name,'B 的服务器皮肤名');assert.equal(savedSkin.note,'A 的独立皮肤备注')
  console.log('通过：皮肤从服务器快照判断冲突，丢弃冲突名称并提交独立备注，恢复草稿不再带回旧名称')
  await a.reload();const login=a.getByRole('form',{name:'登录共享工程',exact:true});await login.waitFor();assert.equal(await login.getByLabel('密码',{exact:true}).inputValue(),'');await login.getByRole('button',{name:'关闭',exact:true}).click()
  await projectMenu(a,'连接其他服务器…');const connect=a.getByRole('form',{name:'连接其他服务器',exact:true})
  await connect.getByRole('button').filter({hasText:'统一工程验收'}).first().click();assert.equal(await connect.getByLabel('用户名',{exact:true}).inputValue(),'writer');assert.equal(await connect.getByLabel('密码',{exact:true}).inputValue(),'')
  const stored=await a.evaluate(()=>JSON.stringify({...localStorage}));assert.ok(!stored.includes('Writer-password')&&!stored.includes('Peer-password'))
  await a.screenshot({path:join(output,'recent-login.png')})
  console.log('通过：刷新需要重新登录，最近连接记住地址、工程和用户名，不保存密码或会话令牌')
} catch(error) {
  for(const [index,p] of (browser?.contexts().flatMap(c=>c.pages())??[]).entries()){console.error(`PAGE ${index}:`,(await p.locator('body').innerText()).slice(0,5000));await p.screenshot({path:join(output,`failure-${index}.png`)})}
  throw error
} finally {await browser?.close();await h.stop()}
