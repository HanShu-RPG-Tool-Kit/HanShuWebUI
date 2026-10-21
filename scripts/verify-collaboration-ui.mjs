import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile,mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'
const h=await harness(true);let browser;const pages=[];const errors=[]
let ownerToken=''
const heartbeat=setInterval(()=>{if(ownerToken)void h.api(ownerToken,'/api/heartbeat','POST',{resourceId:null,fileLeases:[]}).catch(()=>undefined)},8000)
async function until(fn,label){const deadline=Date.now()+15000;while(!await fn()){assert.ok(Date.now()<deadline,label);await new Promise(r=>setTimeout(r,75))}}
async function login(page,key,name,navigate=true){
  if(navigate)await page.goto(h.base)
  await page.getByRole('button',{name:'打开工程…',exact:true}).click()
  const form=page.getByRole('form',{name:'打开工程',exact:true})
  await form.getByLabel('服务地址',{exact:true}).fill(h.base)
  await form.getByLabel('主体凭证',{exact:true}).fill(key)
  await form.getByLabel('本端名称',{exact:true}).fill(name)
  await form.getByRole('button',{name:'连接并打开工程',exact:true}).click()
  await page.locator('.project-service-bar').getByText('统一工程验收',{exact:true}).waitFor()
}
async function progress(page){await page.getByRole('tab',{name:'进度流程',exact:true}).click();await page.getByRole('textbox',{name:'筛选资源',exact:true}).fill('example.progress');await page.locator('[role=treeitem][title="example.progress"]').click();await page.getByLabel('进度标题',{exact:true}).waitFor()}
try {
  const owner=await h.login(h.credential,'setup')
  ownerToken=owner.token
  const editor=await h.api(owner.token,'/api/subjects','POST',{name:'创作者',kind:'account',role:'editor'})
  const reader=await h.api(owner.token,'/api/subjects','POST',{name:'只读工具',kind:'agent',role:'viewer'})
  browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
  for(let i=0;i<3;i++){
    const context=await browser.newContext({viewport:{width:1500,height:1050}})
    await context.addInitScript(()=>{window.__directProjectIo=0;Object.defineProperty(window,'showDirectoryPicker',{value:()=>{window.__directProjectIo++;throw new Error('C must not open an OS project directory')}});for(const [type,method]of [['FileSystemFileHandle','createWritable'],['FileSystemDirectoryHandle','removeEntry']])if(window[type])Object.defineProperty(window[type].prototype,method,{value:()=>{window.__directProjectIo++;throw new Error('Direct OS project write')}})})
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());pages.push(page)
  }
  await Promise.all([login(pages[0],editor.credential,'窗口 A'),login(pages[1],editor.credential,'窗口 B'),login(pages[2],reader.credential,'只读窗口')])
  await Promise.all(pages.map(progress))
  const [a,b,v]=pages
  await until(async()=>await a.getByLabel('进度标题',{exact:true}).inputValue()==='共同进度','Initial locale title missing')
  assert.ok(await v.getByLabel('进度标题',{exact:true}).isDisabled())
  await a.getByLabel('进度标题',{exact:true}).fill('从 A 保存的共同标题')
  // A language change remains a draft until the same save as its source.
  assert.equal(JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name,'共同进度')
  await a.getByRole('button',{name:'完成任一',exact:true}).click()
  let rejectCommit=true
  const batches=[]
  await a.route('**/api/files/commit',async route=>{
    batches.push(route.request().postDataJSON())
    if(rejectCommit){rejectCommit=false;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({transactionId:route.request().postDataJSON().transactionId,status:'rejected',tree:null,error:{code:'locked',message:'测试中的写权冲突'}})})}
    else await route.continue()
  })
  await a.keyboard.press('Control+s')
  await a.getByRole('region',{name:'工程提交状态',exact:true}).getByText('测试中的写权冲突',{exact:true}).waitFor()
  assert.equal(JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name,'共同进度')
  assert.equal(JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion,'all')
  assert.deepEqual(batches[0].changes.map(c=>c.path).sort(),['assets/zh_cn/lang_progress/example.lang','src/progress/example.progress'])
  await a.getByRole('button',{name:'重试原提交',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name==='从 A 保存的共同标题','Locale did not reach server')
  await until(async()=>await b.getByLabel('进度标题',{exact:true}).inputValue()==='从 A 保存的共同标题','B did not receive locale changes')
  assert.deepEqual(batches[1].changes.map(c=>({path:c.path,content:c.content,version:c.version})),batches[0].changes.map(c=>({path:c.path,content:c.content,version:c.version})))
  assert.notEqual(batches[1].transactionId,batches[0].transactionId,'A definitive rejection must retry under a new transaction ID')
  await a.unroute('**/api/files/commit')
  await a.getByRole('button',{name:'提交记录',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='any','Progress was not saved to the ordinary project')
  await until(()=>b.getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'B did not receive .progress change')
  await a.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
  await b.getByRole('button',{name:'完成全部',exact:true}).click();await b.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='all','B could not save after release')
  await b.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
  // Two dirty resources must be handled as one conflict, including a resource
  // whose server version is adopted instead of being overwritten.
  await until(()=>a.getByRole('button',{name:'完成全部',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'A did not receive latest completion')
  await a.getByLabel('进度标题',{exact:true}).fill('A 未提交的标题')
  await a.getByRole('button',{name:'完成任一',exact:true}).click()
  await b.getByLabel('进度标题',{exact:true}).fill('B 已提交的标题')
  await b.getByRole('button',{name:'完成任一',exact:true}).click();await b.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name==='B 已提交的标题','B conflict fixture was not saved')
  await b.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
  await a.keyboard.press('Control+s')
  await a.getByRole('button',{name:'处理冲突',exact:true}).click()
  const conflict=a.getByRole('dialog',{name:'处理提交冲突',exact:true})
  const sourcePath='src/progress/example.progress',languagePath='assets/zh_cn/lang_progress/example.lang'
  const sourceRow=conflict.getByRole('article',{name:`冲突文件 ${sourcePath}`,exact:true})
  const languageRow=conflict.getByRole('article',{name:`冲突文件 ${languagePath}`,exact:true})
  assert.equal(JSON.parse(await sourceRow.getByLabel(`原始版本 ${sourcePath}`,{exact:true}).inputValue()).completion,'all')
  assert.equal(JSON.parse(await sourceRow.getByLabel(`服务器版本 ${sourcePath}`,{exact:true}).inputValue()).completion,'any')
  assert.equal(JSON.parse(await languageRow.getByLabel(`服务器版本 ${languagePath}`,{exact:true}).inputValue()).name,'B 已提交的标题')
  assert.equal(JSON.parse(await languageRow.getByLabel(`合并结果 ${languagePath}`,{exact:true}).inputValue()).name,'A 未提交的标题')
  await sourceRow.getByRole('button',{name:'采用服务器版本',exact:true}).click()
  await languageRow.getByRole('button',{name:'手动合并',exact:true}).click()
  const mergedLanguage=JSON.stringify({name:'共同处理后的标题',description:'保留并合并两端修改'})
  await languageRow.getByLabel(`合并结果 ${languagePath}`,{exact:true}).fill(mergedLanguage)
  const conflictOutput=resolve('../output/collaboration-v3');await mkdir(conflictOutput,{recursive:true})
  await a.screenshot({path:join(conflictOutput,'multi-file-conflict.png')})
  // Updating the adopted server resource while this dialog is open must reject
  // the entire mixed check+write resolution, rather than silently accepting it.
  await h.api(owner.token,'/api/files/leases','POST',{paths:[sourcePath],force:true})
  const remoteSecond=JSON.parse(await readFile(join(h.root,sourcePath),'utf8'))
  remoteSecond.completion='all';remoteSecond.authorNotes='服务器在处理冲突期间再次修改'
  await h.commit(owner.token,[{path:sourcePath,content:JSON.stringify(remoteSecond)}]);await h.release(owner.token)
  await conflict.getByRole('button',{name:'提交处理结果',exact:true}).click()
  await conflict.getByRole('alert').waitFor()
  assert.equal(JSON.parse(await readFile(join(h.root,languagePath),'utf8')).name,'B 已提交的标题','A stale mixed resolution partially wrote its language file')
  await conflict.getByRole('button',{name:'重新载入服务器版本',exact:true}).click()
  await until(async()=>JSON.parse(await sourceRow.getByLabel(`服务器版本 ${sourcePath}`,{exact:true}).inputValue()).authorNotes===remoteSecond.authorNotes,'Conflict refresh did not obtain latest server source')
  await sourceRow.getByRole('button',{name:'采用服务器版本',exact:true}).click()
  await languageRow.getByRole('button',{name:'手动合并',exact:true}).click()
  await languageRow.getByLabel(`合并结果 ${languagePath}`,{exact:true}).fill(mergedLanguage)
  const resolutions=[];a.on('request',request=>{if(request.url().endsWith('/api/files/commit'))resolutions.push(request.postDataJSON())})
  await conflict.getByRole('button',{name:'提交处理结果',exact:true}).click()
  await conflict.waitFor({state:'hidden'})
  assert.ok(resolutions.some(r=>r.changes.some(c=>c.op==='check'&&c.path===sourcePath)&&r.changes.some(c=>c.op==='write'&&c.path===languagePath)),'Conflict resolution did not include the adopted source check in its batch')
  await until(async()=>await a.getByLabel('进度标题',{exact:true}).inputValue()==='共同处理后的标题','Local editor did not adopt resolved language')
  await until(async()=>await b.getByLabel('进度标题',{exact:true}).inputValue()==='共同处理后的标题','Peer did not receive merged language')
  assert.equal(await a.getByRole('button',{name:'完成全部',exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(JSON.parse(await readFile(join(h.root,sourcePath),'utf8')).authorNotes,remoteSecond.authorNotes)
  await a.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
  await until(async()=>!(await a.locator('.app-workspace-pane.active').innerText()).includes('保存异常'),'Workspace still reports save failure after successful conflict resolution')
  assert.ok(!(await a.locator('.app-workspace-pane.active').innerText()).includes('已被其他客户端修改，草稿仍保留'))
  await a.screenshot({path:join(conflictOutput,'resolved-multi-file.png')})
  // The script workspace is part of the same opened project, with the same client session.
  await a.getByRole('tab',{name:'剧本',exact:true}).click()
  await a.locator('.app-workspace-pane.active .monaco-editor .view-lines').first().click();await a.keyboard.press('Control+a');await a.keyboard.type('shared script from client A\n');await a.keyboard.press('Control+s')
  await until(async()=>(await readFile(join(h.root,'src/hanshu/story.hs'),'utf8')).includes('shared script from client A'),'Script workspace did not save via S')
  await b.getByRole('tab',{name:'剧本',exact:true}).click()
  await until(async()=>(await b.locator('.app-workspace-pane.active .monaco-editor .view-lines').allTextContents()).join('').replace(/\u00a0/g,' ').includes('shared script from client A'),'B script did not update')
  await a.getByRole('tab',{name:'皮肤管理器',exact:true}).click()
  await until(async()=>(await a.locator('.app-workspace-pane.active').innerText()).includes('皮肤'),'Skin workspace did not open')
  await b.getByRole('tab',{name:'皮肤管理器',exact:true}).click()
  await a.getByRole('tree',{name:'文件夹树',exact:true}).click({button:'right'})
  await a.getByRole('menuitem',{name:'新建文件夹',exact:true}).click()
  const folderDialog=a.getByRole('dialog',{name:'在根目录新建文件夹',exact:true})
  await folderDialog.getByPlaceholder('文件夹名称').fill('共享皮肤分类')
  await folderDialog.getByRole('button',{name:'创建',exact:true}).click()
  await until(async()=>JSON.parse(await readFile(join(h.root,'.hanshu/skinmanager/library.json'),'utf8')).folders.some(f=>f.name==='共享皮肤分类'),'Skin changes did not reach S')
  await until(async()=>(await b.getByRole('tree',{name:'文件夹树',exact:true}).innerText()).includes('共享皮肤分类'),'Skin collection did not refresh in B')
  const countBefore=(await h.api(owner.token,'/api/project')).sessions.filter(s=>s.subjectId===editor.subject.id).length
  assert.equal(countBefore,2,'Switching workspaces created a separate session')
  // A local .progress draft survives service loss and re-authentication with its old base version.
  await progress(b);await b.getByRole('button',{name:'完成任一',exact:true}).click();await b.getByLabel('进度标题',{exact:true}).fill('重启前的语言草稿')
  const port=Number(new URL(h.base).port);await h.stop();await h.start(port)
  await until(async()=>(await b.locator('.project-service-bar').innerText()).includes('已断开'),'Client failed to notice restart')
  await login(b,editor.credential,'恢复后的窗口 B',false)
  await progress(b)
  assert.equal(await b.getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(await b.getByLabel('进度标题',{exact:true}).inputValue(),'重启前的语言草稿')
  assert.equal(JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion,'all','Draft leaked into authority')
  await b.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='any','Restored draft could not save')
  await until(async()=>JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name==='重启前的语言草稿','Restored language draft could not save')
  for(const page of pages)assert.equal(await page.evaluate(()=>window.__directProjectIo),0,'C attempted direct OS project I/O')
  assert.deepEqual(errors,[])
  const output=resolve('../output/collaboration-v2');await mkdir(output,{recursive:true});await b.screenshot({path:join(output,'unified-project.png')})
  console.log('通过：三个隔离客户端、正文与语言批量提交、失败重试使用新事务编号、三版本冲突处理、服务器再次变化阻止整批提交、采用服务器与手动合并原子保存、写权交接、剧本同步、皮肤共用会话、重启恢复正文及语言草稿；C 的直接文件系统写入调用为零。')
} catch(e){const output=resolve('../output/collaboration-v3');await mkdir(output,{recursive:true});for(const [i,page]of pages.entries()){console.error(`CLIENT ${i}:`,(await page.locator('body').innerText()).slice(0,2400));await page.screenshot({path:join(output,`failed-client-${i}.png`)}).catch(()=>undefined);}throw e}
finally {clearInterval(heartbeat);if(browser)await browser.close();await h.stop()}
