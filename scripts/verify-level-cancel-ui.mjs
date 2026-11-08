import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  appType: 'custom',
  plugins: [{
    name: 'level-cancel-ui-dependencies',
    resolveId(id) { if (id === '/level-cancel-ui-deps.js') return id },
    load(id) {
      if (id === '/level-cancel-ui-deps.js') {
        return "export { default as React } from 'react'; export { createRoot } from 'react-dom/client'"
      }
    },
  }],
})
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/level-cancel-check') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><body><div id="root"></div>
<style>
  html, body, #root, .level-volume { margin: 0; width: 960px; height: 640px; }
</style></body></html>`))
})

let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const dpr = Number(process.env.REGION_TEST_DPR ?? 1)
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: dpr })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/level-cancel-check`)
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/level-cancel-ui-deps.js')
    const { LevelVolumeView } = await import('/src/workspaces/gameplay/levelVolumeView.tsx')
    const { createLevelDocument } = await import('/src/workspaces/gameplay/levelDoc.ts')
    const root = createRoot(document.getElementById('root'))
    const doc = createLevelDocument()
    doc.regions.push({
      id: 'room',
      areas: [{ kind: 'rect', x: [-40.25, 40.25], z: [-40, 40], y: [0, 48] }],
      custom_data: {},
    })
    window.commits = []
    window.previews = []
    window.escapeBubbled = 0
    window.lastPointerId = 1
    window.disabled = false
    document.getElementById('root').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.escapeBubbled += 1
    })
    let mountKey = 0
    const paint = () => {
      root.render(React.createElement(LevelVolumeView, {
        key: String(mountKey),
        base: doc,
        shown: doc,
        tool: 'select',
        selection: { kind: 'region', id: 'room', area: 0 },
        draftPoints: [],
        disabled: window.disabled,
        resetToken: 'cancel-ui',
        onHover: () => {},
        onPreview: (next) => { window.previews.push(next) },
        onCommit: (next) => { window.commits.push(next) },
        onSelection: () => {},
        onDraftPoints: () => {},
      }))
    }
    window.renderVolume = () => paint()
    window.remountVolume = () => { mountKey += 1; paint() }
    window.unmountVolume = () => root.unmount()
    window.renderVolume()
  })
  const host = page.locator('.level-volume')
  await host.waitFor()
  await page.evaluate(() => {
    document.querySelector('.level-volume').addEventListener('pointerdown', (event) => {
      window.lastPointerId = event.pointerId
    }, true)
  })
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  const error = await host.getAttribute('data-error')
  if (error) throw new Error(`三维视图不可用：${error}`)
  assert.deepEqual(errors, [])
  const box = await host.boundingBox()
  assert.ok(box && box.width >= 900 && box.height >= 600, `画布尺寸 ${JSON.stringify(box)}`)
  const frame = await host.locator('canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl2')
    return { viewport: Array.from(gl.getParameter(gl.VIEWPORT)), width: canvas.width, height: canvas.height }
  })
  assert.deepEqual(frame.viewport, [0, 0, frame.width, frame.height], '渲染视口必须覆盖真实帧缓冲；不能重复乘 DPI 导致画面裁切和拾取错位')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const commits = () => page.evaluate(() => window.commits.length)
  const escapes = () => page.evaluate(() => window.escapeBubbled)
  const lastPreview = () => page.evaluate(() => {
    const value = window.previews.at(-1)
    return value === undefined ? 'none' : value === null ? 'null' : 'doc'
  })

  await host.focus()
  await page.keyboard.press('Escape')
  assert.equal(await escapes(), 1, '没有手势时 Escape 继续冒泡')
  assert.equal(await commits(), 0)

  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.up()
  assert.equal(await commits(), 0, '零位移抬起不提交')

  async function armDrag() {
    const before = await commits()
    const bubbles = await escapes()
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 90, cy + 28, { steps: 5 })
    const captured = await page.evaluate(() => {
      const node = document.querySelector('.level-volume')
      return node.hasPointerCapture(window.lastPointerId)
    })
    assert.equal(captured, true, '拖拽应抓住指针')
    assert.equal(await lastPreview(), 'doc', '取消前必须已经产生实际区域预览')
    return { before, bubbles }
  }

  async function releaseMouse(button = 'left') {
    await page.mouse.up({ button })
  }

  async function cancelled(label, before) {
    assert.equal(await commits(), before, label)
    assert.equal(await lastPreview(), 'null', `${label} 预览已清`)
  }

  {
    const { before } = await armDrag()
    await page.evaluate(() => {
      document.querySelector('.level-volume').dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: window.lastPointerId,
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300,
      }))
    })
    await cancelled('pointercancel', before)
    await releaseMouse()
    assert.equal(await commits(), before, 'pointercancel 之后的 pointerup 不再提交')
  }

  {
    const { before } = await armDrag()
    await page.evaluate(() => {
      const node = document.querySelector('.level-volume')
      const pointerId = window.lastPointerId
      node.releasePointerCapture(pointerId)
    })
    // 浏览器在下一次真实指针事件前处理待释放的捕获；不合成 lostpointercapture。
    await page.mouse.move(cx + 92, cy + 30)
    await cancelled('lostpointercapture', before)
    await releaseMouse()
    assert.equal(await commits(), before, '丢失捕获之后的 pointerup 不再提交')
  }

  {
    const { before, bubbles } = await armDrag()
    await page.keyboard.press('Escape')
    assert.equal(await escapes(), bubbles, '拖拽中的 Escape 不冒泡到父级')
    await cancelled('Escape', before)
    await releaseMouse()
    assert.equal(await commits(), before, 'Escape 之后的 pointerup 不再提交')
  }

  {
    const { before } = await armDrag()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await cancelled('blur', before)
    await releaseMouse()
    assert.equal(await commits(), before, 'blur 之后的 pointerup 不再提交')
  }

  {
    const { before } = await armDrag()
    await page.evaluate(() => {
      const prototype = Document.prototype
      const previous = Object.getOwnPropertyDescriptor(prototype, 'visibilityState')
      Object.defineProperty(prototype, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      if (previous) Object.defineProperty(prototype, 'visibilityState', previous)
    })
    await cancelled('visibility', before)
    await releaseMouse()
    assert.equal(await commits(), before, '隐藏之后的 pointerup 不再提交')
  }

  {
    const { before } = await armDrag()
    await page.evaluate(() => {
      window.disabled = true
      window.renderVolume()
    })
    await page.waitForTimeout(40)
    await cancelled('disabled', before)
    await releaseMouse()
    assert.equal(await commits(), before, '只读切换之后的 pointerup 不再提交')
    await page.evaluate(() => {
      window.disabled = false
      window.renderVolume()
    })
    await page.locator('.level-volume[data-ready="1"]').waitFor()
  }

  {
    const before = await commits()
    await armDrag()
    await page.mouse.up()
    assert.equal(await commits(), before + 1, '改变后的 pointerup 只提交一次')
    await page.evaluate(() => {
      const node = document.querySelector('.level-volume')
      node.dispatchEvent(new PointerEvent('lostpointercapture', {
        pointerId: window.lastPointerId,
        bubbles: true,
      }))
    })
    assert.equal(await commits(), before + 1, 'pointerup 之后的 lostpointercapture 不再提交')
  }

  {
    const before = await commits()
    await page.evaluate(() => {
      window.disabled = true
      window.renderVolume()
    })
    await page.locator('.level-volume[data-ready="1"]').waitFor()
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 90, cy + 30, { steps: 4 })
    await page.mouse.up()
    assert.equal(await commits(), before, '只读拖拽不提交')
    await page.evaluate(() => {
      window.disabled = false
      window.renderVolume()
    })
    await page.locator('.level-volume[data-ready="1"]').waitFor()
  }

  {
    const before = await commits()
    const orbit = await host.getAttribute('data-orbit')
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(cx + 80, cy + 20, { steps: 4 })
    await page.evaluate(() => {
      document.querySelector('.level-volume').dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: window.lastPointerId,
        bubbles: true,
        cancelable: true,
      }))
    })
    await releaseMouse('right')
    assert.equal(await commits(), before, '环绕取消不提交')
    assert.notEqual(await host.getAttribute('data-orbit'), null)
    assert.ok(orbit !== undefined)
  }

  {
    const before = await commits()
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(cx + 60, cy + 20, { steps: 4 })
    await page.evaluate(() => {
      document.querySelector('.level-volume').dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: window.lastPointerId,
        bubbles: true,
        cancelable: true,
      }))
    })
    await releaseMouse('middle')
    assert.equal(await commits(), before, '平移取消不提交')
  }

  {
    const before = await commits()
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, 140)
    assert.equal(await commits(), before, '滚轮不提交')
  }

  await page.evaluate(() => {
    window.disabled = false
    window.remountVolume()
  })
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  await page.evaluate(() => {
    document.querySelector('.level-volume').addEventListener('pointerdown', (event) => {
      window.lastPointerId = event.pointerId
    }, true)
  })

  {
    const before = await commits()
    await armDrag()
    await page.evaluate(() => window.unmountVolume?.())
    await page.evaluate(() => {
      const rootNode = document.getElementById('root')
      rootNode.replaceChildren()
    })
    await page.mouse.up().catch(() => {})
    assert.equal(await commits(), before, '卸载不提交')
  }

  assert.deepEqual(errors, [])
  console.log(`level cancel ui ok (DPR ${dpr})`)
} finally {
  await browser?.close()
  await server.close()
}
