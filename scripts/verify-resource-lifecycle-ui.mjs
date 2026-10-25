import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {harness,progress} from './collaboration-harness.mjs'
import {loginProject,submission,closeCollaboration} from './project-ui-helpers.mjs'
import {until} from './progress-collaboration-helpers.mjs'
const h=await harness(true);let browser
const row=(page,name)=>page.locator('.app-workspace-pane.active [role=treeitem]').filter({has:page.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`)})
try{
 const owner=await h.login(h.credential,'lifecycle owner'),account=await h.api(owner.token,'/api/subjects','POST',{name:'Editor',kind:'human',role:'editor'})
 browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
 const page=await browser.newPage(),requests=[];page.on('dialog',dialog=>dialog.accept());page.on('pageerror',e=>console.log('PAGE',String(e)))
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/files/commit')requests.push(JSON.parse(request.postData()))})
 await loginProject(page,h.base,account.credential,'lifecycle editor');await page.getByRole('tab',{name:'游戏性',exact:true}).click()
 const search=page.getByLabel('筛选资源',{exact:true});await search.fill('example.quest');await row(page,'example.quest').click()
 await page.getByLabel('进度标题',{exact:true}).waitFor();await page.locator('.progress-autosave-bar').getByRole('status').filter({hasText:'修改已保存'}).waitFor()
 await page.getByLabel('进度标题',{exact:true}).fill('改名前输入')
 await row(page,'example.quest').click();await page.keyboard.press('F2');const input=page.getByRole('textbox',{name:'资源名称',exact:true});await input.fill('journey');await input.press('Enter')
 await search.fill('journey.quest');await row(page,'journey.quest').waitFor();await row(page,'journey.quest').click({timeout:10000}).catch(async e=>{console.log('BODY',await page.locator('body').innerText());console.log('REQUESTS',JSON.stringify(requests.map(r=>r.changes.map(c=>({op:c.op,path:c.path,destination:c.destination})))));throw e})
 await until(async()=>{try{return (await readFile(join(h.root,'assets/zh_cn/lang_quest/journey.lang'),'utf8')).includes('改名前输入')}catch{return false}},'rename lost pending text')
 const before=requests.length
 await page.getByLabel('进度标题',{exact:true}).fill('新路径继续编辑');await page.getByLabel('进度标题',{exact:true}).press('Tab')
 await until(async()=>(await readFile(join(h.root,'assets/zh_cn/lang_quest/journey.lang'),'utf8')).includes('新路径继续编辑'),'new path did not save')
 assert(requests.slice(before).filter(r=>r.changes.some(c=>c.op==='progress-command')).every(r=>r.changes.every(c=>c.path==='src/quest/journey.quest')))
 await page.keyboard.press('Control+s');const status=await submission(page);await status.getByRole('status').filter({hasText:'修改已保存'}).waitFor();await closeCollaboration(page)
 console.log('PASS local rename preserves pending input and continues auto/global save without reopening')
 // A composing input has local intent, but no request has been sent when a peer deletes it.
 const title=page.getByLabel('进度标题',{exact:true});await title.dispatchEvent('compositionstart');await title.fill('远端删除后保留的输入')
 await h.commit(owner.token,[{op:'remove',path:'src/quest/journey.quest'},{op:'remove',path:'assets/zh_cn/lang_quest/journey.lang'}]);await h.release(owner.token)
 await page.getByText('资源已从工程移除，草稿仅保留在本机；普通保存不会重新创建它。',{exact:false}).waitFor({timeout:20000})
 await page.keyboard.press('Control+s');await page.waitForTimeout(700)
 assert(!(await h.files(owner.token)).entries.some(entry=>entry.path==='src/quest/journey.quest'))
 assert.equal(await title.inputValue(),'远端删除后保留的输入');assert(await title.isDisabled())
 await page.reload();await loginProject(page,h.base,account.credential,'lifecycle reopened',false);await page.getByRole('tab',{name:'游戏性',exact:true}).click();await page.getByLabel('筛选资源',{exact:true}).fill('journey.quest');await row(page,'journey.quest').click()
 await page.getByLabel('进度标题',{exact:true}).waitFor();assert.equal(await page.getByLabel('进度标题',{exact:true}).inputValue(),'远端删除后保留的输入')
 await page.keyboard.press('Control+s');await page.waitForTimeout(500);assert(!(await h.files(owner.token)).entries.some(entry=>entry.path==='src/quest/journey.quest'))
 console.log('PASS peer deletion detaches draft, disables writes, preserves reload recovery and never recreates source')
 // A normal local delete unregisters the clean editor from future Save operations.
 await h.commit(owner.token,[{path:'src/quest/delete-me.quest',content:JSON.stringify({...progress,id:'delete-document'})}]);await h.release(owner.token)
 await page.getByLabel('筛选资源',{exact:true}).fill('delete-me.quest');await row(page,'delete-me.quest').waitFor();await row(page,'delete-me.quest').click();await page.locator('.progress-autosave-bar').getByRole('status').filter({hasText:'修改已保存'}).waitFor()
 await row(page,'delete-me.quest').click({button:'right'});await page.getByRole('menuitem',{name:'移除任务…',exact:true}).click()
 await until(async()=>!(await h.files(owner.token)).entries.some(entry=>entry.path==='src/quest/delete-me.quest'),'local deletion failed')
 await page.keyboard.press('Control+s');await page.waitForTimeout(600);assert(!(await h.files(owner.token)).entries.some(entry=>entry.path==='src/quest/delete-me.quest'))
 console.log('PASS local deletion unregisters old save/sync callbacks')
}finally{await browser?.close();await h.stop()}
