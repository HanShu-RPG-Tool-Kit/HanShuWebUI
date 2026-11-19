import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject } from './project-ui-helpers.mjs'
const h = await harness(true)
let browser
try {
 const owner = await h.login(h.credential, 'asset benchmark')
 const editor = await h.api(owner.token, '/api/subjects', 'POST', {name:'Asset editor',kind:'human',role:'editor'})
 await h.commit(owner.token, [{path:'assets/source/probe.ogg',content:'ogg benchmark bytes'}, {path:'assets/target/keep.txt',content:'keep'}])
 await h.release(owner.token)
 browser = await chromium.launch({headless:true, channel:'msedge'})
 console.log('Edge benchmark:', browser.version(), process.platform)
 const page = await browser.newPage({viewport:{width:1600,height:1000}})
 await loginProject(page, h.base, editor.credential, 'assets')
 await page.getByRole('tab',{name:'剧本',exact:true}).click()
 const pane = page.locator('.app-workspace-pane.active')
 if (!await pane.locator('.asset-manager').isVisible()) {
  await page.getByRole('navigation',{name:'主菜单'}).getByRole('button',{name:'查看',exact:true}).click()
  await page.getByRole('menuitemcheckbox',{name:'资产管理器',exact:true}).click()
 }
 const manager = pane.locator('.asset-manager')
 const open = async path => { await manager.locator(`.asset-manager-folder-row button[title="${path}"]`).click() }
 const row = path => manager.locator(`.asset-manager-entry[data-asset-path="${path}"]`)
 const menu = async (locator, label) => { await locator.click({button:'right'}); await page.getByRole('menuitem',{name:label,exact:true}).click() }
 await open('assets/source')
 await row('assets/source/probe.ogg').waitFor()
 await menu(row('assets/source/probe.ogg'), '复制')
 await open('assets/target')
 await manager.getByRole('button',{name:'粘贴',exact:true}).click()
 await row('assets/target/probe.ogg').waitFor()
 assert.equal(await readFile(join(h.root,'assets/target/probe.ogg'),'utf8'), 'ogg benchmark bytes')
 // Same-name copy must preserve the original.
 await manager.getByRole('button',{name:'粘贴',exact:true}).click()
 await row('assets/target/probe (1).ogg').waitFor()
 await menu(row('assets/target/probe (1).ogg'), '剪切')
 await open('assets/source')
 await manager.getByRole('button',{name:'粘贴',exact:true}).click()
 await row('assets/source/probe (1).ogg').waitFor()
 await assert.rejects(readFile(join(h.root,'assets/target/probe (1).ogg')))
 // Real Edge keyboard clipboard round-trip within the asset panel.
 await row('assets/source/probe.ogg').click()
 await manager.focus()
 await page.keyboard.press('Control+c')
 await open('assets/target')
 await manager.focus()
 await page.keyboard.press('Control+v')
 await row('assets/target/probe (1).ogg').waitFor()
 assert.equal(await readFile(join(h.root,'assets/target/probe (1).ogg'),'utf8'), 'ogg benchmark bytes')
 await open('assets/source')
 // Browser download preserves bytes/name.
 const downloadEvent = page.waitForEvent('download')
 await menu(row('assets/source/probe.ogg'), '下载')
 const download = await downloadEvent
 assert.equal(download.suggestedFilename(), 'probe.ogg')
 assert.equal(await readFile(await download.path(),'utf8'), 'ogg benchmark bytes')
 // External file paste must import actual bytes through S.
 await manager.evaluate(element => {
  const clipboardData = new DataTransfer(); clipboardData.items.add(new File(['pasted bytes'],'external.txt',{type:'text/plain'}));
  element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
 })
 await row('assets/source/external.txt').waitFor()
 assert.equal(await readFile(join(h.root,'assets/source/external.txt'),'utf8'), 'pasted bytes')
 // Folder copy, preserving relative paths.
 await open('assets')
 await menu(row('assets/source'), '复制')
 await open('assets/target')
 await manager.getByRole('button',{name:'粘贴',exact:true}).click()
 await row('assets/target/source').waitFor()
 assert.equal(await readFile(join(h.root,'assets/target/source/probe.ogg'),'utf8'), 'ogg benchmark bytes')
 await menu(row('assets/target/source'), '剪切')
 await open('assets')
 await manager.getByRole('button',{name:'粘贴',exact:true}).click()
 await row('assets/source (1)').waitFor()
 assert.equal(await readFile(join(h.root,'assets/source (1)/probe.ogg'),'utf8'), 'ogg benchmark bytes')
 await assert.rejects(readFile(join(h.root,'assets/target/source/probe.ogg')))
 console.log('PASS Edge asset copy/cut/collision/folder/download/paste with real S persistence')
} finally { await browser?.close(); await h.stop() }


