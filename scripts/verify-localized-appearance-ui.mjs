import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {chromium} from 'playwright'
import {harness} from './collaboration-harness.mjs'
import {loginProject} from './project-ui-helpers.mjs'
const h=await harness({web:true});let browser
const entity=CustomName=>JSON.stringify({format:'rpgtoolkit:entity-template',version:1,dataFormat:'tnbt-json-v1',tags:[],entity:{id:'minecraft:zombie',data:{type:'compound',value:{CustomName}}}})
try{
 const owner=await h.login(h.credential,'localization setup'),account=await h.api(owner.token,'/api/subjects','POST',{name:'localization author',kind:'account',role:'editor'})
 await h.commit(owner.token,[{path:'src/entities/fixed.entity',content:entity({type:'string',value:'原始名称'})},{path:'assets/zh_cn/lang_entity/fixed.lang',content:'[]'},{path:'src/entities/vanilla.entity',content:entity({type:'compound',value:{translate:{type:'string',value:'item.minecraft.diamond'}}})}]);await h.release(owner.token)
 browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})})
 const page=await browser.newPage({viewport:{width:1500,height:1000}});await loginProject(page,h.base,account.credential,'localization author');await page.getByRole('tab',{name:'进度流程',exact:true}).click()
 const pane=page.locator('.app-workspace-pane.active'),search=pane.getByLabel('筛选资源',{exact:true})
 await search.fill('fixed.entity');await pane.locator('[role=treeitem][title="fixed.entity"]').click()
 await pane.getByRole('button',{name:'重试读取译文',exact:true}).waitFor()
 await pane.getByRole('button',{name:'重试读取译文',exact:true}).click()
 await pane.getByRole('button',{name:'重试读取译文',exact:true}).waitFor()
 const name=pane.getByRole('textbox',{name:'实体名称（CustomName）',exact:true})
 assert.equal(await name.getAttribute('contenteditable'),'true','failed locale read must not disable literal input')
 await name.fill('仍可编辑');await page.keyboard.press('Control+s')
 let saved;for(let i=0;i<100;i++){saved=JSON.parse(await readFile(join(h.root,'src/entities/fixed.entity'),'utf8'));if(JSON.stringify(saved).includes('仍可编辑'))break;await page.waitForTimeout(50)}assert(JSON.stringify(saved).includes('仍可编辑'));assert.equal(await readFile(join(h.root,'assets/zh_cn/lang_entity/fixed.lang'),'utf8'),'[]')
 await h.commit(owner.token,[{path:'assets/zh_cn/lang_entity/fixed.lang',content:'{}'}]);await h.release(owner.token)
 await page.waitForFunction(()=>!document.querySelector('.app-workspace-pane.active .localized-text-controls [role=alert]'))
 await pane.getByLabel('实体名称（CustomName） 文本来源',{exact:true}).selectOption('localized')
 await page.waitForFunction(()=>document.querySelector('.app-workspace-pane.active .localized-text-controls select')?.value==='localized')
 await page.keyboard.press('Control+s')
 for(let i=0;i<100;i++){saved=JSON.parse(await readFile(join(h.root,'src/entities/fixed.entity'),'utf8'));if(JSON.stringify(saved).includes('hanshu.entity.'))break;await page.waitForTimeout(50)}assert(JSON.stringify(saved).includes('hanshu.entity.'))
 await search.fill('vanilla.entity');await pane.locator('[role=treeitem][title="vanilla.entity"]').click()
 assert.equal(await pane.getByLabel('实体名称（CustomName） 文本来源',{exact:true}).inputValue(),'advanced')
 assert.equal(await pane.getByRole('status').filter({hasText:'Minecraft 翻译键（只读）'}).count(),1)
 assert.equal(await pane.getByRole('textbox',{name:'实体名称（CustomName）',exact:true}).count(),0)
 console.log('PASS real S localization UI: failed language read leaves literal editable, language asset preserved, retry restores binding, vanilla translation stays read-only')
}finally{await browser?.close();await h.stop()}
