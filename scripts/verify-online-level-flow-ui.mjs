/**
 * Browser regression for one .level draft across the real project service and the WebUI.
 *
 * MOCK: the native ControlHub and the interactive stream portal are simulated inside
 * this process. A passing run does not show that in-game gizmos, Axiom hit-testing,
 * or camera/viewport mapping work. Those stay with the separate native acceptance.
 *
 * The draft is seeded through S before the editor opens. After that, this script does
 * not write the level file itself. Saves go through the editor's Ctrl+S transaction.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { harness } from './collaboration-harness.mjs'
import { testAccount } from './test-accounts.mjs'

const MOCK_PORT = 8765
const PROJECT_NAME = '统一工程验收'
const SIDE_NAME = '旁路工程'
let framePacket = null
const ORIGINAL = {
  tags: ['keep-me'],
  regions: [{
    id: 'gate',
    areas: [{ x: [1.5, 4.5], z: [2, 6], y: 'all' }],
    custom_data: { note: 'original', extra: 1 },
  }],
  landmarks: [{
    id: 'tower',
    kind: 'rpgtoolkit:pos',
    param: { x: 10.25, y: 64, z: -3.5 },
    custom_data: { 'rpgtoolkit:display_name': '旧塔', kept: true },
  }],
  custom_data: { author: 'flow' },
}
const CAMP = {
  tags: [],
  regions: [{ id: 'yard', areas: [{ x: [0, 2], z: [0, 2], y: 'all' }] }],
  landmarks: [{ id: 'post', kind: 'rpgtoolkit:pos', param: { x: 1, y: 3, z: 1 }, custom_data: {} }],
  custom_data: {},
}
const SIDE_LEVEL = {
  tags: [],
  regions: [{ id: 'side', areas: [{ x: [0, 1], z: [0, 1], y: 'all' }] }],
  landmarks: [{ id: 'marker', kind: 'rpgtoolkit:pos', param: { x: 0, y: 1, z: 0 }, custom_data: {} }],
  custom_data: {},
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const levelText = (doc) => `${JSON.stringify(doc, null, 2)}\n`
const fingerprint = (doc) => JSON.stringify({
  tags: doc.tags,
  regions: doc.regions,
  landmarks: doc.landmarks,
  custom_data: doc.custom_data,
})

function apiPathname(url) {
  return new URL(url).pathname.replace(/^\/__project(?=\/|$)/, '')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function clone(doc) {
  return structuredClone(doc)
}

function moved(doc, { y = doc.landmarks[0].param.y, maxX = doc.regions[0].areas[0].x[1] } = {}) {
  const next = clone(doc)
  next.landmarks[0].param.y = y
  next.regions[0].areas[0].x[1] = maxX
  return next
}

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

function decodeKeys(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== 0x4E495052 || view.getUint16(4, true) !== 1) return []
  const count = view.getUint16(6, true)
  const keys = []
  let offset = 8
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > buffer.byteLength) break
    const type = view.getUint8(offset)
    const mods = view.getUint16(offset + 2, true)
    offset += 8
    const payload = type === 4 || type === 5 ? 9 : type === 7 ? 16 : 4
    if ((type === 1 || type === 2) && offset + 4 <= buffer.byteLength) {
      keys.push({ type, mods, key: view.getUint16(offset, true) })
    }
    offset += payload
  }
  return keys
}

function assertBegin(params, { writable, projectId, fileName, y }) {
  assert.equal(params?.v, 1, 'level.edit.begin must use protocol v=1')
  assert.match(String(params.sessionId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `sessionId must be a UUID, got ${params.sessionId}`)
  const documentId = String(params.documentId ?? '')
  const bare = new Set([fileName, fileName.replace(/\.level$/i, '')])
  assert.equal(bare.has(documentId), false, `documentId must not be filename-only, got ${documentId}`)
  assert.equal(documentId.includes(projectId), true, `documentId must include project ${projectId}, got ${documentId}`)
  assert.equal(documentId.includes(fileName) || documentId.includes(`src/level/${fileName}`), true, `documentId must include ${fileName}, got ${documentId}`)
  assert.equal(Number.isSafeInteger(params.revision) && params.revision >= 0, true, `revision must be a nonnegative safe integer, got ${params.revision}`)
  assert.equal(params.writable, writable, `writable should be ${writable}`)
  assert.equal(['select', 'rect', 'circle', 'polygon', 'landmark'].includes(params.tool), true, `tool ${params.tool}`)
  assert.equal(params.selection === null || (params.selection && typeof params.selection === 'object'), true, 'selection must be null or an object')
  assert.equal(params.document?.landmarks?.[0]?.param?.y, y, `begin must send the committed landmark y, got ${params.document?.landmarks?.[0]?.param?.y}`)
  assert.equal(params.document?.landmarks?.[0]?.param?.x, 10.25, 'begin must keep the fractional landmark x')
  assert.equal(params.document?.landmarks?.[0]?.custom_data?.kept, true, 'begin must keep landmark custom_data')
  assert.deepEqual(params.document?.tags, ['keep-me'])
  assert.equal(params.document?.regions?.[0]?.areas?.[0]?.y, 'all')
  return { sessionId: params.sessionId, documentId, revision: params.revision }
}

async function readLevel(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function connectAccount(page, appBase, serviceBase, credential, clientName, projectName, navigate) {
  await page.addInitScript((value) => sessionStorage.setItem('hanshu.windowName', value), clientName)
  if (navigate) await page.goto(appBase)
  const account = testAccount(credential)
  const form = page.getByRole('form', { name: '连接其他服务器', exact: true })
  if (!navigate) await form.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  if (!await form.isVisible()) {
    await page.getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('menuitem', { name: '连接其他服务器…', exact: true }).click()
  }
  await form.getByLabel('服务地址', { exact: true }).fill(serviceBase)
  await form.getByLabel('用户名', { exact: true }).fill(account.username)
  await form.getByLabel('密码', { exact: true }).fill(account.password)
  const response = page.waitForResponse((entry) => apiPathname(entry.url()) === '/api/sessions' && entry.request().method() === 'POST')
  await form.getByRole('button', { name: '连接并打开工程', exact: true }).click()
  const result = await (await response).json()
  assert.equal(typeof result?.token, 'string', `login did not return a token: ${JSON.stringify(result)}`)
  await page.locator(`.collab-widget[data-project-name=${JSON.stringify(projectName)}]`).waitFor()
  return result
}

const port = await freePort()
const appBase = `http://127.0.0.1:${port}`
const h = await harness({ web: false, localProjects: true, origins: [appBase] })
const sideRoot = join(dirname(h.root), `olside-${randomUUID().slice(0, 8)}`)
const hubFile = join(h.root, 'src/level/hub.level')
const campFile = join(h.root, 'src/level/camp.level')
const sideFile = join(sideRoot, 'src/level/hub.level')
let browser
let server
const trace = []
const controlSockets = new Set()
const inputKeys = []
const heldBegins = []
let holdBegin = false
let seq = 0

function mark(kind, params) {
  const item = { seq: ++seq, kind, params }
  trace.push(item)
  return item
}

async function until(kind, from, timeout, label = kind) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const found = trace.slice(from).find((item) => item.kind === kind)
    if (found) return found
    await delay(40)
  }
  const seen = trace.slice(from).map((item) => item.kind).join(', ') || '(none)'
  throw new Error(`timed out waiting for ${label}; saw ${seen}`)
}

function reply(ws, id, result) {
  ws.send(JSON.stringify({ type: 'response', id, ok: true, result }))
}

function releaseHeld() {
  const pending = heldBegins.splice(0)
  for (const item of pending) {
    try {
      reply(item.ws, item.id, {
        ok: true,
        sessionId: item.params.sessionId,
        documentId: item.params.documentId,
        revision: item.params.revision,
      })
    } catch {
      /* The page closed the mocked socket before the late response. */
    }
  }
  return pending.at(-1) ?? null
}

function notifyChanged(params) {
  const text = JSON.stringify({ type: 'notify', method: 'level.edit.changed', params })
  for (const ws of controlSockets) {
    try { ws.send(text) } catch { /* The page already closed this mocked socket. */ }
  }
}

try {
  console.log('MOCK: ControlHub and the stream portal are simulated. This run does not accept native gizmos or Axiom pointer mapping.')
  const owner = await h.login(h.credential, 'online level setup')
  const project = await h.api(owner.token, '/api/project')
  const projectId = project.projectId
  assert.equal(typeof projectId, 'string')
  assert.ok(projectId.length > 0)
  await h.commit(owner.token, [
    { path: 'src/level/hub.level', content: levelText(ORIGINAL) },
    { path: 'src/level/camp.level', content: levelText(CAMP) },
  ])
  const editorAccount = await h.api(owner.token, '/api/subjects', 'POST', { name: 'Level editor', kind: 'account', role: 'editor' })
  const viewerAccount = await h.api(owner.token, '/api/subjects', 'POST', { name: 'Level viewer', kind: 'account', role: 'viewer' })
  await h.release(owner.token)
  await mkdir(join(sideRoot, 'src/level'), { recursive: true })
  await writeFile(join(sideRoot, 'project.json'), JSON.stringify({ version: 1, id: 'side-project', name: SIDE_NAME }))
  await writeFile(sideFile, levelText(SIDE_LEVEL))

  server = await createServer({
    cacheDir: 'node_modules/.cache/online-level-flow-ui',
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      proxy: {
        '/__project': {
          target: h.base,
          ws: true,
          changeOrigin: true,
          rewrite: (value) => value.replace(/^\/__project/, ''),
        },
      },
    },
  })
  await server.listen()
  const proxyTarget = server.config.server.proxy?.['/__project']?.target
  assert.equal(proxyTarget, h.base, `Vite must proxy the live app at the harness service, got ${proxyTarget}`)

  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  async function installPortal(target) {
  await target.route(/^http:\/\/127\.0\.0\.1:8765\/(?:health|control\/status|status|stream\/start|stream\/stop)(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/stream/start') mark('stream-start', route.request().postDataJSON())
    if (path === '/stream/stop') mark('stream-stop')
    const body = path === '/health'
      ? { ok: true, services: ['control', 'stream'] }
      : path === '/control/status'
        ? { ok: true, subscribers: 1, pending: 0, wsPath: '/ws/control' }
        : path === '/status'
          ? { screenWidth: 1280, screenHeight: 720 }
          : { ok: true }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await target.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8765\/ws\/(?:control|stream-input|stream)(?:\?.*)?$/, (ws) => {
    const path = new URL(ws.url()).pathname
    if (path === '/ws/control') {
      controlSockets.add(ws)
      mark('control-open')
      ws.onMessage((message) => {
        if (typeof message !== 'string') return
        let frame
        try { frame = JSON.parse(message) } catch { return }
        if (frame?.type !== 'request' || typeof frame.method !== 'string') return
        mark(`rpc:${frame.method}`, frame.params ?? null)
        if (frame.method === 'level.edit.begin' && holdBegin) {
          heldBegins.push({ ws, id: frame.id, params: frame.params })
          return
        }
        if (frame.method === 'level.edit.begin' || frame.method === 'level.edit.sync' || frame.method === 'level.edit.end') {
          const params = frame.params ?? {}
          reply(ws, frame.id, {
            ok: true,
            sessionId: params.sessionId,
            documentId: params.documentId,
            revision: params.revision,
          })
          return
        }
        if (frame.method === 'level.edit.status') {
          const params = frame.params ?? {}
          reply(ws, frame.id, {
            ok: true,
            sessionId: params.sessionId,
            documentId: params.documentId,
            revision: params.revision,
          })
          return
        }
        if (frame.method === 'items.renderSnapshots') {
          reply(ws, frame.id, { componentFormat: 'tnbt-json-v1', componentMode: 'complete', snapshots: [] })
          return
        }
        reply(ws, frame.id, { ok: true })
      })
      ws.onClose(() => controlSockets.delete(ws))
      return
    }
    if (path === '/ws/stream-input') {
      ws.onMessage((message) => {
        if (typeof message === 'string') return
        inputKeys.push(...decodeKeys(Buffer.from(message)))
      })
      return
    }
    if (framePacket) ws.send(framePacket)
  })
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await installPortal(context)
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const jpegBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context2d = canvas.getContext('2d')
    context2d.fillStyle = '#336699'
    context2d.fillRect(0, 0, 8, 8)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
  framePacket = rpsf(Buffer.from(jpegBytes), 8, 8)
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const historyWarnings = []
  page.on('console', message => {
    const text = message.text()
    if (text.includes('Cannot update a component') && text.includes('LevelEditor')) historyWarnings.push(text)
  })
  let commitPosts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && apiPathname(request.url()) === '/api/files/commit') commitPosts += 1
  })

  await connectAccount(page, appBase, h.base, editorAccount.credential, 'online level editor', PROJECT_NAME, true)
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  const pane = page.locator('.app-workspace-pane.active')
  const row = (name) => pane.locator('[role=treeitem]').filter({ has: page.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`) })
  const openResource = async (name) => {
    const show = page.getByRole('button', { name: '显示资源', exact: true })
    if (!await row(name).isVisible() && await show.isVisible()) await show.click()
    await row(name).click()
  }
  const expand = async (name) => {
    const show = page.getByRole('button', { name: '显示资源', exact: true })
    if (!await row(name).isVisible() && await show.isVisible()) await show.click()
    const target = row(name)
    await target.waitFor()
    if (await target.getAttribute('aria-expanded') !== 'true') await target.click()
  }
  await expand('地图')
  await expand('地图模板')
  await openResource('hub.level')
  const canvas = page.getByLabel('三维体积视图')
  await canvas.waitFor()
  await page.locator('.level-volume[data-ready="1"]').waitFor()
  const landmark = (axis) => page.getByLabel(`地标 ${axis.toUpperCase()}`, { exact: true })
  const rectField = (label) => page.getByLabel(label, { exact: true })
  const listButton = (name) => page.locator('.level-tree-row button[title], .level-tree-landmark').getByText(name, { exact: !(name instanceof RegExp) })
  async function assertLevelPending(target, present, message) {
    const widget = target.locator('.collab-widget')
    if (!await widget.evaluate((node) => node.classList.contains('is-open'))) {
      await target.getByRole('button', { name: '打开协作面板', exact: true }).click()
    }
    const changes = target.getByRole('button', { name: /^修改/ })
    if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()
    const started = Date.now()
    let names = []
    try {
      while (Date.now() - started < 8000) {
        names = await target.locator('.collab-draft-files li').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') || ''))
        const listed = names.some((item) => item === 'src/level/hub.level')
        if (listed === present) return
        await delay(100)
      }
      throw new Error(`${message}: pending ${JSON.stringify(names)}`)
    } finally {
      const close = target.getByRole('button', { name: '收起协作面板', exact: true })
      if (await close.count()) await close.click()
    }
  }
  const assertSaved = (message) => assertLevelPending(page, false, message ?? 'hub.level must not be in the pending save list')
  const assertUnsaved = (message) => assertLevelPending(page, true, message ?? 'hub.level must be in the pending save list')
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 64)
  assert.equal(Number(await landmark('x').inputValue()), 10.25)
  await assertSaved('打开的地图草稿与工程文件一致')
  assert.equal(fingerprint(await readLevel(hubFile)), fingerprint(ORIGINAL))

  const beforeOrbit = await canvas.getAttribute('data-orbit')
  const box = await canvas.boundingBox()
  assert.ok(box && box.width > 200 && box.height > 120, `地图画布没有可用尺寸：${JSON.stringify(box)}`)
  await canvas.hover({ position: { x: box.width / 2, y: box.height / 2 } })
  await page.mouse.wheel(0, 120)
  await page.waitForFunction((previous) => document.querySelector('.level-volume')?.dataset.orbit !== previous, beforeOrbit)
  await assertSaved('相机移动不能把地图标成待保存')
  assert.equal(commitPosts, 0)
  await listButton(/^gate/).click()
  assert.equal(await rectField('矩形 X 最小').inputValue(), '1.5')
  assert.equal(await rectField('矩形 X 最大').inputValue(), '4.5')
  assert.equal(await rectField('矩形 Z 最小').inputValue(), '2')
  assert.equal(await rectField('矩形 Z 最大').inputValue(), '6')

  async function startOnline(expectedY) {
    if (!trace.some((item) => item.kind === 'control-open')) {
      await until('control-open', 0, 10000, 'mocked control socket')
    }
    const from = trace.length
    await page.getByRole('button', { name: '游戏内', exact: true }).click()
    const host = page.locator('.level-stream')
    await host.waitFor()
    await page.locator('.level-stream[data-state="live"][data-frame="1"]').waitFor({ timeout: 15000 })
    let sessionId = ''
    const stableStart = Date.now()
    while (Date.now() - stableStart < 3000) {
      const next = await host.getAttribute('data-edit-session')
      if (next && next === sessionId) break
      sessionId = next ?? ''
      await delay(150)
    }
    const begin = trace.slice(from).filter((item) => item.kind === 'rpc:level.edit.begin' && item.params?.sessionId === sessionId).at(-1)
    const stream = begin ? trace.slice(from).find((item) => item.kind === 'stream-start' && item.seq > begin.seq) : null
    assert.ok(begin, `the live data-edit-session ${sessionId || '(empty)'} must match a level.edit.begin`)
    assert.ok(stream, `level.edit.begin for ${sessionId} must be requested before its stream/start`)
    assert.ok(begin.seq < stream.seq, `level.edit.begin must be requested before stream/start (${begin.seq} vs ${stream.seq})`)
    const identity = assertBegin(begin.params, { writable: true, projectId, fileName: 'hub.level', y: expectedY })
    assert.equal(await host.getAttribute('data-state'), 'live')
    assert.equal(await host.getAttribute('data-edit-document'), identity.documentId)
    assert.equal(await host.getAttribute('data-edit-revision'), String(identity.revision))
    const handles = await host.getAttribute('data-edit-handles')
    assert.ok(handles == null || handles === '' || handles === '[]', `this mock supplies no handle coordinates; the page must not invent them, saw ${handles}`)
    return { from, identity }
  }

  async function stopOnline() {
    const from = trace.length
    await page.getByRole('button', { name: '离线 3D', exact: true }).click()
    await until('rpc:level.edit.end', from, 8000)
    await canvas.waitFor()
  }

  function shortcutKeys(code) {
    return inputKeys.filter((item) => item.type === 1 && item.key === code && (item.mods & 0x0002) !== 0)
  }

  console.log('online-level-flow: preview must not enter history or the project transaction')
  const first = await startOnline(64)
  const previewSelection = { kind: 'region', id: 'gate', area: 0 }
  for (const maxX of [6.5, 7.5, 8.5, 9.5]) {
    notifyChanged({
      v: 1,
      sessionId: first.identity.sessionId,
      documentId: first.identity.documentId,
      baseRevision: first.identity.revision,
      gestureId: 'gesture-preview',
      phase: 'preview',
      selection: previewSelection,
      document: moved(ORIGINAL, { y: 64, maxX }),
    })
  }
  await page.waitForFunction(() => document.querySelector('[aria-label="矩形 X 最大"]')?.value === '9.5')
  assert.equal(await rectField('矩形 X 最小').inputValue(), '1.5')
  assert.equal(await rectField('矩形 Z 最小').inputValue(), '2')
  assert.equal(await rectField('矩形 Z 最大').inputValue(), '6')
  assert.equal(await page.getByRole('radio', { name: '全部高度' }).isChecked(), true)
  await assertSaved('拖动预览不能把草稿标成待保存')
  assert.equal(commitPosts, 0, '拖动预览不能提交工程事务')
  assert.equal(fingerprint(await readLevel(hubFile)), fingerprint(ORIGINAL))
  const sync = await until('rpc:level.edit.sync', first.from, 4500, 'level.edit.sync heartbeat')
  assert.equal(sync.params?.revision, first.identity.revision, 'heartbeat sync during a gesture must keep the base revision')
  assert.equal(sync.params?.documentId, first.identity.documentId)
  assert.equal(sync.params?.document?.regions?.[0]?.areas?.[0]?.x?.[1], 4.5, 'a gesture heartbeat must send the committed rect, not the preview')
  assert.equal(sync.params?.document?.landmarks?.[0]?.param?.y, 64, 'a gesture heartbeat must send the committed landmark')
  assert.equal(await page.locator('.level-stream').getAttribute('data-edit-revision'), String(first.identity.revision), 'a preview must not bump the editing revision')
  assert.equal(await rectField('矩形 X 最大').inputValue(), '9.5', 'same-revision sync must not clear the live preview')
  inputKeys.length = 0
  const cancelFrom = trace.length
  await page.locator('.level-stream').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelector('[aria-label="矩形 X 最大"]')?.value === '4.5')
  const cancel = await until('rpc:level.edit.cancel', cancelFrom, 3000, 'level.edit.cancel')
  assert.equal(cancel.params?.sessionId, first.identity.sessionId)
  assert.equal(cancel.params?.documentId, first.identity.documentId)
  await delay(250)
  assert.equal(shortcutKeys(90).length, 0, 'region-edit Ctrl+Z must not be streamed to the mocked game')
  await assertSaved()
  assert.equal(fingerprint(await readLevel(hubFile)), fingerprint(ORIGINAL))
  const landmarkFrom = trace.length
  await listButton('tower').click()
  await until('rpc:level.edit.cancel', landmarkFrom, 3000, 'level.edit.cancel before the next preview').catch(() => {})
  await delay(200)
  notifyChanged({
    v: 1,
    sessionId: first.identity.sessionId,
    documentId: first.identity.documentId,
    baseRevision: first.identity.revision,
    gestureId: 'gesture-cancel',
    phase: 'preview',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(ORIGINAL, { y: 93, maxX: 4.5 }),
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="地标 Y"]')?.value === '93')
  await assertSaved('地标预览也不能进入待保存')
  await stopOnline()
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 64, 'leaving online mode must cancel an open preview')
  await assertSaved()

  console.log('online-level-flow: release commits one history step')
  const second = await startOnline(64)
  assert.equal(second.identity.documentId, first.identity.documentId, 'documentId must stay stable for the same project resource')
  assert.notEqual(second.identity.sessionId, first.identity.sessionId, 'a new online entry must not reuse the ended session')
  const committed = moved(ORIGINAL, { y: 80, maxX: 8.5 })
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-commit',
    phase: 'preview',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(ORIGINAL, { y: 77, maxX: 7.5 }),
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="地标 Y"]')?.value === '77')
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-commit',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: committed,
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="地标 Y"]')?.value === '80')
  await assertUnsaved('松手提交必须把这份地图标成待保存')
  assert.equal(fingerprint(await readLevel(hubFile)), fingerprint(ORIGINAL), 'the gesture commit updates the draft, not the project file')
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-commit',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(ORIGINAL, { y: 99, maxX: 20.5 }),
  })
  notifyChanged({
    v: 1,
    sessionId: randomUUID(),
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-foreign',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(ORIGINAL, { y: 11, maxX: 11.5 }),
  })
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: `${projectId}:src/level/camp.level`,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-other-doc',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(ORIGINAL, { y: 12, maxX: 12.5 }),
  })
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-stale',
    phase: 'preview',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(committed, { y: 13, maxX: 13.5 }),
  })
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-malformed',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: { ...committed, navigation: { bad: true } },
  })
  await delay(300)
  assert.equal(Number(await landmark('y').inputValue()), 80, 'duplicate, foreign, stale and malformed gestures must not replace the commit')
  assert.equal(await landmark('x').inputValue(), '10.25')
  inputKeys.length = 0
  await page.locator('.level-stream').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelector('[aria-label="地标 Y"]')?.value === '64')
  await assertSaved('撤销到已保存的文档后不能再标成待保存')
  await delay(200)
  assert.equal(shortcutKeys(90).length, 0, 'Ctrl+Z after a committed gesture must undo the document, not stream the key')
  // The pending-list check moved focus to the collaboration orb. Global undo
  // must still use this level's gesture history instead of the workspace source stack.
  await page.keyboard.press('Control+z')
  await delay(250)
  assert.equal(Number(await landmark('y').inputValue()), 64, 'preview frames must not add undo steps behind the one commit')
  await assertSaved()
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => document.querySelector('[aria-label="地标 Y"]')?.value === '80')
  await assertUnsaved('重做提交必须再次标成待保存')
  await delay(200)
  assert.equal(shortcutKeys(89).length, 0, 'Ctrl+Y must redo the document without streaming the key')
  await stopOnline()

  console.log('online-level-flow: inspector and offline volume share the committed draft')
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80)
  assert.equal(Number(await landmark('z').inputValue()), -3.5)
  await listButton(/^gate/).click()
  assert.equal(await page.getByRole('radio', { name: '全部高度' }).isChecked(), true)
  assert.equal(await rectField('矩形 X 最小').inputValue(), '1.5')
  assert.equal(await rectField('矩形 X 最大').inputValue(), '8.5')
  assert.equal(await rectField('矩形 Z 最小').inputValue(), '2')
  assert.equal(await rectField('矩形 Z 最大').inputValue(), '6')
  if (!await page.locator('.level-extension-data').evaluate(e => e.open)) await page.locator('.level-extension-data > summary').click()
  if (!await page.locator('.level-custom-json').evaluate(e => e.open)) await page.locator('.level-custom-json > summary').click()
  assert.match(await page.getByLabel('custom_data').inputValue(), /"note": "original"/)
  assert.match(await page.getByLabel('custom_data').inputValue(), /"extra": 1/)
  await listButton('tower').click()
  await page.getByRole('button', { name: '矩形', exact: true }).click()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.62, { steps: 12 })
  await page.mouse.up()
  await listButton(/^region/).waitFor()
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80, 'the offline rect must land on the online draft')
  await page.locator('.level-editor').focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => ![...document.querySelectorAll('.level-list button')].some((button) => button.textContent?.includes('region')))
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80)
  await page.locator('.level-editor').focus()
  await page.keyboard.press('Control+y')
  await listButton(/^region/).waitFor()
  console.log('online-level-flow: Ctrl+S on the live stream uses one project transaction and is not encoded')
  const savingSession = await startOnline(80)
  assert.equal(savingSession.identity.documentId, first.identity.documentId, 'saving online must keep the same document identity')
  inputKeys.length = 0
  await page.locator('.level-stream').focus()
  const commitsBeforeSave = commitPosts
  const saving = page.waitForResponse((response) => apiPathname(response.url()) === '/api/files/commit' && response.request().method() === 'POST')
  await page.keyboard.press('Control+s')
  const saved = await saving
  assert.equal((await saved.json()).status, 'committed')
  assert.equal(commitPosts, commitsBeforeSave + 1, 'Ctrl+S must produce one project transaction')
  assert.equal(shortcutKeys(83).length, 0, 'Ctrl+S must reach the project save path instead of the mocked stream')
  const savedRequest = saved.request().postDataJSON()
  const savedChange = savedRequest.changes.find((change) => change.path === 'src/level/hub.level')
  assert.ok(savedChange, 'the transaction must include src/level/hub.level')
  const savedBody = JSON.parse(Buffer.from(savedChange.content, 'base64').toString('utf8'))
  assert.equal(savedBody.landmarks[0].param.y, 80)
  assert.equal(savedBody.landmarks[0].param.x, 10.25)
  assert.equal(savedBody.landmarks[0].param.z, -3.5)
  assert.equal(savedBody.landmarks[0].custom_data.kept, true)
  assert.equal(savedBody.landmarks[0].custom_data['rpgtoolkit:display_name'], '旧塔')
  assert.deepEqual(savedBody.regions[0].areas[0].x, [1.5, 8.5])
  assert.deepEqual(savedBody.regions[0].areas[0].z, [2, 6])
  assert.equal(savedBody.regions[0].areas[0].y, 'all')
  assert.equal(savedBody.regions[0].custom_data.note, 'original')
  assert.equal(savedBody.regions.some((region) => region.id === 'region'), true)
  assert.deepEqual(savedBody.tags, ['keep-me'])
  assert.equal(savedBody.custom_data.author, 'flow')
  assert.equal(savedBody.navigation, undefined)
  let disk = null
  const diskStarted = Date.now()
  while (Date.now() - diskStarted < 4000) {
    disk = await readLevel(hubFile)
    if (disk.landmarks?.[0]?.param?.y === 80 && disk.regions?.some((region) => region.id === 'region')) break
    await delay(100)
  }
  assert.equal(fingerprint(disk), fingerprint(savedBody))
  await assertSaved('Ctrl+S 之后 src/level/hub.level 必须离开待保存列表')
  await stopOnline()

  console.log('online-level-flow: reopen reads the saved project document')
  await page.reload()
  await connectAccount(page, appBase, h.base, editorAccount.credential, 'online level reopened', PROJECT_NAME, false)
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await expand('地图')
  await expand('地图模板')
  await openResource('hub.level')
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80)
  assert.equal(Number(await landmark('x').inputValue()), 10.25)
  await listButton(/^region/).waitFor()
  await listButton(/^gate/).waitFor()
  const reopenedDisk = fingerprint(await readLevel(hubFile))
  assert.equal(reopenedDisk, fingerprint(savedBody))

  console.log('online-level-flow: a late begin cannot commit after the document changes')
  holdBegin = true
  const abandonFrom = trace.length
  await page.getByRole('button', { name: '游戏内', exact: true }).click()
  await until('rpc:level.edit.begin', abandonFrom, 8000)
  const abandoned = heldBegins.at(-1)
  assert.ok(abandoned, 'the mocked portal should be holding the begin response')
  await openResource('camp.level')
  await listButton('post').click()
  assert.equal(Number(await landmark('y').inputValue()), 3)
  holdBegin = false
  assert.equal(releaseHeld()?.id, abandoned.id)
  notifyChanged({
    v: 1,
    sessionId: abandoned.params.sessionId,
    documentId: abandoned.params.documentId,
    baseRevision: abandoned.params.revision,
    gestureId: 'gesture-abandoned',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(committed, { y: 123, maxX: 30.5 }),
  })
  await delay(400)
  assert.equal(Number(await landmark('y').inputValue()), 3, 'a late session must not write the document that is now open')
  assert.equal(fingerprint(await readLevel(hubFile)), reopenedDisk)
  assert.equal(fingerprint(await readLevel(campFile)), fingerprint(CAMP))
  await openResource('hub.level')
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80)
  notifyChanged({
    v: 1,
    sessionId: abandoned.params.sessionId,
    documentId: abandoned.params.documentId,
    baseRevision: abandoned.params.revision,
    gestureId: 'gesture-abandoned-return',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(committed, { y: 124, maxX: 31.5 }),
  })
  await delay(300)
  assert.equal(Number(await landmark('y').inputValue()), 80, 'returning to the file must not accept the abandoned session')
  assert.equal(fingerprint(await readLevel(hubFile)), reopenedDisk)

  console.log('online-level-flow: switching projects drops an in-flight edit session')
  holdBegin = true
  const switchFrom = trace.length
  await page.getByRole('button', { name: '游戏内', exact: true }).click()
  await until('rpc:level.edit.begin', switchFrom, 8000)
  const switched = heldBegins.at(-1)
  await page.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开工程…', exact: true }).click()
  await page.getByRole('button', { name: '打开本机工程…', exact: true }).click()
  await page.getByRole('button', { name: '工程所在目录', exact: true }).click()
  await page.getByLabel('筛选本机文件夹', { exact: true }).fill(sideRoot.split(/[\\/]/).at(-1))
  await page.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByRole('option', { name: sideRoot.split(/[\\/]/).at(-1), exact: true }).click()
  const openedSide = page.waitForResponse((response) => apiPathname(response.url()) === '/api/local/open' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '打开此文件夹', exact: true }).click()
  assert.equal((await (await openedSide).json()).token ? true : false, true)
  await page.locator(`.collab-widget[data-project-name=${JSON.stringify(SIDE_NAME)}]`).waitFor()
  holdBegin = false
  assert.equal(releaseHeld()?.id, switched.id)
  notifyChanged({
    v: 1,
    sessionId: switched.params.sessionId,
    documentId: switched.params.documentId,
    baseRevision: switched.params.revision,
    gestureId: 'gesture-project-switch',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'marker' },
    document: moved(SIDE_LEVEL, { y: 7, maxX: 4 }),
  })
  await delay(400)
  assert.equal(fingerprint(await readLevel(hubFile)), reopenedDisk, 'a stale session must not save the previous project')
  assert.equal(fingerprint(await readLevel(sideFile)), fingerprint(SIDE_LEVEL), 'a stale session must not save the project that was just opened')
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await expand('地图')
  await expand('地图模板')
  await openResource('hub.level')
  await listButton('marker').click()
  assert.equal(Number(await landmark('y').inputValue()), 1, 'the opened project must keep its own landmark')
  await page.getByRole('button', { name: '文件', exact: true }).click()
  await page.getByRole('menuitem', { name: '打开工程…', exact: true }).click()
  await page.getByRole('button', { name: '打开本机工程…', exact: true }).click()
  await page.getByRole('button', { name: '默认工程', exact: true }).click()
  const reopenedProject = page.waitForResponse((response) => apiPathname(response.url()) === '/api/local/open' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '打开此文件夹', exact: true }).click()
  assert.equal((await (await reopenedProject).json()).token ? true : false, true)
  await page.locator(`.collab-widget[data-project-name=${JSON.stringify(PROJECT_NAME)}]`).waitFor()
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await expand('地图')
  await expand('地图模板')
  await openResource('hub.level')
  await listButton('tower').click()
  assert.equal(Number(await landmark('y').inputValue()), 80)

  console.log('online-level-flow: a viewer cannot mutate the same document')
  const viewerTrace = trace.length
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await installPortal(viewerContext)
  const viewer = await viewerContext.newPage()
  viewer.setDefaultTimeout(20000)
  viewer.on('pageerror', (error) => errors.push(`viewer: ${error}`))
  let viewerCommits = 0
  viewer.on('request', (request) => {
    if (request.method() === 'POST' && apiPathname(request.url()) === '/api/files/commit') viewerCommits += 1
  })
  await connectAccount(viewer, appBase, h.base, viewerAccount.credential, 'online level viewer', PROJECT_NAME, true)
  await viewer.getByRole('tab', { name: '游戏性', exact: true }).click()
  const viewerPane = viewer.locator('.app-workspace-pane.active')
  const viewerRow = (name) => viewerPane.locator('[role=treeitem]').filter({ has: viewer.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`) })
  const viewerExpand = async (name) => {
    const target = viewerRow(name)
    await target.waitFor()
    if (await target.getAttribute('aria-expanded') !== 'true') await target.click()
  }
  await viewerExpand('地图')
  await viewerExpand('地图模板')
  await viewerRow('hub.level').click()
  await viewer.locator('.level-tree-landmark[title="tower"]').click()
  const viewerY = viewer.getByLabel('地标 Y', { exact: true })
  assert.equal(Number(await viewerY.inputValue()), 80)
  assert.equal(await viewerY.isDisabled(), true, 'a viewer landmark field must be disabled')
  assert.equal(await viewer.getByRole('button', { name: '矩形', exact: true }).isDisabled(), true, 'a viewer cannot use the draw tools')
  await until('control-open', viewerTrace, 10000, 'viewer control socket')
  const viewerFrom = trace.length
  const cloud = viewer.getByRole('button', { name: '游戏内', exact: true })
  if (await cloud.isEnabled()) {
    await cloud.click()
    const viewerBegin = await until('rpc:level.edit.begin', viewerFrom, 8000, 'viewer level.edit.begin')
    assert.equal(viewerBegin.params?.writable, false, 'a viewer session must be read-only')
    notifyChanged({
      v: 1,
      sessionId: viewerBegin.params.sessionId,
      documentId: viewerBegin.params.documentId,
      baseRevision: viewerBegin.params.revision,
      gestureId: 'gesture-viewer',
      phase: 'commit',
      selection: { kind: 'landmark', id: 'tower' },
      document: moved(savedBody, { y: 5, maxX: 9.5 }),
    })
  }
  notifyChanged({
    v: 1,
    sessionId: second.identity.sessionId,
    documentId: second.identity.documentId,
    baseRevision: second.identity.revision,
    gestureId: 'gesture-viewer-foreign',
    phase: 'commit',
    selection: { kind: 'landmark', id: 'tower' },
    document: moved(savedBody, { y: 6, maxX: 9.5 }),
  })
  await delay(400)
  assert.equal(Number(await viewerY.inputValue()), 80)
  assert.equal(Number(await landmark('y').inputValue()), 80, 'a viewer or foreign commit must not change the editor draft')
  await viewer.locator('.level-editor').focus()
  await viewer.keyboard.press('Control+z')
  await delay(250)
  assert.equal(Number(await viewerY.inputValue()), 80, 'a viewer Ctrl+Z must not change the shown document')
  await viewer.keyboard.press('Control+s')
  await delay(400)
  assert.equal(viewerCommits, 0, 'a viewer Ctrl+S must not submit a project transaction')
  await assertLevelPending(viewer, false, 'a viewer must not put hub.level on the pending save list')
  await assertLevelPending(page, false, 'a forged viewer commit must not mark the editor draft pending')
  assert.equal(fingerprint(await readLevel(hubFile)), reopenedDisk)
  assert.deepEqual(errors, [])
  assert.deepEqual(historyWarnings, [], 'history callbacks must run outside React state updaters')
  console.log('PASS online level flow: mocked native portal; preview, one commit, shared offline draft, undo, Ctrl+S, reopen, stale sessions and viewer')
} finally {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  await h.stop().catch(() => {})
}
