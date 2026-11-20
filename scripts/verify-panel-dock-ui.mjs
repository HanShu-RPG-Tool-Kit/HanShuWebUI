import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject, waitProject } from './project-ui-helpers.mjs'

const h = await harness(true)
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await loginProject(page, h.base, h.credential, 'dock integration')
  await page.getByRole('tab', { name: '剧本', exact: true }).click()
  const root = page.locator('.stageplay-workspace')
  await root.locator('.panel-dock.is-measured').waitFor()
  const menu = async (name, item) => {
    await page.getByRole('button', { name, exact: true }).click()
    await page.getByRole('menu', { name, exact: true }).locator('[role^="menuitem"]').filter({ hasText: new RegExp(`^${item}$`) }).click()
  }
  await root.getByText('story.hs', { exact: true }).first().click()
  await root.locator('.monaco-editor').first().waitFor()
  await menu('查看', '资源管理器')
  assert.equal(await root.locator('.stageplay-explorer').isVisible(), false)
  await menu('查看', '资源管理器')
  assert.equal(await root.locator('.stageplay-explorer').isVisible(), true)
  await menu('查看', '录音棚')
  assert.equal(await root.getByRole('region', { name: '录音棚', exact: true }).isVisible(), true)
  await menu('查看', '录音棚')
  console.log('PASS view menu toggles Explorer and Recording Studio')

  const header = root.locator('.stageplay-explorer .explorer-shell-heading')
  const from = await header.boundingBox()
  const dock = await root.locator('.panel-dock').boundingBox()
  await page.mouse.move(from.x + 45, from.y + 12)
  await page.mouse.down()
  await page.mouse.move(dock.x + dock.width * 0.6, dock.y + dock.height * 0.55, { steps: 14 })
  await page.mouse.up()
  await root.locator('.panel-dock-band.is-float .stageplay-explorer').waitFor()
  const saved = await page.evaluate(() => localStorage.getItem('hanshu.panelDock'))
  assert.equal(JSON.parse(saved).panels.explorer.placement, 'float')
  await page.reload()
  await waitProject(page, '统一工程验收')
  await page.getByRole('tab', { name: '剧本', exact: true }).click()
  await root.locator('.panel-dock-band.is-float .stageplay-explorer').waitFor()
  await root.locator('.stageplay-explorer .explorer-shell-heading').getByRole('button', { name: '停靠', exact: true }).click()
  await root.locator('.panel-dock-band:not(.is-float) .stageplay-explorer').waitFor()
  console.log('PASS drag to float, reload persistence, and redock')

  const agentInput = root.locator('.agent-panel textarea')
  await agentInput.fill('停靠后保留的 Agent 草稿')
  const explorerHeader = await root.locator('.stageplay-explorer .explorer-shell-heading').boundingBox()
  const agent = await root.locator('[data-panel-id="agent"]').boundingBox()
  await page.mouse.move(explorerHeader.x + 45, explorerHeader.y + 12)
  await page.mouse.down()
  await page.mouse.move(agent.x + agent.width / 2, agent.y + agent.height / 2, { steps: 14 })
  await page.mouse.up()
  const tabs = root.locator('[data-dock-tabs]')
  await tabs.getByRole('tab', { name: 'Agent', exact: true }).waitFor()
  await tabs.getByRole('tab', { name: 'Agent', exact: true }).click()
  assert.equal(await agentInput.inputValue(), '停靠后保留的 Agent 草稿')
  await menu('查看', '资源管理器')
  assert.equal(await root.locator('.stageplay-explorer').isVisible(), false)
  assert.equal(await agentInput.isVisible(), true)
  await menu('查看', '资源管理器')
  console.log('PASS tab grouping, panel state preservation, and hiding an inactive tab')

  await menu('查看', '编辑器布局')
  const dialog = page.getByRole('dialog', { name: '编辑器布局', exact: true })
  await dialog.waitFor()
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true)
  await dialog.getByRole('button', { name: '恢复', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await root.locator('.stageplay-explorer').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
    console.log('RESET STATE', await page.evaluate(() => ({
      layout: localStorage.getItem('hanshu.panelDock'),
      view: localStorage.getItem('hanshu.view.script'),
      explorer: document.querySelector('[data-panel-id="explorer"]')?.outerHTML.slice(0, 450),
    })))
    throw error
  })
  console.log('PASS modal keyboard containment and reset layout')

  await menu('查看', '资产管理器')
  const dockRoot = root.locator('.panel-dock').first()
  const assetBand = dockRoot.locator(':scope > .panel-dock-band[data-panel-id="asset-manager"]')
  const assetHeader = assetBand.locator('.stageplay-asset-manager-heading')
  const status = page.getByRole('contentinfo', { name: '状态栏' })
  const workspace = await dockRoot.boundingBox()
  const footer = await status.boundingBox()
  const moveAsset = async (x, y) => {
    const title = await assetHeader.locator('strong').boundingBox()
    await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, y)
  }
  const floatAsset = async () => {
    await moveAsset(workspace.x + workspace.width * 0.62, workspace.y + workspace.height * 0.44)
    await page.mouse.up()
    await assetBand.and(dockRoot.locator('.is-float')).waitFor()
  }
  await floatAsset()
  await moveAsset(footer.x + 24, footer.y + footer.height / 2)
  const preview = dockRoot.locator(':scope > .panel-dock-zones.is-open .panel-dock-zone.is-hot')
  const previewBox = await preview.boundingBox()
  assert.ok(previewBox && Math.abs(previewBox.width - workspace.width) <= 1 && previewBox.height > 100)
  await page.mouse.up()
  await preview.waitFor({ state: 'hidden' })
  const savedDock = () => page.evaluate(() => JSON.parse(localStorage.getItem('hanshu.panelDock')))
  assert.equal((await savedDock()).lanes.bottom[0].fullWidth, true)
  const fullWidthBox = async () => {
    const box = await assetBand.boundingBox()
    assert.ok(box && Math.abs(box.x - workspace.x) <= 1 && Math.abs(box.width - workspace.width) <= 1)
    assert.ok(Math.abs(box.y + box.height - footer.y) <= 1, 'docked panel must sit immediately above the status bar')
    const upper = await dockRoot.locator(':scope > .panel-dock-main').boundingBox()
    assert.ok(upper.y + upper.height <= box.y, 'editor must end above the bottom dock')
    const explorer = await dockRoot.locator(':scope > [data-panel-id="explorer"]').boundingBox()
    assert.ok(explorer.y + explorer.height <= box.y, 'sidebars must end above the bottom dock')
    return box
  }
  const initial = await fullWidthBox()
  assert.ok(Math.abs(initial.height - previewBox.height) <= 1, 'preview height must match the dropped panel')
  const sash = await dockRoot.locator(':scope > [data-dock-sash="lane:bottom:0"]').boundingBox()
  await page.mouse.move(sash.x + sash.width * 0.7, sash.y + sash.height / 2)
  await page.mouse.down()
  await page.mouse.move(sash.x + sash.width * 0.7, sash.y + sash.height / 2 - 72)
  await page.mouse.up()
  const resized = await fullWidthBox()
  assert.ok(resized.height >= initial.height + 70)
  const activity = status.locator('.activity-bell')
  await activity.click()
  assert.equal(await activity.getAttribute('aria-expanded'), 'true')
  await activity.click()
  await page.screenshot({ path: 'node_modules/.cache/panel-dock-ui/full-width-bottom.png' })

  await page.reload()
  await waitProject(page, '统一工程验收')
  await assetHeader.waitFor()
  assert.equal((await fullWidthBox()).height, resized.height)
  await floatAsset()
  await assetHeader.getByRole('button', { name: '停靠', exact: true }).click()
  assert.equal((await savedDock()).lanes.bottom[0].fullWidth, true)
  await fullWidthBox()
  assert.deepEqual(errors, [])
  console.log('PASS quick status bar drop, full-width preview and dock, sash resize, status bar button, reload and redock')
} finally {
  await browser?.close()
  await h.stop()
}
