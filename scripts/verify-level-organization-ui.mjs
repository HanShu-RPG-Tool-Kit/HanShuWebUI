import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject } from './project-ui-helpers.mjs'

const h = await harness({ web: true })
let browser
try {
  const owner = await h.login(h.credential, 'map organization setup')
  await h.commit(owner.token, [
    { path: 'src/level/hub.level', content: JSON.stringify({ tags: [], regions: [], navigation: [], custom_data: {} }) },
    { path: 'src/navigator/camp.nav', content: JSON.stringify({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 0, y: 64, z: 0 }, custom_data: {} }) },
  ])
  const account = await h.api(owner.token, '/api/subjects', 'POST', { name: 'Map editor', kind: 'account', role: 'editor' })
  await h.release(owner.token)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await loginProject(page, h.base, account.credential, 'map editor')
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  const pane = page.locator('.app-workspace-pane.active')
  const row = name => pane.locator('[role=treeitem]').filter({ has: page.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`) })
  const expand = async name => {
    const target = row(name)
    await target.waitFor()
    if (await target.getAttribute('aria-expanded') !== 'true') await target.click()
  }
  await expand('地图')
  await expand('地图模板')
  await row('hub.level').click()
  await expand('导航器')
  await expand('动态导航器')
  await row('camp.nav').click()
  await row('hub.level').click()
  assert.deepEqual(errors, [], 'selecting documents must not serialize fixed map groups as missing folders')
  await row('地图模板').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click()
  const input = page.getByRole('textbox', { name: '新文件夹名称', exact: true })
  await input.fill('地图整理')
  const committed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/commit' && response.request().method() === 'POST')
  await input.press('Enter')
  assert.equal((await (await committed).json()).status, 'committed')
  await row('地图整理').waitFor()
  const org = JSON.parse(await readFile(join(h.root, 'meta/explorer.json'), 'utf8'))
  assert.equal(org.folders.find(folder => folder.name === '地图整理').parentId, 'section:level:templates')
  assert.equal(org.placements['src/navigator/camp.nav'], undefined)
  assert.equal(org.placements['src/level/hub.level'], undefined)
  await page.reload()
  await loginProject(page, h.base, account.credential, 'map editor reopened', false)
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await expand('地图')
  await expand('地图模板')
  await row('地图整理').waitFor()
  await row('hub.level').click()
  assert.deepEqual(errors, [])
  console.log('PASS map organization: document selection, fixed groups, persisted custom folder and project reopen')
} finally {
  await browser?.close()
  await h.stop()
}
