import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { login, active, until } from './progress-collaboration-helpers.mjs'

const h = await harness(true)
let browser
try {
  const owner = await h.login(h.credential, '工程清单验收')
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await login(page, h.base, h.credential, '清单查看窗口')
  const rename = name => h.commit(owner.token, [{ path: 'project.json', content: JSON.stringify({ version: 1, id: 'shared-test-project', name }) }]).finally(() => h.release(owner.token))
  await rename('远端修改后的工程名')
  await until(async () => await page.locator('.collab-widget').getAttribute('data-project-name') === '远端修改后的工程名', 'Remote project manifest did not reconcile', 4000)
  await until(async () => (await active(page).getByTitle('双击重命名；可拖入文件到包内 assets/', { exact: true }).innerText()).includes('远端修改后的工程名'), 'Resource tree did not reconcile project name')
  console.log('通过：project.json 的远端工程名同步到工程栏与资源树')

  page.once('dialog', dialog => dialog.accept('本地未保存的工程名'))
  await active(page).getByTitle('双击重命名；可拖入文件到包内 assets/', { exact: true }).dblclick()
  const refresh = page.waitForResponse(response => response.url().endsWith('/api/files') && response.ok())
  await rename('远端再次修改的工程名')
  await refresh
  assert.ok((await active(page).getByTitle('双击重命名；可拖入文件到包内 assets/', { exact: true }).innerText()).includes('本地未保存的工程名'))
  const saved = page.waitForResponse(response => response.url().endsWith('/api/files/commit') && response.request().method() === 'POST')
  await page.keyboard.press('Control+s')
  const receipt = await (await saved).json()
  assert.equal(receipt.status, 'rejected'); assert.equal(receipt.error.code, 'conflict')
  assert.equal((await h.api(owner.token, '/api/files/content?path=project.json')).content, Buffer.from(JSON.stringify({ version: 1, id: 'shared-test-project', name: '远端再次修改的工程名' })).toString('base64'))
  assert.deepEqual(errors, [])
  console.log('通过：本地工程名草稿不会被远端刷新覆盖，旧版本保存被S拒绝')
} finally { await browser?.close(); await h.stop() }
