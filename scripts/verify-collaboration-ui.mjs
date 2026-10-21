import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile,mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'
const h=await harness(true);let browser;const pages=[];const errors=[]
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
  await until(async()=>JSON.parse(await readFile(join(h.root,'assets/zh_cn/lang_progress/example.lang'),'utf8')).name==='从 A 保存的共同标题','Locale did not reach server')
  await until(async()=>await b.getByLabel('进度标题',{exact:true}).inputValue()==='从 A 保存的共同标题','B did not receive locale changes')
  await a.getByRole('button',{name:'完成任一',exact:true}).click();await a.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='any','Progress was not saved to the ordinary project')
  await until(()=>b.getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed').then(v=>v==='true'),'B did not receive .progress change')
  await a.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
  await b.getByRole('button',{name:'完成全部',exact:true}).click();await b.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='all','B could not save after release')
  await b.locator('.project-service-bar').getByRole('button',{name:'释放写权',exact:true}).click()
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
  await progress(b);await b.getByRole('button',{name:'完成任一',exact:true}).click()
  const port=Number(new URL(h.base).port);await h.stop();await h.start(port)
  await until(async()=>(await b.locator('.project-service-bar').innerText()).includes('已断开'),'Client failed to notice restart')
  await login(b,editor.credential,'恢复后的窗口 B',false)
  await progress(b)
  assert.equal(await b.getByRole('button',{name:'完成任一',exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion,'all','Draft leaked into authority')
  await b.keyboard.press('Control+s')
  await until(async()=>JSON.parse(await readFile(join(h.root,'src/progress/example.progress'),'utf8')).completion==='any','Restored draft could not save')
  for(const page of pages)assert.equal(await page.evaluate(()=>window.__directProjectIo),0,'C attempted direct OS project I/O')
  assert.deepEqual(errors,[])
  const output=resolve('../output/collaboration-v2');await mkdir(output,{recursive:true});await b.screenshot({path:join(output,'unified-project.png')})
  console.log('通过：三个隔离客户端、全局打开工程、进度与本地化同步、写权交接、剧本跨工作区保存与广播、皮肤共用会话、重启草稿恢复；C 的直接文件系统写入调用为零。')
} catch(e){for(const [i,page]of pages.entries()){console.error(`CLIENT ${i}:`,(await page.locator('body').innerText()).slice(0,2400));}throw e}
finally {if(browser)await browser.close();await h.stop()}
