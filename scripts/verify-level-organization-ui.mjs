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
    { path: 'src/level/hub.level', content: JSON.stringify({ tags: [], regions: [], landmarks: [], custom_data: {} }) },
    { path: 'src/navigator/camp.nav', content: JSON.stringify({ id: 'camp', level: 'hub', track: { type: 'landmark', ref: 'hub$gate' } }) },
  ])
  const account = await h.api(owner.token, '/api/subjects', 'POST', { name: 'Map editor', kind: 'account', role: 'editor' })
  await h.release(owner.token)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
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
  await expand('地图 WIP')
  await expand('地图模板')
  await row('hub.level').click()
  const canvas = page.getByLabel('三维体积视图')
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  assert.ok(box && box.width > 200 && box.height > 120, `地图画布没有可用尺寸：${JSON.stringify(box)}`)
  const selectTool = async (name) => {
    await page.getByRole('button', { name, exact: true }).click()
    await page.locator('.level-tools button.is-active', { hasText: name }).waitFor()
  }
  await selectTool('矩形')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.62, { steps: 12 })
  await page.mouse.up()
  await page.getByRole('button', { name: /^region/ }).waitFor()
  await selectTool('地标')
  await canvas.click({ position: { x: box.width * 0.22, y: box.height * 0.24 } })
  await page.getByLabel('地标 y').fill('72')
  await page.getByLabel('名称文本键').fill('旧塔')
  await page.getByLabel('地标 y').waitFor()
  const savedLevel = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/commit' && response.request().method() === 'POST')
  await page.keyboard.press('Control+s')
  assert.equal((await (await savedLevel).json()).status, 'committed')
  let level
  for (let attempt = 0; attempt < 50; attempt += 1) {
    level = JSON.parse(await readFile(join(h.root, 'src/level/hub.level'), 'utf8'))
    if (level.landmarks?.[0]?.param?.y === 72) break
    await page.waitForTimeout(100)
  }
  assert.equal(level.regions.length, 1)
  assert.equal(level.regions[0].areas[0].y, 'all')
  assert.ok(level.regions[0].areas[0].x[1] > level.regions[0].areas[0].x[0])
  assert.equal(level.landmarks[0].kind, 'rpgtoolkit:pos')
  assert.equal(level.landmarks[0].param.y, 72)
  assert.equal(Number.isInteger(level.landmarks[0].param.x) && Number.isInteger(level.landmarks[0].param.z), true)
  assert.equal(level.landmarks[0].custom_data['rpgtoolkit:display_name'], '旧塔')
  assert.equal(level.navigation, undefined)
  await expand('导航器')
  await row('camp.nav').click()
  await page.getByLabel('追踪的地标').waitFor()
  const preview = await page.locator('.nav-preview').innerText()
  assert.match(preview, /hub\$gate/)
  assert.doesNotMatch(preview, /"param"|"x"\s*:/)
  assert.match(await page.locator('.nav-hint').innerText(), /不能在这里写坐标/)
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
  await expand('地图 WIP')
  await expand('地图模板')
  await row('地图整理').waitFor()
  await row('hub.level').click()
  assert.deepEqual(errors, [])
  console.log('PASS map organization: document selection, fixed groups, persisted custom folder and project reopen')
} finally {
  await browser?.close()
  await h.stop()
}
