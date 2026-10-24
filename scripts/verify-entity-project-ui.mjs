import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {harness} from './collaboration-harness.mjs'
import {loginProject} from './project-ui-helpers.mjs'
const h=await harness({web:true});let browser
try{
 const owner=await h.login(h.credential,'entity test setup'),account=await h.api(owner.token,'/api/subjects','POST',{name:'entity author',kind:'account',role:'editor'})
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});const page=await browser.newPage({viewport:{width:1500,height:1100}})
 await loginProject(page,h.base,account.credential,'entity author');await page.getByRole('tab',{name:'进度流程',exact:true}).click()
 const pane=page.locator('.app-workspace-pane.active');await pane.locator('[role=treeitem][title="实体库"]').click({button:'right'});await page.getByRole('menuitem',{name:'新建实体',exact:true}).click()
 await pane.locator('.flow-resource-new input').fill('卫兵.entity');await pane.locator('.flow-resource-new input').press('Enter')
 await pane.getByLabel('实体类型',{exact:true}).waitFor();await pane.getByLabel('实体名称',{exact:true}).fill('卫兵');await pane.getByRole('switch',{name:'无敌',exact:true}).check()
 await page.keyboard.press('Control+s')
 const path=join(h.root,'src/entities/卫兵.entity');let doc
 for(let i=0;i<100;i++){try{doc=JSON.parse(await readFile(path,'utf8'));if(doc.entity.data.value.CustomName?.value==='卫兵')break}catch{}await page.waitForTimeout(100)}
 assert.equal(doc?.entity.data.value.CustomName.value,'卫兵');assert.equal(doc?.entity.data.value.Invulnerable.value,1)
 await page.reload();await loginProject(page,h.base,account.credential,'entity reopened',false);await page.getByRole('tab',{name:'进度流程',exact:true}).click();await pane.getByLabel('筛选资源',{exact:true}).fill('卫兵.entity');await pane.locator('[role=treeitem][title="卫兵.entity"]').click();assert.equal(await pane.getByLabel('实体名称',{exact:true}).inputValue(),'卫兵')
 await pane.getByLabel('筛选资源',{exact:true}).fill('实体库表视图');await pane.locator('[role=treeitem]').filter({hasText:'实体库表视图'}).dblclick();await pane.getByLabel('实体库网格表',{exact:true}).waitFor()
 assert.equal(await pane.locator('.entity-library-tile').count(),1);await pane.getByRole('button',{name:'打开实体 卫兵.entity',exact:true}).click();assert.equal(await pane.getByLabel('实体名称',{exact:true}).inputValue(),'卫兵')
 await h.api(owner.token,`/api/subjects/${account.subject.id}`,'PATCH',{role:'viewer',enabled:true})
 for(let i=0;i<100&&!await pane.getByLabel('实体名称',{exact:true}).isDisabled();i++)await page.waitForTimeout(100)
 assert(await pane.getByLabel('实体名称',{exact:true}).isDisabled())
 console.log('PASS entity project: explorer creation, authoritative save to src/entities, reopen and viewer restriction')
}finally{await browser?.close();await h.stop()}
