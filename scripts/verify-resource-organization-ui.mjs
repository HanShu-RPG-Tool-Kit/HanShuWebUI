import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {harness} from './collaboration-harness.mjs'
import {loginProject,submission,closeCollaboration} from './project-ui-helpers.mjs'
import {until} from './progress-collaboration-helpers.mjs'
const row=(page,name)=>page.locator('.app-workspace-pane.active [role=treeitem]').filter({has:page.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`)})
const metadataRead=url=>url.pathname==='/api/files/content'&&url.searchParams.get('path')==='meta/explorer.json'
async function expand(page,name){const target=row(page,name);await target.waitFor();if(await target.getAttribute('aria-expanded')!=='true')await target.click()}
async function committed(page,action){
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/files/commit'&&r.request().method()==='POST')
 await action();const receipt=await(await response).json();assert.equal(receipt.status,'committed',JSON.stringify(receipt));return receipt
}
async function newFolder(page,parent,name){
 await row(page,parent).click();await page.locator('.app-workspace-pane.active').getByRole('button',{name:'新建文件夹',exact:true}).click()
 const input=page.getByRole('textbox',{name:'新文件夹名称',exact:true});await input.fill(name)
 await committed(page,()=>input.press('Enter'));await row(page,name).waitFor()
}
async function renameFolder(page,before,after){
 await row(page,before).click();await page.keyboard.press('F2')
 const input=page.getByRole('textbox',{name:'资源名称',exact:true});await input.fill(after)
 await committed(page,()=>input.press('Enter'));await row(page,after).waitFor()
}
// Delay a real S snapshot after it was fetched, preserving the original response/version.
async function holdMetadata(page,expectedFolder){
 let release,held=false,finished=false
 const gate=new Promise(resolve=>{release=resolve})
 const handler=async route=>{
  const response=await route.fetch()
  const snapshot=await response.json()
  const organization=JSON.parse(Buffer.from(snapshot.content,'base64').toString('utf8'))
  if(!held&&organization.folders.some(folder=>folder.name===expectedFolder)){
   held=true;await gate;await route.fulfill({response});finished=true
  }else await route.fulfill({response})
 }
 await page.route(metadataRead,handler)
 return {wait:()=>until(()=>held,`Metadata response for ${expectedFolder} was not intercepted`),release:async()=>{release();await until(()=>finished,'Held metadata response did not finish');await page.unroute(metadataRead,handler)},cancel:async()=>{release();await page.unroute(metadataRead,handler)}}
}
const h=await harness(true);let browser
try{
 const owner=await h.login(h.credential,'organization owner')
 const account=await h.api(owner.token,'/api/subjects','POST',{name:'Editor',kind:'human',role:'editor'})
 await h.commit(owner.token,[{path:'src/script/common/shared.py',content:'pass'},{path:'src/script/kit/shared.py',content:'pass'},{path:'meta/explorer.json',content:JSON.stringify({version:1,folders:[{key:'shared-folder',name:'共享章节',package:'quest',parentId:null}],placements:{'src/quest/example.quest':'shared-folder'}})}]);await h.release(owner.token)
 browser=await chromium.launch({headless:true,...process.platform==='win32'?{channel:'msedge'}:{}})
 const contextA=await browser.newContext(),contextB=await browser.newContext()
 const a=await contextA.newPage(),b=await contextB.newPage()

 for(const [page,name]of [[a,'author A'],[b,'author B']]){await loginProject(page,h.base,account.credential,name);await page.getByRole('tab',{name:'游戏性',exact:true}).click()}
 await a.getByRole('tab',{name:'剧本',exact:true}).click()
 for(const kind of ['common','kit'])assert.equal(await a.locator(`.app-workspace-pane.active .explorer-kind-row[title="src/script/${kind}"]`).count(),1)
 assert.equal(await a.locator('.app-workspace-pane.active button[title^="src/script/common/shared.py"]').count(),1)
 assert.equal(await a.locator('.app-workspace-pane.active button[title^="src/script/kit/shared.py"]').count(),1)
 await a.getByRole('tab',{name:'游戏性',exact:true}).click()
 const folder=page=>page.locator('.app-workspace-pane.active [role=treeitem][title="共享章节"]')
 await folder(a).waitFor();await folder(b).waitFor()
 await folder(a).click();await a.keyboard.press('F2')
 const input=a.locator('.flow-resource-row input');await input.fill('共同章节');await input.press('Enter')
 await b.locator('.app-workspace-pane.active [role=treeitem][title="共同章节"]').waitFor({timeout:20000})
 let meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
 assert.equal(meta.folders[0].name,'共同章节');assert.equal(meta.placements['src/quest/example.quest'],'shared-folder')
 // Creating a nested view folder must write shared metadata, never a source directory.
 const root=b.locator('.app-workspace-pane.active [role=treeitem][title="共同章节"]')
 await root.click({button:'right'});await b.getByRole('menuitem',{name:'新建文件夹',exact:true}).click()
 const newName=b.getByRole('textbox',{name:'新文件夹名称',exact:true});await newName.fill('支线');await newName.press('Enter')
 const parentA=a.locator('.app-workspace-pane.active [role=treeitem][title="共同章节"]')
 if(await parentA.getAttribute('aria-expanded')!=='true')await parentA.click()
 await a.locator('.app-workspace-pane.active [role=treeitem][title="支线"]').waitFor({timeout:20000})
 const tree=await h.files(owner.token);assert(!tree.entries.some(e=>e.path.includes('共同章节')||e.path.includes('支线')))
 assert(tree.entries.some(e=>e.path==='src/quest/example.quest'))
 await b.reload();await loginProject(b,h.base,account.credential,'author B reopened',false);await b.getByRole('tab',{name:'游戏性',exact:true}).click();await b.locator('.app-workspace-pane.active [role=treeitem][title="共同章节"]').waitFor()
 const parentB=b.locator('.app-workspace-pane.active [role=treeitem][title="共同章节"]');if(await parentB.getAttribute('aria-expanded')!=='true')await parentB.click()
 // Rename a real source through the tree: its path placement and owned language file move atomically.
 const source=a.locator('.app-workspace-pane.active [role=treeitem][title="example.quest"]')
 assert.equal(await source.count(),1,'organized task must have exactly one tree identity');await source.click();await a.keyboard.press('F2');const rename=a.getByRole('textbox',{name:'资源名称',exact:true});await rename.fill('renamed');await rename.press('Enter')
 await b.locator('.app-workspace-pane.active [role=treeitem][title="renamed.quest"]').waitFor({timeout:20000})
 meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'));assert.equal(meta.placements['src/quest/renamed.quest'],'shared-folder');assert(!meta.placements['src/quest/example.quest'])
 assert((await h.files(owner.token)).entries.some(e=>e.path==='assets/zh_cn/lang_quest/renamed.lang'))

 // A source draft can have a shared placement before its source exists on S.
 await a.reload();await loginProject(a,h.base,account.credential,'author A organization races',false);await a.getByRole('tab',{name:'游戏性',exact:true}).click();await a.waitForLoadState('networkidle')
 await newFolder(a,'物品库','待保存物品')
 await row(a,'待保存物品').click({button:'right'});await a.getByRole('menuitem',{name:'新建物品',exact:true}).click()
 const itemName=a.getByRole('textbox',{name:'新物品名称',exact:true});await itemName.fill('pending-placement')
 await committed(a,()=>itemName.press('Enter'));await row(a,'pending-placement.item').waitFor()
 const itemPath='src/items/pending-placement.item'
 meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
 const itemFolderKey=meta.folders.find(folder=>folder.name==='待保存物品').key
 assert.equal(meta.placements[itemPath],itemFolderKey)
 assert(!(await h.files(owner.token)).entries.some(entry=>entry.path===itemPath),'The source must still be an unsaved A draft')
 await b.reload();await loginProject(b,h.base,account.credential,'author B with pending placement',false);await b.getByRole('tab',{name:'游戏性',exact:true}).click()
 await expand(b,'物品库');await row(b,'待保存物品').waitFor();assert.equal(await row(b,'pending-placement.item').count(),0)
 await renameFolder(b,'待保存物品','保留草稿归属')
 meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
 assert.equal(meta.placements[itemPath],itemFolderKey,'An unrelated peer folder edit must preserve the placement of an absent source')
 await row(a,'保留草稿归属').waitFor({timeout:20000})
 await committed(a,()=>a.keyboard.press('Control+s'))
 assert((await h.files(owner.token)).entries.some(entry=>entry.path===itemPath))
 assert.equal(JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8')).placements[itemPath],itemFolderKey)
 await expand(b,'保留草稿归属');await row(b,'pending-placement.item').waitFor({timeout:20000})
 assert.equal(Number(await row(b,'pending-placement.item').getAttribute('aria-level')),Number(await row(b,'保留草稿归属').getAttribute('aria-level'))+1)
 console.log('PASS pending source placement survives a reopened peer organization edit and later source save')

 // Use the actual move UI, whose state contains builtin scripts and library table documents.
 await newFolder(a,'物品库','存放区')
 meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
 const targetKey=meta.folders.find(folder=>folder.name==='存放区').key
 await row(a,'保留草稿归属').click({button:'right'});await a.getByRole('menuitem',{name:'移动到…',exact:true}).click()
 await a.getByRole('combobox',{name:'目标文件夹',exact:true}).selectOption(`items:${targetKey}`)
 await committed(a,()=>a.locator('.flow-explorer-edit-panel').getByRole('button',{name:'确认',exact:true}).click())
 meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
 assert.equal(meta.folders.find(folder=>folder.key===itemFolderKey).parentId,targetKey)
 assert.equal(meta.placements[itemPath],itemFolderKey)
 await expand(b,'存放区');await row(b,'保留草稿归属').waitFor({timeout:20000})
 assert.equal(Number(await row(b,'保留草稿归属').getAttribute('aria-level')),Number(await row(b,'存放区').getAttribute('aria-level'))+1)
 console.log('PASS actual folder move menu works with builtin script and virtual table views')

 // UI-only navigation during a delayed metadata read must not suppress the newer snapshot.
 const delayed=await holdMetadata(a,'远端归档')
 try{
  await renameFolder(b,'存放区','远端归档');await delayed.wait()
  await expand(a,'物品库');await row(a,'物品库表视图').click()
  assert.equal(await row(a,'远端归档').count(),0,'The remote response must still be held')
  await delayed.release();await row(a,'远端归档').waitFor({timeout:20000})
  assert.equal(await row(a,'存放区').count(),0)
  const status=await submission(a)
  await until(async()=>await status.locator('.project-edit-summary [role=status]').innerText()==='修改已保存','View-only changes created a stale organization draft')
  await closeCollaboration(a)
 }finally{await delayed.cancel()}
 console.log('PASS delayed remote metadata is adopted after opening the item library view')

 // Produce a real CAS rejection from an old tree, then exercise the recovery panel end to end.
 const conflictRead=await holdMetadata(a,'对端保留版本')
 try{
  await renameFolder(b,'远端归档','对端保留版本');await conflictRead.wait()
  await row(a,'远端归档').click();await a.keyboard.press('F2')
  const staleName=a.getByRole('textbox',{name:'资源名称',exact:true});await staleName.fill('本机冲突版本')
  const rejected=a.waitForResponse(r=>new URL(r.url()).pathname==='/api/files/commit'&&r.request().method()==='POST')
  await staleName.press('Enter');const rejection=await(await rejected).json()
  assert.equal(rejection.status,'rejected');assert.equal(rejection.error.code,'conflict')
  await conflictRead.release()
  const status=await submission(a);await status.getByText('提交冲突',{exact:true}).waitFor()
  a.once('dialog',dialog=>dialog.accept())
  await status.getByRole('button',{name:'放弃冲突修改并同步修改',exact:true}).click()
  await a.getByRole('dialog',{name:'正在同步修改',exact:true}).waitFor({state:'hidden'})
  await until(async()=>await status.locator('.project-edit-summary [role=status]').innerText()==='修改已保存','Synchronization left failed submissions or dirty drafts')
  assert.deepEqual(await status.getByRole('alert').allTextContents(),[])
  await closeCollaboration(a);await row(a,'对端保留版本').waitFor({timeout:20000})
  assert.equal(await row(a,'本机冲突版本').count(),0);assert.equal(await row(a,'远端归档').count(),0)
  meta=JSON.parse(await readFile(join(h.root,'meta/explorer.json'),'utf8'))
  assert.equal(meta.folders.find(folder=>folder.key===targetKey).name,'对端保留版本')
  assert.equal(meta.placements[itemPath],itemFolderKey)
 }finally{await conflictRead.cancel()}
 console.log('PASS a real organization CAS conflict is discarded and synchronized without stale tree or dirty drafts')

 // A stale metadata version rejects the entire batch, including an otherwise valid new source.
 const stale=(await h.files(owner.token)).entries.find(e=>e.path==='meta/explorer.json').version
 meta.folders[0].name='服务器新版本';await h.commit(owner.token,[{path:'meta/explorer.json',content:JSON.stringify(meta)}]);await h.release(owner.token)
 const peer=await h.login(account.credential,'CAS peer')
 await h.commit(peer.token,[{path:'meta/explorer.json',content:JSON.stringify({...meta,folders:[]}),version:stale},{path:'src/script/common/should-not-exist.py',content:'pass'}],409);await h.release(peer.token)
 assert(!(await h.files(owner.token)).entries.some(e=>e.path.endsWith('should-not-exist.py')))
 const viewerAccount=await h.api(owner.token,'/api/subjects','POST',{name:'Reader',kind:'human',role:'viewer'}),viewer=await h.login(viewerAccount.credential,'reader')
 await h.api(viewer.token,'/api/files/leases','POST',{paths:['meta/explorer.json']},403)
 // Remote deletion resets the cached version; the next directory edit recreates metadata with a null base.
 await h.commit(owner.token,[{op:'remove',path:'meta/explorer.json'}]);await h.release(owner.token)
 await a.locator('.app-workspace-pane.active [role=treeitem][title="服务器新版本"]').waitFor({state:'hidden'})
 const category=a.locator('.app-workspace-pane.active [role=treeitem][title="演员"]');await category.click({button:'right'});await a.getByRole('menuitem',{name:'新建文件夹',exact:true}).click()
 const first=a.getByRole('textbox',{name:'新文件夹名称',exact:true});await first.fill('首个共享目录');await first.press('Enter')
 const actorB=b.locator('.app-workspace-pane.active [role=treeitem][title="演员"]');if(await actorB.getAttribute('aria-expanded')!=='true')await actorB.click()
 await b.locator('.app-workspace-pane.active [role=treeitem][title="首个共享目录"]').waitFor({timeout:20000})
 console.log('PASS shared organization: isolated browser clients, rename/create propagation, reopening, flat disk layout, stageplay type groups, CAS rollback and viewer denial')
}finally{await browser?.close();await h.stop()}
