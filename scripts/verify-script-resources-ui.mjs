import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {harness} from './collaboration-harness.mjs'
import {loginProject} from './project-ui-helpers.mjs'
const h=await harness({web:true});let browser
try{
 const owner=await h.login(h.credential,'script setup'),account=await h.api(owner.token,'/api/subjects','POST',{name:'script author',kind:'account',role:'editor'})
 const kinds=['common','goal','kit','shop','item','entity','enchantment','player']
 await h.commit(owner.token,kinds.map(kind=>({path:`src/script/${kind}/shared.py`,content:`# ${kind}`})));await h.release(owner.token)
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await loginProject(page,h.base,account.credential,'script author');await page.getByRole('tab',{name:'游戏性',exact:true}).click()
 const pane=page.locator('.app-workspace-pane.active'),search=pane.getByLabel('筛选资源',{exact:true})
 await search.fill('shared.py');assert.equal(await pane.locator('[role=treeitem][title="shared.py"]').count(),kinds.length)
 await search.fill('')
 async function createCommon(){await pane.locator('[role=treeitem][title="通用脚本"]').click({button:'right'});await page.getByRole('menuitem',{name:'新建脚本',exact:true}).click();assert.equal(await pane.getByLabel('脚本模板').inputValue(),'default.py');const input=pane.getByLabel('新脚本名称',{exact:true}),name=await input.inputValue();await input.press('Enter');await page.keyboard.press('Control+s');for(let i=0;i<100;i++){try{const text=await readFile(join(h.root,'src/script/common',name),'utf8');assert(text.includes('通用脚本'));return name}catch{}await page.waitForTimeout(50)}throw Error('script not saved')}
 const first=await createCommon(),second=await createCommon();assert.notEqual(first,second)
 await search.fill(first);await pane.locator(`[role=treeitem][title="${first}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'移动到…',exact:true}).click();await pane.getByLabel('目标文件夹').selectOption('script:section:script:kit');await pane.locator('.flow-explorer-edit-panel').getByRole('button',{name:'确认',exact:true}).click();let moved=false;for(let i=0;i<100;i++){try{await readFile(join(h.root,'src/script/kit',first),'utf8');moved=true;break}catch{}await page.waitForTimeout(50)}assert(moved);await assert.rejects(readFile(join(h.root,'src/script/common',first),'utf8'))

 await search.fill('core_timer_seconds.py');const builtin=pane.locator('[role=treeitem]').filter({hasText:'core_timer_seconds.py'});await builtin.click({button:'right'});await page.getByRole('menuitem',{name:'在工程中覆盖',exact:true}).click();await page.keyboard.press('Control+s')
 let content='';for(let i=0;i<100;i++){try{content=await readFile(join(h.root,'src/script/goal/core_timer_seconds.py'),'utf8');break}catch{}await page.waitForTimeout(50)}assert(content.includes('@goal('))
 assert.equal(await pane.locator('[role=treeitem][title="core_timer_seconds.py（只读）"]').count(),0)
 await page.reload();await loginProject(page,h.base,account.credential,'script reopened',false);await page.getByRole('tab',{name:'游戏性',exact:true}).click();await search.fill('shared.py');assert.equal(await pane.locator('[role=treeitem][title="shared.py"]').count(),kinds.length)
 const legacyCode='player.addTag("legacy-preserved")\n'
 await h.commit(owner.token,[{path:'src/gift/脚本提取.kit',content:JSON.stringify({name:'',script:legacyCode})}]);await h.release(owner.token)
 await search.fill('脚本提取.kit');await pane.locator('[role=treeitem][title="脚本提取.kit"]').click();await pane.getByRole('button',{name:'提取为礼包脚本',exact:true}).click()
 await page.keyboard.press('Control+s');let extracted
 for(let i=0;i<100;i++){const doc=JSON.parse(await readFile(join(h.root,'src/gift/脚本提取.kit'),'utf8'));if(typeof doc.script==='object'){extracted=doc.script[0]?.ref;break}await page.waitForTimeout(50)}assert(extracted)
 assert.equal(await readFile(join(h.root,'src/script/kit',extracted+'.py'),'utf8'),legacyCode)
 await search.fill('脚本提取.kit');await pane.locator('[role=treeitem][title="脚本提取.kit"]').click();assert.equal(await pane.locator('.kit-script').first().locator('.kit-script-link').innerText(),extracted+'.py')
 const card=pane.locator('.kit-script').first()
 await card.getByLabel('添加礼包脚本',{exact:true}).click();await card.locator('.kit-script-menu').getByRole('button',{name:'shared.py',exact:true}).click()
 assert.equal(await card.locator('.kit-script-row').count(),2)
 await card.locator('.kit-script-row').nth(1).dragTo(card.locator('.kit-script-row').nth(0))
 assert.equal(await card.locator('.kit-script-link').first().innerText(),'shared.py')
 await page.keyboard.press('Control+s')
 let saved;for(let i=0;i<100;i++){saved=JSON.parse(await readFile(join(h.root,'src/gift/脚本提取.kit'),'utf8'));if(saved.script?.length===2&&saved.script[0].ref==='shared')break;await page.waitForTimeout(50)}assert.deepEqual(saved.script,[{ref:'shared'},{ref:extracted}])
 await card.getByRole('button',{name:'移除脚本 shared',exact:true}).click();assert.equal(await card.locator('.kit-script-row').count(),1)
 await search.fill(first);await pane.locator(`[role=treeitem][title="${first}"]`).dragTo(card)
 assert.equal(await card.locator('.kit-script-row').count(),2,'resource explorer drag binds kit script')
 await page.keyboard.press('Control+s')
 for(let i=0;i<100;i++){saved=JSON.parse(await readFile(join(h.root,'src/gift/脚本提取.kit'),'utf8'));if(saved.script?.length===2&&saved.script[1].ref===first.replace(/\.py$/i,''))break;await page.waitForTimeout(50)}assert.deepEqual(saved.script,[{ref:extracted},{ref:first.replace(/\.py$/i,'')}])
 await pane.locator('.kit-script').first().screenshot({path:'node_modules/.cache/kit-script-reference.png'})
 assert.deepEqual(errors,[])
 console.log('PASS script resources real S: seven same-name types, automatic name avoidance, template creation, save/reopen and builtin override')
}finally{await browser?.close();await h.stop()}
