import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const fixture = JSON.parse(await readFile('../ModRPGToolKit/build/python-stubs-test.json', 'utf8'))
const server = await createServer({ cacheDir: 'node_modules/.cache/python-tools-ui', server: { host: '127.0.0.1', port: 0, hmr: false } })
await server.listen()
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.route('**/python-tools-check', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#222"><div id="test" style="height:700px"></div></body>' }))
  await page.route('http://127.0.0.1:8765/**', r => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"ok":true,"subscribers":1}' }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/python-tools-check`)
  const original = '"""module docs"""\nfrom __future__ import annotations\n\nItemStack()\n'
  await page.evaluate(async ({ fixture, original }) => {
    await import('/src/monaco/setup.ts')
    const { mountPythonTools } = await import('/scripts/python-tools-ui-fixture.tsx')
    window.WebSocket = class {
      static OPEN = 1; static CONNECTING = 0; readyState = 0
      constructor() { window.socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}) }, 5) }
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
      send(text) {
        const request = JSON.parse(text)
        let result
        if (request.method === 'python.classes.search') {
          const classes = fixture.classes.filter(c => c.name.toLowerCase().includes(request.params.query.toLowerCase())).map(c => ({ name: c.name, symbol: c.symbol, packageName: c.name.slice(0, c.name.lastIndexOf('.')), origin: 'Minecraft reflection fixture' }))
          result = { schemaVersion: 1, runtimeId: fixture.runtimeId, classes, hasMore: false }
        } else {
          const wanted = new Set(request.params.classes ?? [])
          result = { ...fixture, classes: fixture.classes.filter(c => wanted.has(c.name)), missing: [] }
        }
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'response', id: request.id, ok: true, result }) }), (window.delaySearch && request.method === 'python.classes.search') || (window.delayStubs && request.method === 'python.stubs') ? 300 : 5)
      }
    }
    const hub = await import('/src/gameDevServer/controlHub.ts'); hub.reconnectGameDevControlNow()
    window.controlHub = hub
    mountPythonTools(document.getElementById('test'), original, (editor, monaco) => { window.editor = editor; window.monaco = monaco })
  }, { fixture, original })
  await page.waitForFunction(() => window.editor && window.controlHub.isControlConnected())
  await page.evaluate(() => { window.editor.setPosition({ lineNumber: 4, column: 3 }); window.editor.focus() })
  await page.keyboard.press('Control+Alt+j')
  const dialog = page.getByRole('dialog', { name: '导入 Java 类', exact: true })
  await dialog.waitFor()
  await dialog.getByRole('option', { name: /ItemStack/ }).waitFor()
  assert.equal(await dialog.getByLabel('搜索 Java 类').inputValue(), 'ItemStack')
  await dialog.getByLabel('Java 类导入别名').fill('Stack')
  assert.match(await dialog.getByLabel('Java 类导入预览').textContent(), /import ItemStack as Stack/)
  await dialog.getByLabel('Java 类导入别名').press('Enter')
  await dialog.waitFor({ state: 'detached' })
  const changed = await page.evaluate(() => window.editor.getValue())
  assert(changed.includes('from net.minecraft.world.item import ItemStack as Stack'))
  assert(changed.includes('\nStack()'))
  assert.equal(await page.evaluate(() => window.editor.getPosition().column), 6, 'cursor stays at the edited body reference rather than the inserted import')
  assert(changed.indexOf('from __future__') < changed.indexOf('from net.minecraft'))
  await page.evaluate(() => window.editor.trigger('test', 'undo', null))
  assert.equal(await page.evaluate(() => window.editor.getValue()), original, 'one undo restores import plus selected reference')
  const methodSource = 'def handler(event):\n    player = event.player()\n'
  await page.evaluate(source => { window.editor.setValue(source); window.editor.setPosition({ lineNumber: 2, column: 7 }); window.editor.focus() }, methodSource)
  await page.keyboard.press('Control+Alt+j')
  await dialog.waitFor(); await dialog.getByLabel('搜索 Java 类').fill('ItemStack')
  await dialog.getByRole('option', { name: /ItemStack/ }).waitFor(); await dialog.getByRole('button', { name: '导入', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  assert((await page.evaluate(() => window.editor.getValue())).includes('player = event.player()'), 'importing from an unrelated caret cannot rename a variable or method')
  await page.evaluate(() => window.editor.trigger('test', 'undo', null))
  assert.equal(await page.evaluate(() => window.editor.getValue()), methodSource)
  await page.evaluate(source => { window.editor.setValue(source); window.editor.focus() }, original)
  await page.locator('.monaco-editor').first().click({ button: 'right', position: { x: 240, y: 105 } })
  // Monaco arms its mouse-up menu handlers after 100 ms.
  await page.waitForTimeout(150)
  await page.getByText('导入 Java 类…', { exact: true }).click()
  await dialog.waitFor()
  await dialog.getByLabel('搜索 Java 类').fill('ItemStack')
  await dialog.getByRole('option', { name: /ItemStack/ }).waitFor()
  await page.evaluate(() => { window.delayStubs = true })
  await dialog.getByRole('button', { name: '导入', exact: true }).click()
  await dialog.press('Escape')
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => window.editor.getValue()), original, 'cancelling in-flight validation must not write later')
  await page.evaluate(() => { window.delayStubs = false; window.editor.focus() })
  await page.keyboard.press('Control+Alt+j')
  await dialog.waitFor(); await dialog.getByLabel('搜索 Java 类').fill('ItemStack')
  await dialog.getByRole('option', { name: /ItemStack/ }).waitFor()
  await page.evaluate(() => window.editor.updateOptions({ readOnly: true }))
  assert(await dialog.getByRole('button', { name: '导入', exact: true }).isDisabled())
  await dialog.press('Escape')
  await page.evaluate(() => { window.editor.updateOptions({ readOnly: false }); window.editor.focus(); window.delaySearch = true })
  await page.keyboard.press('Control+Alt+j')
  await dialog.waitFor(); await dialog.getByLabel('搜索 Java 类').fill('ItemStack')
  await page.evaluate(() => window.controlHub.disconnectGameDevControl())
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索 Java 类"]')?.disabled)
  assert(await dialog.getByLabel('搜索 Java 类').isDisabled())
  await dialog.press('Escape')
  assert.equal(await page.evaluate(() => window.editor.getValue()), original)
  assert.deepEqual(errors, [])
  console.log('PASS Java import UI: keyboard and context menu, selection prefill, real class stub validation, alias preview, header placement, atomic undo, read-only and disconnect fencing')
} finally { await browser.close(); await server.close() }
