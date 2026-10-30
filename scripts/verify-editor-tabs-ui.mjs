import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject } from './project-ui-helpers.mjs'

const h = await harness({ web: true }); let browser
try {
  const owner = await h.login(h.credential, 'tabs setup')
  await h.commit(owner.token, [
    { path: 'src/actors/guard.actor', content: JSON.stringify({ format: 'rpgtoolkit:actor-template', version: 1, scripts: [], tags: [], freezeAi: false }) },
    { path: 'src/gift/reward.kit', content: '{}' },
  ])
  await h.release(owner.token)
  const account = await h.api(owner.token, '/api/subjects', 'POST', { name: 'tabs author', kind: 'account', role: 'editor' })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await loginProject(page, h.base, account.credential, 'tabs author')
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  const pane = page.locator('.app-workspace-pane.active')
  const tab = name => pane.locator('.editor-dock').getByRole('tab', { name, exact: true })
  const open = async name => { await pane.getByLabel('筛选资源', { exact: true }).fill(name); await pane.locator(`[role=treeitem][title="${name}"]`).click(); await tab(name).waitFor() }
  const menu = page.getByRole('menu', { name: '页签操作', exact: true })
  const context = async name => { await tab(name).click({ button: 'right' }); await menu.waitFor() }
  const action = async name => { await menu.getByRole('menuitem', { name, exact: true }).click() }
  for (const name of ['example.quest', 'example.py', 'guard.actor', 'reward.kit']) await open(name)
  await tab('example.py').locator('.flow-page-tab-name').click()
  await pane.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+a'); await page.keyboard.insertText('# retained unsaved draft\nvalue = 42\n')
  await tab('reward.kit').locator('.flow-page-tab-name').click()
  for (const [name, icon] of [['example.quest', 'progress'], ['example.py', 'python'], ['guard.actor', 'actor'], ['reward.kit', 'kit']]) assert.equal(await tab(name).locator(`svg.is-${icon}`).count(), 1)
  await context('example.py')
  assert.equal(await tab('reward.kit').getAttribute('aria-selected'), 'true', 'right click must not activate its target')
  assert.equal(await menu.getByRole('menuitem', { name: '删除', exact: true }).count(), 0)
  await action('固定此页')
  assert(await tab('example.py').getByRole('button', { name: '关闭 example.py' }).isDisabled())
  await context('guard.actor'); await action('关闭其他页（当前分栏）')
  assert.equal(await tab('example.quest').count(), 0); assert.equal(await tab('reward.kit').count(), 0)
  assert.equal(await tab('example.py').count(), 1); assert.equal(await tab('guard.actor').count(), 1)
  await context('guard.actor'); await action('移动与分栏'); await page.getByRole('menuitem', { name: '移动到右侧新分栏', exact: true }).click()
  assert.equal(await pane.locator('.editor-dock-leaf').count(), 2)
  assert.equal(await tab('guard.actor').count(), 1, 'moving never duplicates a document')
  await open('reward.kit')
  await context('guard.actor'); await action('关闭未固定页（当前分栏）')
  assert.equal(await tab('guard.actor').count(), 0); assert.equal(await tab('reward.kit').count(), 0)
  assert.equal(await tab('example.py').count(), 1, 'closing a group must preserve another group')
  assert.equal(await pane.locator('.editor-dock-leaf').count(), 1)
  await open('guard.actor')
  await context('guard.actor'); await action('移动与分栏'); await page.getByRole('menuitem', { name: '浮动此页', exact: true }).click()
  assert.equal(await pane.locator('.editor-dock-leaf.is-float').count(), 1)
  await context('guard.actor'); await action('移动与分栏'); await page.getByRole('menuitem', { name: '合并所有分栏到编辑区', exact: true }).click()
  assert.equal(await pane.locator('.editor-dock-leaf').count(), 1); assert.equal(await pane.locator('.editor-dock-leaf.is-float').count(), 0)
  assert.equal(await tab('example.py').count(), 1)
  await context('guard.actor'); await action('移动与分栏'); await page.getByRole('menuitem', { name: '移动到右侧新分栏', exact: true }).click()
  await context('guard.actor'); await action('移动与分栏'); await page.getByRole('menuitem', { name: /^移至分栏/ }).click()
  assert.equal(await pane.locator('.editor-dock-leaf').count(), 1)
  assert.equal(await tab('guard.actor').count(), 1)
  await page.reload(); await loginProject(page, h.base, account.credential, 'tabs reopened', false)
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  assert(await tab('example.py').getByRole('button', { name: '关闭 example.py' }).isDisabled())
  await tab('example.py').locator('.flow-page-tab-name').focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor()
  await action('取消固定')
  await context('example.py'); await action('关闭此页'); assert.equal(await tab('example.py').count(), 0)
  await open('example.py')
  assert.equal(await tab('example.py').locator('svg.is-python').count(), 1)
  await page.waitForFunction(() => /retained\s+unsaved\s+draft/.test(document.querySelector('.app-workspace-pane.active .monaco-editor')?.textContent ?? ''))
  assert.match(await pane.locator('.monaco-editor').first().textContent(), /retained\s+unsaved\s+draft/)
  assert.equal(await readFile(join(h.root, 'src/script/common/example.py'), 'utf8'), h.fixtures['src/script/common/example.py'], 'closing tabs never deletes or silently saves the source')
  await h.api(owner.token, `/api/subjects/${account.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  await context('example.py'); await action('固定此页'); await context('guard.actor'); await action('关闭此页')
  assert.equal(await tab('example.py').count(), 1, 'viewer retains local tab/layout operations')
  assert.deepEqual(errors, [])
  console.log('PASS gameplay tabs: type icons, non-active context target, pin persistence, group-scoped closes, split/move/float/merge, keyboard menu and viewer layout operations')
} finally { await browser?.close(); await h.stop() }
