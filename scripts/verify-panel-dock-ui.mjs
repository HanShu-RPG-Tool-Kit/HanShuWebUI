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
  assert.equal(await root.locator('.explorer').isVisible(), false)
  await menu('查看', '资源管理器')
  assert.equal(await root.locator('.explorer').isVisible(), true)
  await menu('查看', '录音棚')
  assert.equal(await root.getByRole('region', { name: '录音棚', exact: true }).isVisible(), true)
  await menu('查看', '录音棚')
  console.log('PASS view menu toggles Explorer and Recording Studio')

  const header = root.locator('.explorer-header')
  const from = await header.boundingBox()
  const dock = await root.locator('.panel-dock').boundingBox()
  await page.mouse.move(from.x + 45, from.y + 12)
  await page.mouse.down()
  await page.mouse.move(dock.x + dock.width * 0.6, dock.y + dock.height * 0.55, { steps: 14 })
  await page.mouse.up()
  await root.locator('.panel-dock-band.is-float .explorer').waitFor()
  const saved = await page.evaluate(() => localStorage.getItem('hanshu.panelDock'))
  assert.equal(JSON.parse(saved).panels.explorer.placement, 'float')
  await page.reload()
  await waitProject(page, '统一工程验收')
  await page.getByRole('tab', { name: '剧本', exact: true }).click()
  await root.locator('.panel-dock-band.is-float .explorer').waitFor()
  await root.locator('.explorer-header').getByRole('button', { name: '停靠', exact: true }).click()
  await root.locator('.panel-dock-band:not(.is-float) .explorer').waitFor()
  console.log('PASS drag to float, reload persistence, and redock')

  const agentInput = root.locator('.agent-panel textarea')
  await agentInput.fill('停靠后保留的 Agent 草稿')
  const explorerHeader = await root.locator('.explorer-header').boundingBox()
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
  assert.equal(await root.locator('.explorer').isVisible(), false)
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
  await root.locator('.explorer').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
    console.log('RESET STATE', await page.evaluate(() => ({
      layout: localStorage.getItem('hanshu.panelDock'),
      view: localStorage.getItem('hanshu.view.script'),
      explorer: document.querySelector('[data-panel-id="explorer"]')?.outerHTML.slice(0, 450),
    })))
    throw error
  })
  assert.deepEqual(errors, [])
  console.log('PASS modal keyboard containment, reset layout, and no page errors')
} finally {
  await browser?.close()
  await h.stop()
}
