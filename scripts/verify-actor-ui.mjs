import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject } from './project-ui-helpers.mjs'

const h = await harness({ web: true }); let browser
try {
  const owner = await h.login(h.credential, 'actor setup')
  await h.commit(owner.token, ['guard', 'watch'].map(id => ({ path: `src/script/actor/${id}.py`, content: '@hook("tick")\ndef on_tick(event, blackboard):\n    pass\n' })))
  await h.release(owner.token)
  const account = await h.api(owner.token, '/api/subjects', 'POST', { name: 'actor author', kind: 'account', role: 'editor' })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  await loginProject(page, h.base, account.credential, 'actor author')
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  const pane = page.locator('.app-workspace-pane.active')
  await pane.locator('[role=treeitem][title="演员"]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建演员模板', exact: true }).click()
  await pane.locator('.flow-resource-new input').fill('village')
  await pane.locator('.flow-resource-new input').press('Enter')
  const editor = pane.getByLabel('演员模板编辑器', { exact: true })
  await editor.waitFor()
  await editor.getByLabel('添加演员脚本').selectOption('guard')
  await editor.getByLabel('添加演员脚本').selectOption('watch')
  await editor.getByRole('button', { name: '上移 watch', exact: true }).click()
  await editor.getByRole('checkbox').check()
  await editor.getByLabel('添加演员标签').fill('village')
  await editor.getByLabel('添加演员标签').press('Enter')
  await page.keyboard.press('Control+s')
  const saved = async () => JSON.parse(await readFile(join(h.root, 'src/actors/village.actor'), 'utf8'))
  let doc
  for (let i = 0; i < 100; i++) {
    doc = await saved().catch(() => null)
    if (doc?.scripts?.[0] === 'watch' && doc.tags.includes('village') && doc.freezeAi) break
    await page.waitForTimeout(100)
  }
  assert.deepEqual(doc, { format: 'rpgtoolkit:actor-template', version: 1, scripts: ['watch', 'guard'], tags: ['village'], freezeAi: true })
  await page.reload()
  await loginProject(page, h.base, account.credential, 'actor reopened', false)
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await pane.getByLabel('筛选资源', { exact: true }).fill('village.actor')
  await pane.locator('[role=treeitem][title="village.actor"]').click()
  await pane.getByLabel('演员模板编辑器', { exact: true }).waitFor()
  assert(await pane.getByRole('checkbox').isChecked())
  await h.api(owner.token, `/api/subjects/${account.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  for (let i = 0; i < 100 && !await pane.getByLabel('添加演员脚本').isDisabled(); i++) await page.waitForTimeout(100)
  assert(await pane.getByLabel('添加演员脚本').isDisabled())
  assert(await pane.getByRole('checkbox').isDisabled())
  assert(await pane.getByRole('button', { name: '移除 guard', exact: true }).isDisabled())
  assert.deepEqual(errors, [])
  console.log('PASS actor UI: create/rename, ordered type-scoped script selection, tags, freezeAi, save/reopen and viewer controls')
} finally { await browser?.close(); await h.stop() }
