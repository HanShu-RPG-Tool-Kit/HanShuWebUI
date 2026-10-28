import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, appType: 'custom' })
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/kit-editor-check') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root" class="flow-kit-pane"></div></body></html>'))
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/kit-editor-check`)
  await page.evaluate(async () => {
    await import('/src/index.css')
    await import('/src/App.css')
    const reactModule = await import('/node_modules/.vite/deps/react.js')
    const React = reactModule.default ?? reactModule
    const domModule = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { createRoot } = domModule.default ?? domModule
    const { KitEditor } = await import('/src/workspaces/gameplay/KitEditor.tsx')
    const { createKit, parseKit, readKitSource } = await import('/src/workspaces/gameplay/kit.ts')
    const root = createRoot(document.getElementById('root'))
    window.changes = []
    window.renderKit = source => {
      const state = source === undefined ? { kit: createKit(), error: '' } : readKitSource(source)
      root.render(React.createElement(KitEditor, {
        ...state,
        onChange: next => { window.changes.push(next); window.renderKit(next) },
      }))
    }
    window.renderKit()
    window.parseKit = parseKit
  })
  await page.locator('.kit-editor').waitFor()
  assert.equal(await page.locator('.kit-compose-bar, .kit-flatten-chain').count(), 0)
  assert.equal(await page.getByLabel('继承父礼包', { exact: true }).count(), 0)
  await page.getByLabel('添加礼包标签', { exact: true }).fill('daily')
  await page.getByLabel('添加礼包标签', { exact: true }).press('Enter')
  await page.waitForFunction(() => window.changes.length > 0)
  const saved = await page.evaluate(() => JSON.parse(window.changes.at(-1)))
  assert.deepEqual(saved.tags, ['daily'])
  assert.equal('extends' in saved, false)
  assert.equal('includes' in saved, false)
  await mkdir('output/kit-editor', { recursive: true })
  await page.screenshot({ path: 'output/kit-editor/standalone.png', fullPage: true })
  for (const fields of [{ extends: 'base' }, { includes: ['extra'] }]) {
    await page.evaluate(fields => window.renderKit(JSON.stringify(fields)), fields)
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').textContent(), /暂停编辑并保留原文/)
    assert.equal(await page.getByLabel('添加礼包标签', { exact: true }).isDisabled(), true)
  }
  assert.deepEqual(errors, [])
  console.log('PASS standalone kit editor: tags save, removed controls, compiled preview, invalid legacy source fenced')
} finally {
  await browser?.close()
  await server.close()
}
