import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const shots = 'node_modules/.tmp/level-editor-ui'
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  appType: 'custom',
  plugins: [{
    name: 'level-editor-ui-dependencies',
    resolveId(id) { if (id === '/level-editor-ui-deps.js') return id },
    load(id) {
      if (id === '/level-editor-ui-deps.js') {
        return "export { default as React } from 'react'; export { createRoot } from 'react-dom/client'"
      }
    },
  }],
})
server.middlewares.use(async (req, res, next) => {
  if (req.url !== '/level-editor-check') return next()
  res.setHeader('Content-Type', 'text/html')
  res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><body><div id="root"></div>
<style>
  html, body, #root { margin: 0; height: 640px; }
  #root { display: flex; flex-direction: column; }
  #root > .level-editor { flex: 1; min-height: 0; }
  #root > .nav-editor { height: 100%; overflow: auto; }
</style></body></html>`))
})

function rpsf(jpeg, width, height) {
  const buffer = Buffer.alloc(32 + jpeg.length)
  buffer.writeUInt32LE(0x52505346, 0)
  buffer.writeUInt16LE(32, 4)
  buffer.writeUInt16LE(3, 6)
  buffer.writeUInt32LE(width, 8)
  buffer.writeUInt32LE(height, 12)
  buffer.writeUInt32LE(0, 16)
  buffer.writeUInt32LE(1, 20)
  jpeg.copy(buffer, 32)
  return buffer
}

let browser
let page
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/level-editor-check`)
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/level-editor-ui-deps.js')
    const { LevelEditor } = await import('/src/workspaces/gameplay/LevelEditor.tsx')
    const { createLevelDocument } = await import('/src/workspaces/gameplay/levelDoc.ts')
    const { NavigationEditor } = await import('/src/workspaces/gameplay/NavigationEditor.tsx')
    const { createNavigationPoint } = await import('/src/workspaces/gameplay/navigationPoint.ts')
    const root = createRoot(document.getElementById('root'))
    window.changes = []
    window.navLabel = ''
    const initialLevel = createLevelDocument()
    window.renderLevel = (disabled = false) => {
      root.render(React.createElement(LevelEditor, {
        doc: initialLevel,
        disabled,
        identity: {
          projectId: 'project-level-ui',
          clientId: 'client-window-ui',
          resourceId: 'source:src/level/hub.level',
        },
        onChange: (next) => { window.changes.push(next) },
      }))
    }
    window.renderNav = () => {
      const point = createNavigationPoint('', 'camp')
      root.render(React.createElement(NavigationEditor, {
        point,
        onChange: (next) => {
          window.changes.push(next)
          window.renderNavFrom(next)
        },
        levelOptions: [{ id: 'hub', label: 'hub' }],
        landmarkOptions: [{ level: 'hub', ref: 'hub$old_tower', label: '旧塔' }],
        resolveText: () => window.navLabel,
        setText: (_key, value) => { window.navLabel = value; window.renderNavFrom(JSON.stringify(point)) },
      }))
    }
    window.renderNavFrom = (source) => {
      const point = JSON.parse(source)
      root.render(React.createElement(NavigationEditor, {
        point,
        onChange: (next) => {
          window.changes.push(next)
          window.renderNavFrom(next)
        },
        levelOptions: [{ id: 'hub', label: 'hub' }],
        landmarkOptions: [{ level: 'hub', ref: 'hub$old_tower', label: '旧塔' }],
        resolveText: () => window.navLabel,
        setText: (_key, value) => { window.navLabel = value; window.renderNavFrom(source) },
      }))
    }
    window.renderLevel()
  })
  const canvas = page.getByLabel('三维体积视图')
  await canvas.waitFor()
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  if (await canvas.getAttribute('data-error')) throw new Error(`三维视图不可用：${await canvas.innerText()}`)
  const box = await canvas.boundingBox()
  assert.ok(box && box.width > 200 && box.height > 120, `地图画布没有可用尺寸：${JSON.stringify(box)}`)
  const orbitOf = () => canvas.getAttribute('data-orbit')
  const changeCount = () => page.evaluate(() => window.changes.length)

  const beforeZoom = await orbitOf()
  await canvas.hover({ position: { x: box.width / 2, y: box.height / 2 } })
  await page.mouse.wheel(0, 120)
  await page.waitForFunction((previous) => document.querySelector('.level-volume')?.dataset.orbit !== previous, beforeZoom)
  assert.equal(await changeCount(), 0, '滚轮只移动相机')

  const beforeOrbit = await orbitOf()
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(box.x + box.width * 0.45 + 90, box.y + box.height * 0.45 + 24, { steps: 6 })
  await page.mouse.up({ button: 'right' })
  await page.waitForFunction((previous) => document.querySelector('.level-volume')?.dataset.orbit !== previous, beforeOrbit)
  assert.equal(await changeCount(), 0, '右键环绕不改文档')

  const beforePan = await orbitOf()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + box.width * 0.5 + 70, box.y + box.height * 0.5 + 36, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  await page.waitForFunction((previous) => document.querySelector('.level-volume')?.dataset.orbit !== previous, beforePan)
  assert.equal(await changeCount(), 0, '中键平移不改文档')

  const beforeSpace = await orbitOf()
  await page.locator('.level-editor').focus()
  await page.keyboard.down(' ')
  assert.equal(await page.locator('.level-editor.is-space').count(), 0)
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.4 + 90, box.y + box.height * 0.4 + 40, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up(' ')
  assert.equal(await orbitOf(), beforeSpace, '空格不再平移相机')
  assert.equal(await changeCount(), 0, '空格拖移不改文档')

  async function selectTool(name) {
    await page.getByRole('button', { name, exact: true }).click()
    await page.locator('.level-tools button.is-active', { hasText: name }).waitFor()
  }
  async function drag(x0, y0, x1, y1) {
    await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 12 })
    await page.mouse.up()
  }

  await selectTool('矩形')
  await drag(0.28, 0.32, 0.58, 0.62)
  await page.getByRole('button', { name: /^region/ }).waitFor()
  await selectTool('圆')
  await drag(0.4, 0.42, 0.52, 0.5)
  await selectTool('多边形')
  for (const [x, y] of [[0.22, 0.22], [0.34, 0.2], [0.3, 0.34], [0.22, 0.22]]) {
    await canvas.click({ position: { x: box.width * x, y: box.height * y } })
  }
  await page.waitForFunction(() => {
    const saved = window.changes.at(-1)
    if (!saved) return false
    const doc = JSON.parse(saved)
    return doc.regions?.[0]?.areas?.length === 3
  })
  const drawn = await page.evaluate(() => JSON.parse(window.changes.at(-1)))
  assert.equal(drawn.tags.length, 0)
  assert.equal('navigation' in drawn, false)
  assert.equal(drawn.regions.length, 1)
  const areas = drawn.regions[0].areas
  assert.deepEqual(Object.keys(areas[0]).sort(), ['x', 'y', 'z'])
  assert.equal(areas[0].y, 'all')
  assert.ok(areas[0].x[1] > areas[0].x[0] && areas[0].z[1] > areas[0].z[0])
  assert.equal(areas[1].shape, 'circle')
  assert.ok(areas[1].radius >= 1)
  assert.equal(areas[2].shape, 'polygon')
  assert.ok(areas[2].points.length >= 3)
  for (const area of areas) {
    const numbers = JSON.stringify(area).match(/-?\d+(?:\.\d+)?/g) ?? []
    assert.ok(numbers.every((value) => Number.isInteger(Number(value))), `坐标应吸附到整数方块：${JSON.stringify(area)}`)
  }
  await page.getByRole('button', { name: /^region/ }).click()
  await page.getByLabel('矩形 X 起').waitFor()
  assert.equal(Number(await page.getByLabel('矩形 X 起').inputValue()), areas[0].x[0])
  assert.equal(Number(await page.getByLabel('矩形 X 止').inputValue()), areas[0].x[1])
  assert.equal(Number(await page.getByLabel('矩形 Z 起').inputValue()), areas[0].z[0])
  assert.equal(Number(await page.getByLabel('矩形 Z 止').inputValue()), areas[0].z[1])
  await page.getByText('全部高度', { exact: true }).waitFor()
  const summaries = await page.locator('.level-geometry-summary').allInnerTexts()
  assert.ok(summaries.some((text) => text.includes(`X ${areas[0].x[0]}`)), summaries.join(' | '))
  assert.ok(summaries.some((text) => text.includes('半径')), summaries.join(' | '))
  assert.ok(summaries.some((text) => text.includes('顶点')), summaries.join(' | '))
  const beforeGeometry = await changeCount()
  const nextX = areas[0].x[1] + 3
  await page.getByLabel('矩形 X 止').fill(String(nextX))
  await page.waitForFunction((value) => {
    const doc = JSON.parse(window.changes.at(-1) ?? '{}')
    return doc.regions?.[0]?.areas?.[0]?.x?.[1] === value
  }, nextX)
  assert.equal(await changeCount(), beforeGeometry + 1, '改一个端点只记一帧')

  await selectTool('地标')
  await canvas.click({ position: { x: box.width * 0.7, y: box.height * 0.28 } })
  await page.getByLabel('地标 y').waitFor()
  await page.getByLabel('地标 y').fill('72')
  await page.getByLabel('名称文本键').fill('旧塔')
  await page.waitForFunction(() => {
    const doc = JSON.parse(window.changes.at(-1) ?? '{}')
    return doc.landmarks?.[0]?.param?.y === 72 && doc.landmarks?.[0]?.custom_data?.['rpgtoolkit:display_name'] === '旧塔'
  })
  const marked = await page.evaluate(() => JSON.parse(window.changes.at(-1)))
  const landmark = marked.landmarks[0]
  assert.equal(landmark.kind, 'rpgtoolkit:pos')
  assert.equal('type' in landmark, false)
  assert.ok(Number.isInteger(landmark.param.x) && Number.isInteger(landmark.param.z))
  assert.equal(landmark.param.y, 72)
  assert.equal(landmark.custom_data['rpgtoolkit:display_name'], '旧塔')

  const orbitBeforeUndo = await orbitOf()
  await page.locator('.level-editor').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => {
    const doc = JSON.parse(window.changes.at(-1) ?? '{}')
    return doc.landmarks?.[0]?.param?.y === 72 && !doc.landmarks?.[0]?.custom_data
  })
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1) ?? '{}').landmarks?.[0]?.param?.y === 64)
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1) ?? '{}').landmarks?.[0]?.param?.y === 72)
  assert.equal(await orbitOf(), orbitBeforeUndo, '撤销不带回相机')
  const undone = await page.evaluate(() => JSON.parse(window.changes.at(-1)))
  assert.equal(undone.regions.length, 1)
  assert.equal(undone.landmarks.length, 1)
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/volumes.png`, fullPage: true })

  const starts = []
  const stops = []
  const editCalls = []
  let editSocket
  let streamMode = 'offline'
  let startDelay = 0
  const inputMessages = []
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.includes('/health')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, services: ['control'] }) })
    }
    if (url.includes('/control/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, subscribers: 1 }) })
    }
    if (url.includes('/stream/start')) {
      starts.push({ body: route.request().postData() ?? '', password: route.request().headers()['x-devtool-password'] ?? '', at: Date.now() })
      if (streamMode === 'offline') return route.abort('failed')
      if (startDelay) await new Promise(resolve => setTimeout(resolve, startDelay))
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    if (url.includes('/stream/stop')) {
      stops.push(new URL(url).pathname)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    if (/\/status(?:\?|$)/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ screenWidth: 854, screenHeight: 480 }) })
    }
    return route.continue()
  })
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    context.fillStyle = '#336699'
    context.fillRect(0, 0, 8, 8)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }))
  let frame = rpsf(jpeg, 8, 8)
  await page.routeWebSocket(/\/ws\/stream-input/, (socket) => {
    socket.onMessage((message) => inputMessages.push(Buffer.from(message)))
  })
  await page.routeWebSocket(/\/ws\/stream\?/, (socket) => {
    socket.send(frame)
  })
  await page.routeWebSocket(/\/ws\/control/, (socket) => {
    editSocket = socket
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message))
      if (frame.type !== 'request') return
      const params = frame.params ?? {}
      editCalls.push({ method: frame.method, params, at: Date.now() })
      socket.send(JSON.stringify({
        type: 'response',
        id: frame.id,
        ok: true,
        result: {
          ok: true,
          sessionId: params.sessionId,
          documentId: params.documentId,
          revision: params.revision ?? 0,
          handles: [{ id: 'handle-room', selection: params.selection ?? null, screenX: 120, screenY: 80 }],
          window: { width: 1920, height: 1080 },
          viewport: { x: 8, y: 16, width: 1280, height: 720 },
        },
      }))
    })
  })
  await page.evaluate(async () => {
    const { ensureGameDevControlStarted, isControlConnected } = await import('/src/gameDevServer/controlHub.ts')
    ensureGameDevControlStarted()
    for (let attempt = 0; attempt < 50 && !isControlConnected(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!isControlConnected()) throw new Error('control did not open')
    window.saveChord = []
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        window.saveChord.push({ defaultPrevented: event.defaultPrevented })
        event.preventDefault()
      }
    })
  })

  await page.getByRole('button', { name: '本地云游戏', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '游戏开发服务器未连接' }).waitFor()
  assert.equal(stops.length, 0, '没连上时不发送停止')
  assert.equal(await page.locator('.level-volume').count(), 0)
  const beforeStreamUndo = await changeCount()
  await page.getByLabel('本地云游戏画面').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1) ?? '{}').landmarks?.[0]?.param?.y === 64)
  assert.ok(await changeCount() > beforeStreamUndo, '云游戏视口里的 Ctrl+Z 撤销地图草稿')
  await page.getByLabel('地标 y').fill('80')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1) ?? '{}').landmarks?.[0]?.param?.y === 80)
  await page.getByRole('button', { name: '停止云游戏', exact: true }).click()
  await page.locator('.level-volume[data-ready="1"]').waitFor()

  streamMode = 'live'
  inputMessages.length = 0
  await page.getByRole('button', { name: '本地云游戏', exact: true }).click()
  const stream = page.getByLabel('本地云游戏画面')
  await stream.waitFor()
  await page.locator('.level-stream[data-state="live"][data-frame="1"]').waitFor()
  assert.equal(await page.locator('.level-volume').count(), 0)
  assert.equal(await page.locator('.level-stream canvas').count(), 1)
  assert.equal(starts.at(-1).body, JSON.stringify({
    mode: 'interactive', picture: 'jpeg', renderWidth: 1280, renderHeight: 720, fps: 30, jpegQuality: 0.62,
  }))
  const configuredPassword = await page.evaluate(async () => {
    const { getControlHubSnapshot } = await import('/src/gameDevServer/controlHub.ts')
    return getControlHubSnapshot().prefs.password
  })
  assert.equal(starts.at(-1).password, configuredPassword)
  assert.ok(!JSON.stringify(starts.at(-1).body).includes(configuredPassword))
  const streamBox = await stream.boundingBox()
  assert.ok(streamBox && streamBox.width > 200 && streamBox.height > 120)
  const cancelsBeforeRelease = editCalls.filter(item => item.method === 'level.edit.cancel').length
  await stream.click({ position: { x: streamBox.width / 2, y: streamBox.height / 2 } })
  for (let attempt = 0; attempt < 40 && inputMessages.length === 0; attempt += 1) await page.waitForTimeout(50)
  assert.ok(inputMessages.length > 0, '云游戏视口没有发出输入')
  await page.waitForTimeout(60)
  assert.equal(editCalls.filter(item => item.method === 'level.edit.cancel').length, cancelsBeforeRelease,
    '正常 pointerup 后的自动 lostpointercapture 不能取消有效拖动')
  const events = await page.evaluate(async (chunks) => {
    const { decodeRpin } = await import('/src/workspaces/gameplay/streamInput.ts')
    return chunks.flatMap((chunk) => decodeRpin(new Uint8Array(chunk).buffer))
  }, inputMessages.map((item) => [...item]))
  const button = events.find((event) => event.type === 4)
  assert.ok(button, `没有按下按钮：${JSON.stringify(events)}`)
  const expected = await page.evaluate(async ({ x, y, width, height }) => {
    const { letterboxToScreen } = await import('/src/workspaces/gameplay/streamInput.ts')
    return letterboxToScreen(x, y, width, height, 8, 8, 854, 480)
  }, { x: streamBox.width / 2, y: streamBox.height / 2, width: streamBox.width, height: streamBox.height })
  assert.deepEqual({ x: button.x, y: button.y }, expected)
  assert.deepEqual(expected, { x: 427, y: 240 })
  assert.notDeepEqual(expected, { x: Math.round(streamBox.width / 2), y: Math.round(streamBox.height / 2) })
  assert.notDeepEqual(expected, { x: 4, y: 4 })
  await page.locator('.level-stream[data-edit-session]').waitFor()
  const editSession = await page.locator('.level-stream').getAttribute('data-edit-session')
  const editDocument = await page.locator('.level-stream').getAttribute('data-edit-document')
  const editRevision = await page.locator('.level-stream').getAttribute('data-edit-revision')
  const editHandles = JSON.parse(await page.locator('.level-stream').getAttribute('data-edit-handles'))
  const editWindow = JSON.parse(await page.locator('.level-stream').getAttribute('data-edit-window'))
  const editViewport = JSON.parse(await page.locator('.level-stream').getAttribute('data-edit-viewport'))
  assert.ok(editSession)
  assert.match(editDocument, /project:project-level-ui\/client:client-window-ui\/resource:source%3Asrc%2Flevel%2Fhub\.level/)
  assert.match(editRevision, /^\d+$/)
  assert.equal(editHandles[0].screenX, 120)
  assert.equal(editHandles[0].screenY, 80)
  assert.deepEqual(editWindow, { width: 1920, height: 1080 })
  assert.deepEqual(editViewport, { x: 8, y: 16, width: 1280, height: 720 })
  const begins = editCalls.filter((item) => item.method === 'level.edit.begin')
  assert.ok(begins.length >= 1)
  for (const begin of begins) {
    assert.match(begin.params.documentId, /^project:project-level-ui\/client:client-window-ui\/resource:source%3Asrc%2Flevel%2Fhub\.level$/)
    const authorAreas = begin.params.document.regions[0].areas
    assert.equal('kind' in authorAreas[0], false)
    assert.equal(authorAreas[1].shape, 'circle')
    assert.equal('kind' in authorAreas[1], false)
    assert.equal(authorAreas[2].shape, 'polygon')
    assert.equal('kind' in authorAreas[2], false)
    assert.equal(begin.params.document.landmarks[0].kind, 'rpgtoolkit:pos')
  }
  assert.ok(begins.at(-1).at <= starts.at(-1).at, '编辑会话要先于画面启动')
  const duringLive = await changeCount()
  const beforeUndoMessages = inputMessages.length
  await stream.focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1) ?? '{}').landmarks?.[0]?.param?.y === 64)
  assert.ok(await changeCount() > duringLive, '直播时 Ctrl+Z 撤销地图草稿')
  const undoEvents = await page.evaluate(async (chunks) => {
    const { decodeRpin } = await import('/src/workspaces/gameplay/streamInput.ts')
    return chunks.flatMap((chunk) => decodeRpin(new Uint8Array(chunk).buffer))
  }, inputMessages.slice(beforeUndoMessages).map((item) => [...item]))
  assert.equal(undoEvents.some((event) => event.key === 90), false, 'Ctrl+Z 不转发给游戏')
  const beforeSaveMessages = inputMessages.length
  await stream.focus()
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.saveChord.length > 0)
  assert.equal((await page.evaluate(() => window.saveChord.at(-1).defaultPrevented)), false)
  const saveEvents = await page.evaluate(async (chunks) => {
    const { decodeRpin } = await import('/src/workspaces/gameplay/streamInput.ts')
    return chunks.flatMap((chunk) => decodeRpin(new Uint8Array(chunk).buffer))
  }, inputMessages.slice(beforeSaveMessages).map((item) => [...item]))
  assert.equal(saveEvents.some((event) => event.key === 83), false, 'Ctrl+S 不转发给游戏')

  // The game commit can arrive on its control socket after the input socket's UP.
  const nativeBase = structuredClone(editCalls.findLast(item => item.method === 'level.edit.sync' || item.method === 'level.edit.begin').params.document)
  const gesture = {
    v: 1,
    sessionId: await stream.getAttribute('data-edit-session'),
    documentId: await stream.getAttribute('data-edit-document'),
    baseRevision: Number(await stream.getAttribute('data-edit-revision')),
    gestureId: 'release-after-capture',
    selection: { kind: 'landmark', id: nativeBase.landmarks[0].id },
  }
  const notify = (phase, document) => editSocket.send(JSON.stringify({
    type: 'notify', method: 'level.edit.changed', params: { ...gesture, phase, ...(document ? { document } : {}) },
  }))
  const beforeNativeCommit = await changeCount()
  notify('begin')
  await page.waitForTimeout(30)
  await page.mouse.move(streamBox.x + streamBox.width / 2, streamBox.y + streamBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(streamBox.x + streamBox.width / 2 + 25, streamBox.y + streamBox.height / 2 + 15)
  await page.mouse.up()
  await page.waitForTimeout(60)
  nativeBase.landmarks[0].param.y += 2
  notify('commit', nativeBase)
  await page.waitForFunction(expected => window.changes.length === expected, beforeNativeCommit + 1)
  assert.equal(JSON.parse(await page.evaluate(() => window.changes.at(-1))).landmarks[0].param.y, nativeBase.landmarks[0].param.y)
  await stream.focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => JSON.parse(window.changes.at(-1)).landmarks[0].param.y === 64)

  async function receivedEvents() {
    return page.evaluate(async (chunks) => {
      const { decodeRpin } = await import('/src/workspaces/gameplay/streamInput.ts')
      return chunks.flatMap(chunk => decodeRpin(new Uint8Array(chunk).buffer))
    }, inputMessages.map(item => [...item]))
  }
  await stream.dispatchEvent('wheel', { deltaY: 100, deltaMode: 0 })
  await page.waitForTimeout(80)
  const wheel = (await receivedEvents()).findLast(event => event.type === 6)
  assert.equal(wheel?.dyCenti, -100, '浏览器向下滚动对应 GLFW 的负方向')
  await page.keyboard.down('w')
  await page.waitForTimeout(50)
  await page.getByLabel('地标 y').focus()
  await page.waitForTimeout(50)
  await page.keyboard.up('w')
  const wEvents = (await receivedEvents()).filter(event => (event.type === 1 || event.type === 2) && event.key === 87)
  assert.equal(wEvents.at(-2)?.type, 1)
  assert.equal(wEvents.at(-1)?.type, 2, '视口失焦补发 KEY_UP')
  const outsideCount = inputMessages.length
  await page.mouse.move(streamBox.x + 30, streamBox.y + 30)
  await stream.dispatchEvent('wheel', { deltaY: 100, deltaMode: 0 })
  await page.getByLabel('名称文本键').fill('中文名称')
  await page.waitForTimeout(80)
  assert.equal(inputMessages.length, outsideCount, '属性栏聚焦时不转发悬停、滚轮或中文输入')

  await stream.focus()
  await stream.dispatchEvent('pointerdown', { pointerId: 91, button: 0, clientX: streamBox.x + 50, clientY: streamBox.y + 50 })
  await stream.dispatchEvent('lostpointercapture', { pointerId: 91 })
  await page.waitForTimeout(50)
  const buttonEvents = (await receivedEvents()).filter(event => event.type === 4 || event.type === 5)
  assert.equal(buttonEvents.at(-2)?.type, 4)
  assert.equal(buttonEvents.at(-1)?.type, 5, '丢失指针捕获补发 BUTTON_UP')
  const beforePointerCancel = editCalls.filter(item => item.method === 'level.edit.cancel').length
  await stream.dispatchEvent('pointerdown', { pointerId: 92, button: 0, clientX: streamBox.x + 50, clientY: streamBox.y + 50 })
  await stream.dispatchEvent('pointercancel', { pointerId: 92, button: 0 })
  await page.waitForTimeout(50)
  assert.equal(editCalls.filter(item => item.method === 'level.edit.cancel').length, beforePointerCancel + 1,
    'pointercancel 先取消草稿手势，再释放游戏按钮')
  const beforeDisabledUndo = await changeCount()
  await page.evaluate(() => window.renderLevel(true))
  await stream.focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+y')
  await page.waitForTimeout(80)
  assert.equal(await changeCount(), beforeDisabledUndo, '降为只读后已有撤销栈也不能修改草稿')
  await page.evaluate(() => window.renderLevel())
  const stopsBefore = stops.length
  await page.getByRole('button', { name: '停止云游戏', exact: true }).click()
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  for (let attempt = 0; attempt < 40 && stops.length === stopsBefore; attempt += 1) await page.waitForTimeout(50)
  assert.ok(stops.length > stopsBefore, '离开云游戏时要停止会话')
  await page.screenshot({ path: `${shots}/stream.png`, fullPage: true })

  const delayedStops = stops.length
  startDelay = 250
  const dispatched = page.waitForRequest(request => request.url().includes('/stream/start') && request.method() === 'POST')
  await page.getByRole('button', { name: '本地云游戏', exact: true }).click()
  await dispatched
  await page.getByRole('button', { name: '停止云游戏', exact: true }).click()
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  for (let attempt = 0; attempt < 40 && stops.length === delayedStops; attempt++) await page.waitForTimeout(50)
  assert.equal(stops.length, delayedStops + 1, '启动请求已发送但尚未返回时关闭，收到确认后仍需停止游戏')
  startDelay = 0

  frame = rpsf(Buffer.from([0xff, 0xd8, 0, 1, 2]), 8, 8)
  await page.getByRole('button', { name: '本地云游戏', exact: true }).click()
  await page.locator('.level-stream[data-state="error"]').waitFor()
  await page.getByRole('button', { name: '停止云游戏', exact: true }).click()
  await page.locator('.level-volume[data-ready="1"]').waitFor()

  const levelChanges = await changeCount()
  await page.evaluate(() => window.renderNav())
  await page.getByLabel('所属地图模板').selectOption('hub')
  await page.getByLabel('追踪的地标').selectOption('hub$old_tower')
  await page.getByText('可用', { exact: true }).waitFor()
  await page.getByLabel('导航器显示名').fill('旧塔')
  const nav = await page.evaluate(() => JSON.parse(window.changes.at(-1)))
  assert.equal(nav.id, 'camp')
  assert.equal(nav.level, 'hub')
  assert.deepEqual(nav.track, { type: 'landmark', ref: 'hub$old_tower' })
  assert.equal('x' in nav || 'y' in nav || 'z' in nav || 'param' in nav, false)
  assert.equal(await page.getByLabel('地标 x').count(), 0)
  assert.match(await page.locator('.nav-hint').innerText(), /不能在这里写坐标/)
  assert.match(await page.locator('.nav-preview').innerText(), /hub\$old_tower/)
  assert.equal(await page.evaluate(() => window.navLabel), '旧塔')
  assert.ok((await changeCount()) > levelChanges)
  await page.screenshot({ path: `${shots}/navigation.png`, fullPage: true })
  assert.deepEqual(errors, [])
  console.log('PASS level editor ui: 3d draw, camera, undo, stream letterbox and nav track')
} catch (error) {
  await mkdir(shots, { recursive: true })
  await page?.screenshot({ path: `${shots}/failure.png`, fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await server.close()
}
