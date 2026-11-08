import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  appType: 'custom',
  plugins: [{
    name: 'level-custom-ui-dependencies',
    resolveId(id) { if (id === '/level-custom-ui-deps.js') return id },
    load(id) {
      if (id === '/level-custom-ui-deps.js') {
        return "export { default as React } from 'react'; export { createRoot } from 'react-dom/client'"
      }
    },
  }],
})
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/level-custom-check') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><body><div id="root"></div>
<style>html, body, #root { margin: 0; height: 760px; } #root { display: flex; } #root > .level-editor { flex: 1; min-height: 0; }</style>
</body></html>`))
})

let browser
let page
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/level-custom-check`)
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/level-custom-ui-deps.js')
    const { LevelEditor } = await import('/src/workspaces/gameplay/LevelEditor.tsx')
    const root = createRoot(document.getElementById('root'))
    const initialLevel = {
      tags: [],
      custom_data: {},
      regions: [{
        id: 'yard',
        areas: [{ kind: 'rect', x: [0, 4], z: [0, 4], y: 'all' }],
        custom_data: {
          acceptance: 'preserve-region-extra',
          priority: 3,
          enabled: true,
          nested: { keep: ['a', 2] },
        },
      }],
      landmarks: [{
        id: 'tower',
        kind: 'rpgtoolkit:pos',
        param: { x: 1, y: 2, z: 3 },
        custom_data: { 'rpgtoolkit:display_name': '塔', extra: { note: 'x' } },
      }],
    }
    window.changes = []
    window.pending = false
    window.guard = null
    window.renderLevel = (disabled = false) => {
      root.render(React.createElement(LevelEditor, {
        doc: initialLevel,
        disabled,
        identity: { projectId: 'project-custom-ui', clientId: 'client-custom-ui', resourceId: 'source:src/level/hub.level' },
        onChange: (next) => { window.changes.push(next) },
        onPendingChange: (pending) => { window.pending = pending },
        onSaveGuardReady: (guard) => { window.guard = guard },
      }))
    }
    window.renderLevel(false)
  })

  const customOf = () => page.evaluate(() => {
    const text = window.changes.at(-1)
    return text ? JSON.parse(text).regions.find((item) => item.id === 'yard').custom_data : null
  })
  const changeCount = () => page.evaluate(() => window.changes.length)
  const group = page.getByRole('region', { name: '自定义数据' }).or(page.locator('section[aria-label="自定义数据"]'))
  const openExtensions = async () => {
    const details = page.locator('.level-extension-data')
    if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click()
  }

  await page.locator('.level-tree-row').filter({ hasText: 'yard' }).getByRole('button').last().click()
  await page.locator('section[aria-label="自定义数据"]').waitFor({ state: 'attached' })
  assert.equal(await page.locator('.level-extension-data').evaluate(node => node.open), false)
  assert.equal(await page.getByRole('textbox', { name: 'acceptance', exact: true }).isVisible(), false, '未定义的测试字段不能冒充普通属性')
  await openExtensions()
  assert.equal(errors.length, 0, errors.join('\n'))
  assert.equal(await page.locator('section[aria-label="自定义数据"]').innerText().then((text) => text.includes('在高级 JSON 里改')), false)
  assert.equal(await page.locator('details.level-custom-json').evaluate((node) => node.open), false)
  const nestedDetails = page.locator('details.level-custom-node').filter({ has: page.locator('.level-custom-key', { hasText: /^nested$/ }) })
  assert.equal(await nestedDetails.evaluate((node) => node.open), false)
  assert.equal(await page.getByRole('textbox', { name: 'nested.keep[0]', exact: true }).isVisible(), false)
  const nestedSummary = await page.locator('.level-custom-key', { hasText: /^nested$/ }).locator('xpath=..').innerText()
  assert.match(nestedSummary, /keep/)
  assert.match(nestedSummary, /对象/)

  await page.locator('.level-custom-key', { hasText: /^nested$/ }).click()
  await page.locator('.level-custom-key', { hasText: /^keep$/ }).click()
  const keep0 = page.getByRole('textbox', { name: 'nested.keep[0]', exact: true })
  const keep1 = page.getByRole('textbox', { name: 'nested.keep[1]', exact: true })
  await keep0.waitFor()
  assert.equal(await keep0.inputValue(), 'a')
  assert.equal(await keep1.inputValue(), '2')
  assert.equal(await page.getByRole('switch', { name: 'enabled' }).getAttribute('aria-checked'), 'true')

  await keep0.fill('b')
  await keep0.blur()
  await page.waitForFunction(() => window.changes.length === 1)
  let custom = await customOf()
  assert.equal(custom.nested.keep[0], 'b')
  assert.equal(custom.nested.keep[1], 2)
  assert.equal(typeof custom.nested.keep[1], 'number')
  assert.equal(custom.acceptance, 'preserve-region-extra')
  assert.equal(custom.priority, 3)
  assert.equal(custom.enabled, true)

  const beforePartial = await changeCount()
  await keep1.fill('2.')
  await page.waitForFunction(() => window.pending === true)
  assert.equal(await keep1.inputValue(), '2.')
  const partialGuard = await page.evaluate(() => window.guard())
  assert.equal(partialGuard.ok, false)
  assert.match(partialGuard.message, /数字未完成/)
  assert.equal(await changeCount(), beforePartial)
  assert.equal(await keep1.inputValue(), '2.')

  await keep1.fill('9')
  await keep1.blur()
  await page.waitForFunction((count) => window.changes.length === count, beforePartial + 1)
  custom = await customOf()
  assert.equal(custom.nested.keep[0], 'b')
  assert.equal(custom.nested.keep[1], 9)
  assert.equal(typeof custom.nested.keep[1], 'number')

  await page.getByRole('button', { name: '撤销地图编辑' }).click()
  await page.waitForFunction((count) => window.changes.length === count, beforePartial + 2)
  custom = await customOf()
  assert.equal(custom.nested.keep[0], 'b')
  assert.equal(custom.nested.keep[1], 2)
  assert.equal(typeof custom.nested.keep[1], 'number')

  await openExtensions()
  await page.locator('.level-custom-key', { hasText: /^nested$/ }).click()
  await page.locator('.level-custom-key', { hasText: /^keep$/ }).click()
  const beforeKey = await changeCount()
  await page.getByLabel('新键名', { exact: true }).fill('extra')
  await page.waitForFunction(() => window.pending === true)
  const keyGuard = await page.evaluate(() => window.guard())
  assert.equal(keyGuard.ok, false)
  assert.match(keyGuard.message, /新键尚未添加/)
  assert.equal(await changeCount(), beforeKey)
  await page.getByRole('button', { name: '放弃新键', exact: true }).click()
  await page.waitForFunction(() => window.pending === false)
  assert.equal(await page.getByLabel('新键名', { exact: true }).inputValue(), '')
  assert.equal(await changeCount(), beforeKey)

  await page.getByLabel('新键名', { exact: true }).fill('extra')
  await page.getByLabel('新键值', { exact: true }).fill('z')
  await page.waitForFunction(() => window.pending === true)
  const flushed = await page.evaluate(() => window.guard())
  assert.equal(flushed.ok, true)
  await page.waitForFunction((count) => window.changes.length === count, beforeKey + 1)
  custom = await customOf()
  assert.equal(custom.extra, 'z')
  assert.equal(custom.nested.keep[0], 'b')
  assert.equal(custom.priority, 3)

  await openExtensions()
  await page.locator('.level-custom-key', { hasText: /^nested$/ }).click()
  await page.locator('details.level-custom-json > summary').click()
  const beforeJson = await changeCount()
  await page.getByLabel('custom_data').fill('{')
  await page.waitForFunction(() => window.pending === true)
  const invalidGuard = await page.evaluate(() => window.guard())
  assert.equal(invalidGuard.ok, false)
  assert.equal(await page.getByRole('button', { name: '应用' }).isDisabled(), true)
  assert.equal(await page.getByLabel('custom_data').inputValue(), '{')
  assert.equal(await changeCount(), beforeJson)
  await page.getByRole('button', { name: '取消' }).click()
  await page.waitForFunction(() => window.pending === false)
  assert.match(await page.getByLabel('custom_data').inputValue(), /preserve-region-extra/)

  const applied = {
    acceptance: 'from-json',
    priority: 3,
    enabled: true,
    nested: { keep: ['b', 2] },
    extra: 'z',
    note: null,
  }
  await page.getByLabel('custom_data').fill(JSON.stringify(applied))
  await page.getByRole('button', { name: '应用' }).click()
  await page.waitForFunction((count) => window.changes.length === count, beforeJson + 1)
  custom = await customOf()
  assert.equal(custom.acceptance, 'from-json')
  assert.equal(custom.note, null)
  assert.equal(custom.priority, 3)
  assert.equal(typeof custom.priority, 'number')
  assert.deepEqual(custom.nested.keep, ['b', 2])

  await page.getByLabel('新键名', { exact: true }).fill('temp')
  await page.waitForFunction(() => window.pending === true)
  const countBeforeNamed = await changeCount()
  await page.evaluate(() => window.renderLevel(true))
  await page.waitForFunction(() => document.querySelector('section[aria-label="自定义数据"] input[aria-label="新键名"]')?.disabled === true)
  assert.equal(await page.getByLabel('新键名', { exact: true }).inputValue(), 'temp')
  const namedOnly = await page.evaluate(() => window.guard())
  assert.equal(namedOnly.ok, false)
  assert.match(namedOnly.message, /新键尚未添加/)
  assert.equal(await changeCount(), countBeforeNamed)
  const cancelNamed = page.getByRole('button', { name: '放弃新键', exact: true })
  assert.equal(await cancelNamed.isEnabled(), true)
  await cancelNamed.click()
  await page.waitForFunction(() => window.pending === false)
  assert.equal(await page.getByLabel('新键名', { exact: true }).inputValue(), '')
  assert.equal(await changeCount(), countBeforeNamed)

  await page.evaluate(() => window.renderLevel(false))
  await page.waitForFunction(() => document.querySelector('section[aria-label="自定义数据"] input[aria-label="新键名"]')?.disabled === false)
  await page.getByLabel('新键名', { exact: true }).fill('temp')
  await page.getByLabel('新键值', { exact: true }).fill('hold')
  await page.waitForFunction(() => window.pending === true)
  const countBeforeReadOnly = await changeCount()
  await page.evaluate(() => window.renderLevel(true))
  await page.waitForFunction(() => document.querySelector('section[aria-label="自定义数据"] input[aria-label="新键名"]')?.disabled === true)
  assert.equal(await page.getByLabel('新键名', { exact: true }).inputValue(), 'temp')
  assert.equal(await page.getByLabel('新键值', { exact: true }).inputValue(), 'hold')
  const readOnlyGuard = await page.evaluate(() => window.guard())
  assert.equal(readOnlyGuard.ok, false)
  assert.equal(readOnlyGuard.message, '只读，未写入字段草稿')
  assert.equal(await changeCount(), countBeforeReadOnly)
  const cancel = page.getByRole('button', { name: '放弃新键', exact: true })
  assert.equal(await cancel.isEnabled(), true)
  assert.equal(await page.getByRole('switch', { name: 'enabled' }).isDisabled(), true)
  await cancel.click()
  await page.waitForFunction(() => window.pending === false)
  assert.equal(await page.getByLabel('新键名', { exact: true }).inputValue(), '')
  assert.equal(await changeCount(), countBeforeReadOnly)

  await page.locator('.level-tree-landmark').filter({ hasText: 'tower' }).click()
  await page.getByLabel('名称文本键').waitFor()
  const landmarkCustom = page.locator('section[aria-label="自定义数据"]')
  assert.equal(await landmarkCustom.getByLabel('rpgtoolkit:display_name').count(), 0)
  assert.equal(await landmarkCustom.locator('.level-custom-key', { hasText: /^extra$/ }).count(), 1)
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('level custom ui ok')
} finally {
  await browser?.close()
  await server.close()
}
