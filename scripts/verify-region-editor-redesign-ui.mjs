/**
 * Region-editor redesign regression against the already built dist and the real project service S.
 *
 * MOCK: ControlHub and the interactive stream portal on 127.0.0.1:8765 are simulated
 * in this process (same routes as verify-online-level-flow-ui.mjs). A passing run is
 * not native, Axiom, or in-game gizmo acceptance.
 *
 * hub.level and other.level are seeded through S before the editor opens. Later edits
 * and Ctrl+S go through the public editor and S transactions. This script does not
 * write those level files again after the seed.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject } from './project-ui-helpers.mjs'

const ART = resolve(process.env.REGION_EDITOR_ARTIFACTS ?? 'node_modules/.cache/region-editor-redesign')
const MOCK_PORT = 8765
const LONG_ID = 'overlap-gate-north-wing-alpha-qa-redesign-volume'
const HUB = 'src/level/hub.level'
const OTHER = 'src/level/other.level'

const HUB_DOC = {
  tags: ['qa'],
  regions: [
    {
      id: LONG_ID,
      areas: [
        { x: [1.5, 4.5], z: [2, 6], y: 'all' },
        { x: [2.25, 3.75], z: [3, 5], y: [64.25, 70.5] },
        { shape: 'circle', center: [3, 4], radius: 1.25, y: [64, 68] },
        { shape: 'polygon', points: [[1.5, 2], [4.5, 2], [4.5, 6], [1.5, 6]], y: 'all' },
      ],
      custom_data: {
        note: 'gate-note',
        count: 1.5,
        flag: true,
        empty: null,
        nest: { unknown_key: 'stay', deep: 2 },
        keep: ['alpha', 7, false, null],
      },
    },
    {
      id: 'solo',
      areas: [{ x: [0, 0], z: [0, 0], y: [64, 64] }],
      custom_data: {},
    },
  ],
  landmarks: [{
    id: 'mark',
    kind: 'rpgtoolkit:pos',
    param: { x: 10.25, y: 64, z: -3.5 },
    custom_data: { kept: true },
  }],
  custom_data: { author: 'qa' },
}
const OTHER_DOC = {
  tags: [],
  regions: [{ id: 'side', areas: [{ x: [0, 1], z: [0, 1], y: 'all' }] }],
  landmarks: [],
  custom_data: {},
}

const passed = []
const defects = []
const notCovered = [
  'Pointer-cancel, Escape, and blur on a real offline volume handle. Raycasting a WebGL handle from this script is not reliable; scripts/verify-level-cancel-ui.mjs already isolates that cancel and was not edited or rerun.',
  'Native ControlHub, Axiom hit-testing, and in-game gizmo acceptance. The 127.0.0.1:8765 portal in this run is a MOCK.',
]
let framePacket = null
const inputKeys = []

function textOf(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`
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
    if ((type === 1 || type === 2) && offset + 4 <= buffer.byteLength) keys.push({ type, mods, key: view.getUint16(offset, true) })
    offset += payload
  }
  return keys
}

function reply(ws, id, result) {
  ws.send(JSON.stringify({ type: 'response', id, ok: true, result }))
}

async function installPortal(target) {
  await target.route(/^http:\/\/127\.0\.0\.1:8765\/(?:health|control\/status|status|stream\/start|stream\/stop)(?:\?.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname
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
      let revision = 0
      ws.onMessage((message) => {
        if (typeof message !== 'string') return
        let frame
        try { frame = JSON.parse(message) } catch { return }
        if (frame?.type !== 'request' || typeof frame.method !== 'string') return
        const params = frame.params ?? {}
        if ((frame.method === 'level.edit.begin' || frame.method === 'level.edit.sync') && Number.isSafeInteger(params.revision)) revision = params.revision
        if (frame.method === 'level.editor.shortcut') {
          ws.send(JSON.stringify({ type: 'notify', method: 'level.editor.action', params: { v: 1, sessionId: params.sessionId, documentId: params.documentId, revision, action: params.action } }))
        }
        if (frame.method === 'items.renderSnapshots') {
          reply(ws, frame.id, { componentFormat: 'tnbt-json-v1', componentMode: 'complete', snapshots: [] })
          return
        }
        reply(ws, frame.id, {
          ok: true,
          sessionId: params.sessionId,
          documentId: params.documentId,
          revision: params.revision,
        })
      })
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

const distIndex = join('dist', 'index.html')
const serverBinary = join('src-tauri', 'target', 'debug', 'project-server.exe')
assert.equal(existsSync(distIndex), true, `finished dist is required at ${distIndex}`)
assert.equal(existsSync(serverBinary), true, `project server is required at ${serverBinary}`)
await mkdir(ART, { recursive: true })

const h = await harness({ web: true })
const hubFile = join(h.root, HUB)
let browser
let page
let commitPosts = 0
const pageErrors = []
const seeded = textOf(HUB_DOC)

try {
  const owner = await h.login(h.credential, 'region redesign seed')
  await h.commit(owner.token, [
    { path: HUB, content: seeded },
    { path: OTHER, content: textOf(OTHER_DOC) },
  ])
  assert.equal(await readFile(hubFile, 'utf8'), seeded, 'seed must land through S before the editor opens')
  const account = await h.api(owner.token, '/api/subjects', 'POST', { name: 'Region QA', kind: 'account', role: 'editor' })
  await h.release(owner.token)

  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await installPortal(context)
  page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/files/commit') commitPosts += 1
  })
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

  const pane = () => page.locator('.app-workspace-pane.active')
  const tab = (name) => pane().locator('.editor-dock').getByRole('tab', { name, exact: true })
  const row = (name) => pane().locator('[role=treeitem]').filter({ has: page.locator(`.flow-resource-name:text-is(${JSON.stringify(name)})`) })
  const expand = async (name) => {
    const target = row(name)
    await target.waitFor()
    if (await target.getAttribute('aria-expanded') !== 'true') await target.click()
  }
  const undoButton = () => page.getByRole('button', { name: '撤销地图编辑', exact: true })
  const redoButton = () => page.getByRole('button', { name: '重做地图编辑', exact: true })
  const field = (name) => page.getByRole('textbox', { name, exact: true }).or(page.getByRole('spinbutton', { name, exact: true })).or(page.getByLabel(name, { exact: true }))
  const xMax = () => field('矩形 X 最大')
  const tree = () => page.getByRole('tree', { name: '地图对象', exact: true })
  // SVG <title> prepends the shape to the button text, so match the visible id span.
  const volumesNamed = (index, shape) => tree().locator('button.level-tree-volume').filter({
    has: page.locator('span.level-tree-id', { hasText: new RegExp(`^${index} ${shape}$`) }),
  })
  const volume = (index, shape) => volumesNamed(index, shape).first()
  // Region custom data lives in a closed <details class="level-extension-data">. Role queries skip that hidden subtree.
  function hubEditor() {
    return page.locator('.level-editor').filter({ has: page.locator(`h2[title="${LONG_ID}"]`) })
  }
  function extensionData() {
    return hubEditor().locator('details.level-extension-data')
  }
  const custom = () => extensionData().locator('section[aria-label="自定义数据"]')
  const jsonBox = () => custom().locator('textarea[aria-label="custom_data"]')

  async function disk() {
    return readFile(hubFile, 'utf8')
  }
  async function pass(name) {
    passed.push(name)
    console.log(`PASS ${name}`)
  }
  async function blurCommit(locator, value) {
    await locator.click()
    await locator.fill(value)
    await locator.evaluate((node) => node.blur())
  }
  function resourceFilter() {
    return page.getByRole('region', { name: '游戏性工作区', exact: true, includeHidden: true }).getByLabel('筛选资源', { exact: true })
  }
  async function ensureExplorer() {
    // Focus hides the dock band with display:none; the input stays in the DOM.
    // Before a level is open the same input can be attached under another workspace, with no 显示资源 button yet.
    const show = page.getByRole('button', { name: '显示资源', exact: true })
    if (await show.isVisible()) {
      await show.click()
      await resourceFilter().waitFor({ state: 'visible' })
      return
    }
    if (await resourceFilter().count()) return
    await resourceFilter().waitFor({ state: 'attached' })
  }
  async function openLevel(name) {
    await ensureExplorer()
    await page.getByRole('tab', { name: '游戏性', exact: true }).click()
    await expand('地图')
    await expand('地图模板')
    const target = row(name)
    await target.click()
    try {
      await tab(name).waitFor({ state: 'visible', timeout: 3000 })
    } catch {
      // A click while this document is still the open tab does not reopen it.
      if (name !== 'other.level') await row('other.level').click()
      await target.click()
      await tab(name).waitFor({ state: 'visible' })
    }
  }
  async function openExtension() {
    const details = extensionData()
    await details.waitFor({ state: 'attached' })
    if (!(await details.evaluate((element) => element.open))) await details.locator('> summary').click()
  }
  async function openCustomNode(name) {
    await openExtension()
    const node = custom().locator('details.level-custom-node').filter({
      has: page.locator('.level-custom-key', { hasText: new RegExp(`^${name}$`) }),
    }).first()
    await node.waitFor({ state: 'attached' })
    if (!(await node.evaluate((element) => element.open))) await node.locator('> summary').click()
  }
  async function openJson() {
    await openExtension()
    const details = custom().locator('details.level-custom-json')
    await details.waitFor({ state: 'attached' })
    if (!(await details.evaluate((element) => element.open))) await details.locator('> summary').click()
  }
  async function menuItem(menuName, itemName) {
    await page.getByRole('button', { name: menuName, exact: true }).click()
    await page.getByRole('menuitem', { name: itemName, exact: true }).click()
  }
  function shortcutKeys(code) {
    return inputKeys.filter((item) => item.type === 1 && item.key === code && (item.mods & 0x0002) !== 0)
  }

  await loginProject(page, h.base, account.credential, 'region redesign qa')
  await openLevel('hub.level')
  const canvas = page.getByLabel('三维体积视图', { exact: true })
  await canvas.waitFor()
  const desktopBox = await canvas.boundingBox()
  assert.ok(desktopBox && desktopBox.width > 200 && desktopBox.height > 120, `desktop canvas ${JSON.stringify(desktopBox)}`)
  await pass('desktop canvas has a usable box')

  assert.equal(await page.getByRole('button', { name: '显示资源', exact: true }).count(), 1)
  assert.equal(await resourceFilter().isVisible(), false)
  await pass('focus mode hides the resource tree and offers 显示资源')
  const locale = page.locator('details.flow-level-locale').first()
  await locale.waitFor()
  assert.equal(await locale.evaluate((element) => element.open), false)
  assert.match(await locale.locator('summary').innerText(), /地标本地化/)
  await pass('bottom locale details is folded by default')
  await page.screenshot({ path: join(ART, 'codex-redesign-qa-desktop.png') })

  assert.equal(await undoButton().isDisabled(), true)
  await page.getByRole('button', { name: '对准选中 F', exact: true }).click()
  await page.getByLabel('视图方向', { exact: true }).selectOption('top')
  await page.getByLabel('视图方向', { exact: true }).selectOption('perspective')
  await canvas.focus()
  await page.keyboard.press('f')
  assert.equal(await undoButton().isDisabled(), true)
  assert.equal(await disk(), seeded)
  await pass('focus F and view changes do not enter history or the file')

  async function selectVolume(index, shape) {
    const scoped = hubEditor()
    const byTree = page.locator('.level-editor').filter({ has: page.locator('.level-tree-id', { hasText: LONG_ID }) })
    const root = (await scoped.count()) ? scoped : (await byTree.count()) ? byTree : page
    const item = root.locator('button.level-tree-volume').filter({
      has: page.locator('span.level-tree-id', { hasText: new RegExp(`^${index} ${shape}$`) }),
    }).first()
    await item.click()
    assert.equal(await item.getAttribute('aria-selected'), 'true')
  }
  await selectVolume(1, '矩形')
  assert.match(await page.locator('.level-status-selection').innerText(), new RegExp(`${LONG_ID} / 体积 1 · 共 4 个`))
  assert.equal(await field('矩形 X 最小').inputValue(), '1.5')
  assert.equal(await xMax().inputValue(), '4.5')
  assert.equal(await field('矩形 Z 最小').inputValue(), '2')
  assert.equal(await field('矩形 Z 最大').inputValue(), '6')
  assert.equal(await page.getByRole('radio', { name: '全部高度', exact: true }).isChecked(), true)
  assert.equal(await field('Y 最小').count(), 0)
  assert.match(await volume(1, '矩形').innerText(), /全高/)
  await pass('volume 1 all-height rect is selected from the tree with fractional XZ')

  await selectVolume(2, '矩形')
  assert.match(await page.locator('.level-status-selection').innerText(), /体积 2 · 共 4 个/)
  assert.equal(await field('矩形 X 最小').inputValue(), '2.25')
  assert.equal(await xMax().inputValue(), '3.75')
  assert.equal(await field('Y 最小').inputValue(), '64.25')
  assert.equal(await field('Y 最大').inputValue(), '70.5')
  assert.equal(await page.getByRole('radio', { name: '限定高度', exact: true }).isChecked(), true)
  assert.match(await volume(2, '矩形').innerText(), /限高/)
  await pass('volume 2 bounded rect keeps fractional X and Y')

  await selectVolume(3, '圆')
  assert.equal(await field('圆心 X').inputValue(), '3')
  assert.equal(await field('圆心 Z').inputValue(), '4')
  assert.equal(await field('半径').inputValue(), '1.25')
  assert.equal(await field('Y 最小').inputValue(), '64')
  assert.equal(await field('Y 最大').inputValue(), '68')
  await pass('volume 3 circle exposes center, radius, and bounded height')

  await selectVolume(4, '多边形')
  assert.equal(await field('顶点 1 X').inputValue(), '1.5')
  assert.equal(await field('顶点 1 Z').inputValue(), '2')
  assert.equal(await field('顶点 3 X').inputValue(), '4.5')
  assert.equal(await page.getByRole('radio', { name: '全部高度', exact: true }).isChecked(), true)
  assert.equal(await field('Y 最小').count(), 0)
  await pass('volume 4 polygon exposes fractional vertices and all-height')

  await tree().locator('[role="treeitem"].level-tree-landmark').filter({ hasText: 'mark' }).click()
  assert.equal(await field('地标 X').inputValue(), '10.25')
  assert.equal(await field('地标 Z').inputValue(), '-3.5')
  await pass('landmark keeps fractional coordinates')

  const solo = volumesNamed(1, '矩形').nth(1)
  await solo.click()
  assert.equal(await field('矩形 X 最小').inputValue(), '0')
  assert.equal(await xMax().inputValue(), '0')
  assert.equal(await field('矩形 Z 最小').inputValue(), '0')
  assert.equal(await field('矩形 Z 最大').inputValue(), '0')
  assert.equal(await field('Y 最小').inputValue(), '64')
  assert.equal(await field('Y 最大').inputValue(), '64')
  assert.equal(await page.getByRole('button', { name: '删除区域「solo」', exact: true }).count(), 1)
  assert.equal(await page.getByText('删除整个区域', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /删除体积/ }).count(), 0)
  await pass('one-volume solo shows a single destructive button and single-block bounds')

  await selectVolume(1, '矩形')
  const beforeSame = await undoButton().isDisabled()
  assert.equal(beforeSame, true)
  await blurCommit(xMax(), '4.5')
  assert.equal(await undoButton().isDisabled(), true)
  assert.equal(await disk(), seeded)
  await pass('unchanged coordinate blur does not add history or a commit')

  const started = Date.now()
  await blurCommit(xMax(), '8.25')
  await blurCommit(xMax(), '9.75')
  const gap = Date.now() - started
  assert.equal(await xMax().inputValue(), '9.75')
  await undoButton().click()
  assert.equal(await xMax().inputValue(), '8.25', `two commits ${gap}ms apart must stay separate, undo once`)
  await undoButton().click()
  assert.equal(await xMax().inputValue(), '4.5')
  await redoButton().click()
  assert.equal(await xMax().inputValue(), '8.25')
  assert.equal(await disk(), seeded)
  await pass(`two distinct commits ${gap}ms apart stay separate, with one undo and one redo`)

  await xMax().fill('11.5')
  await undoButton().click()
  assert.equal(await xMax().inputValue(), '8.25')
  await pass('first toolbar undo from a focused valid field returns to the previous commit')

  await menuItem('编辑', '撤销')
  assert.equal(await xMax().inputValue(), '4.5')
  await redoButton().click()
  assert.equal(await xMax().inputValue(), '8.25')
  await canvas.focus()
  await page.keyboard.press('Control+z')
  assert.equal(await xMax().inputValue(), '4.5')
  await page.keyboard.press('Control+y')
  assert.equal(await xMax().inputValue(), '8.25')
  await pass('menu undo, toolbar redo, and global Ctrl+Z/Ctrl+Y share one history step')

  inputKeys.length = 0
  await page.getByRole('button', { name: '游戏内', exact: true }).click()
  const stream = page.getByLabel('本地云游戏画面', { exact: true })
  await stream.waitFor()
  await page.waitForFunction(() => document.querySelector('.level-stream')?.getAttribute('data-state') === 'live')
  await stream.focus()
  await page.keyboard.press('Control+z')
  await page.waitForFunction(() => document.querySelector('input[aria-label="矩形 X 最大"]')?.value === '4.5')
  await page.getByRole('button', { name: '离线 3D', exact: true }).click()
  await canvas.waitFor()
  await selectVolume(1, '矩形')
  assert.equal(await xMax().inputValue(), '4.5')
  assert.equal(shortcutKeys(90).length, 0, 'MOCK stream must not receive Ctrl+Z; this is not native acceptance')
  await page.getByRole('button', { name: '游戏内', exact: true }).click()
  await stream.waitFor()
  await page.waitForFunction(() => document.querySelector('.level-stream')?.getAttribute('data-state') === 'live')
  await stream.focus()
  await page.keyboard.press('Control+y')
  await page.waitForFunction(() => document.querySelector('input[aria-label="矩形 X 最大"]')?.value === '8.25')
  await page.getByRole('button', { name: '离线 3D', exact: true }).click()
  await canvas.waitFor()
  await selectVolume(1, '矩形')
  assert.equal(await xMax().inputValue(), '8.25')
  assert.equal(shortcutKeys(89).length, 0)
  assert.equal(await disk(), seeded)
  await pass('MOCK stream Ctrl+Z/Ctrl+Y uses the same history path and is not forwarded')

  await openLevel('other.level')
  await tab('other.level').click()
  assert.equal(await tab('other.level').getAttribute('aria-selected'), 'true')
  await page.locator('.level-tree-id', { hasText: /^side$/ }).first().waitFor()
  await tab('hub.level').click()
  await selectVolume(1, '矩形')
  assert.equal(await xMax().inputValue(), '8.25')
  await undoButton().click()
  assert.equal(await xMax().inputValue(), '4.5')
  await redoButton().click()
  assert.equal(await xMax().inputValue(), '8.25')
  assert.equal(await disk(), seeded)
  await pass('switching to other.level and back keeps hub undo and redo')

  await openCustomNode('nest')
  await blurCommit(custom().getByLabel('nest.unknown_key', { exact: true }), 'stay-edited')
  await openCustomNode('keep')
  await blurCommit(custom().getByLabel('keep[0]', { exact: true }), 'beta')
  await blurCommit(custom().getByLabel('keep[1]', { exact: true }), '9.5')
  const bool = custom().getByRole('switch', { name: 'keep[2]', exact: true })
  assert.equal(await bool.getAttribute('aria-checked'), 'false')
  await bool.scrollIntoViewIfNeeded()
  const switchHits = await bool.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const samples = [
      ['left', rect.left + 3, rect.top + rect.height / 2],
      ['center', rect.left + rect.width / 2, rect.top + rect.height / 2],
    ]
    return samples.map(([spot, x, y]) => {
      const target = document.elementFromPoint(x, y)
      return {
        spot,
        x,
        y,
        hit: target?.getAttribute?.('aria-label') || target?.textContent?.trim().slice(0, 24) || '',
        onSwitch: target === element || !!element.contains(target),
      }
    })
  })
  if (!switchHits.find((point) => point.spot === 'center' && point.onSwitch)) {
    defects.push({
      name: 'boolean custom switch center is covered by its remove button',
      file: 'src/workspaces/gameplay/levelCustomData.css:8',
      detail: `Desktop inspector: keep[2] pointer samples ${JSON.stringify(switchHits)}. The row grid minmax(0, 1.5fr) lets 移除 keep[2] take the switch hit target.`,
    })
  }
  const openPoint = switchHits.find((point) => point.onSwitch)
  if (openPoint) await page.mouse.click(openPoint.x, openPoint.y)
  else await bool.evaluate((element) => element.click())
  assert.equal(await bool.getAttribute('aria-checked'), 'true')
  await custom().locator('.level-custom-null', { hasText: '空值' }).first().waitFor()
  await custom().getByLabel('新键名', { exact: true }).fill('sibling')
  await custom().getByLabel('新键值', { exact: true }).fill('stay')
  await custom().getByRole('button', { name: '添加键', exact: true }).click()
  await custom().getByLabel('sibling', { exact: true }).waitFor()
  await custom().getByRole('button', { name: '移除 keep[0]', exact: true }).click()
  await openCustomNode('keep')
  assert.equal(await custom().getByLabel('keep[0]', { exact: true }).inputValue(), '9.5')
  await undoButton().click()
  await openCustomNode('keep')
  assert.equal(await custom().getByLabel('keep[0]', { exact: true }).inputValue(), 'beta')
  assert.equal(await custom().getByLabel('sibling', { exact: true }).inputValue(), 'stay')
  await undoButton().click()
  assert.equal(await custom().getByLabel('sibling', { exact: true }).count(), 0)
  await openCustomNode('keep')
  assert.equal(await custom().getByLabel('keep[0]', { exact: true }).inputValue(), 'beta')
  assert.equal(await custom().getByLabel('keep[1]', { exact: true }).inputValue(), '9.5')
  assert.equal(await custom().getByRole('switch', { name: 'keep[2]', exact: true }).getAttribute('aria-checked'), 'true')
  await openCustomNode('nest')
  assert.equal(await custom().getByLabel('nest.unknown_key', { exact: true }).inputValue(), 'stay-edited')
  assert.equal(await disk(), seeded)
  await pass('typed custom tree edits nested values and one undo restores a deleted sibling')

  await openJson()
  await jsonBox().fill('{bad')
  await page.screenshot({ path: join(ART, 'codex-redesign-qa-custom-invalid.png') })
  assert.equal(await jsonBox().inputValue(), '{bad')
  assert.equal(await custom().getByRole('button', { name: '应用', exact: true }).isDisabled(), true)
  await custom().getByText(/尚未应用|JSON|无效|解析|格式/).first().waitFor()
  const postsAtInvalid = commitPosts
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(400)
  assert.equal(commitPosts, postsAtInvalid)
  assert.equal(await disk(), seeded)
  assert.equal(await jsonBox().inputValue(), '{bad')
  await pass('invalid advanced JSON stays visible and blocks Ctrl+S')

  const otherCount = await tab('other.level').count()
  await ensureExplorer()
  await row('other.level').click()
  await page.waitForTimeout(300)
  assert.equal(await tab('hub.level').getAttribute('aria-selected'), 'true')
  assert.equal(await tab('other.level').count(), otherCount)
  assert.equal(await jsonBox().inputValue(), '{bad')
  await tab('hub.level').getByRole('button', { name: '关闭 hub.level', exact: true }).click()
  await page.waitForTimeout(300)
  assert.equal(await tab('hub.level').count(), 1)
  assert.equal(await jsonBox().inputValue(), '{bad')
  await pass('invalid JSON blocks switching and closing the hub tab')

  await custom().getByRole('button', { name: '取消', exact: true }).click()
  assert.match(await jsonBox().inputValue(), /stay-edited/)
  assert.equal(await page.getByRole('button', { name: '放弃未完成编辑', exact: true }).count(), 0)
  await pass('cancel restores the canonical custom JSON and clears the pending banner')

  await jsonBox().fill('{"only":1}')
  assert.equal(await custom().getByRole('button', { name: '应用', exact: true }).isEnabled(), true)
  await ensureExplorer()
  await row('other.level').click()
  await page.waitForTimeout(300)
  assert.equal(await jsonBox().inputValue(), '{"only":1}')
  assert.equal(await tab('hub.level').getAttribute('aria-selected'), 'true')
  await page.getByRole('button', { name: '放弃未完成编辑', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '放弃未完成编辑', exact: true }).count(), 0)
  await row('other.level').click()
  await tab('other.level').waitFor()
  assert.equal(await tab('other.level').getAttribute('aria-selected'), 'true')
  await tab('hub.level').click()
  await selectVolume(1, '矩形')
  await openJson()
  assert.doesNotMatch(await jsonBox().inputValue(), /"only"/)
  assert.match(await jsonBox().inputValue(), /stay-edited/)
  await pass('explicit discard of unapplied JSON allows navigation and drops the draft')

  const applied = {
    note: 'gate-note',
    count: 1.5,
    flag: true,
    empty: null,
    nest: { unknown_key: 'stay-edited', deep: 2 },
    keep: ['beta', 9.5, true, null],
    extra_unknown: { n: 1, s: 'x', b: true, z: null },
  }
  await jsonBox().fill(JSON.stringify(applied, null, 2))
  await custom().getByRole('button', { name: '应用', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(await page.getByRole('button', { name: '放弃未完成编辑', exact: true }).count(), 0)
  const saving = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/files/commit' && response.request().method() === 'POST')
  await page.keyboard.press('Control+s')
  assert.equal((await (await saving).json()).status, 'committed')
  let saved = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    saved = await disk()
    if (saved.includes('stay-edited') && saved.includes('8.25')) break
    await page.waitForTimeout(100)
  }
  const savedDoc = JSON.parse(saved)
  const savedRegion = savedDoc.regions.find((item) => item.id === LONG_ID)
  assert.equal(savedRegion.areas[0].x[1], 8.25)
  assert.equal(savedRegion.areas[1].x[0], 2.25)
  assert.equal(savedRegion.areas[1].y[0], 64.25)
  assert.equal(savedRegion.areas[2].radius, 1.25)
  assert.equal(savedDoc.landmarks[0].param.x, 10.25)
  assert.equal(savedRegion.custom_data.keep[0], 'beta')
  assert.equal(savedRegion.custom_data.keep[1], 9.5)
  assert.equal(savedRegion.custom_data.keep[2], true)
  assert.equal(savedRegion.custom_data.keep[3], null)
  assert.equal(savedRegion.custom_data.nest.unknown_key, 'stay-edited')
  assert.equal(savedRegion.custom_data.extra_unknown.z, null)
  assert.equal(savedDoc.custom_data.author, 'qa')
  assert.equal(savedDoc.navigation, undefined)
  await pass('Ctrl+S writes fractions, nested unknown keys, and mixed custom values through S')

  await tab('hub.level').getByRole('button', { name: '关闭 hub.level', exact: true }).click()
  await tab('hub.level').waitFor({ state: 'hidden' })
  await openLevel('hub.level')
  await selectVolume(1, '矩形')
  assert.equal(await xMax().inputValue(), '8.25')
  await openCustomNode('nest')
  assert.equal(await custom().getByLabel('nest.unknown_key', { exact: true }).inputValue(), 'stay-edited')
  await openCustomNode('keep')
  assert.equal(await custom().getByLabel('keep[0]', { exact: true }).inputValue(), 'beta')
  assert.equal(await custom().getByLabel('keep[1]', { exact: true }).inputValue(), '9.5')
  await pass('reopen keeps the saved fraction and nested custom values')

  await selectVolume(2, '矩形')
  await page.getByRole('button', { name: '删除体积 2（矩形）', exact: true }).click()
  assert.match(await hubEditor().locator('.level-status-selection').innerText(), /共 3 个/)
  await undoButton().click()
  await selectVolume(2, '矩形')
  assert.match(await hubEditor().locator('.level-status-selection').innerText(), /体积 2 · 共 4 个/)
  await hubEditor().locator('summary', { hasText: '删除整个区域' }).click()
  await page.getByRole('button', { name: `删除区域「${LONG_ID}」的全部 4 个体积`, exact: true }).click()
  assert.equal(await tree().getByText(LONG_ID, { exact: true }).count(), 0)
  await undoButton().click()
  await tree().getByText(LONG_ID, { exact: true }).waitFor()
  assert.equal(await disk(), saved)
  await pass('volume delete and region delete each change the count and undo once')

  await page.setViewportSize({ width: 420, height: 800 })
  await selectVolume(1, '矩形')
  const narrowCanvas = await canvas.boundingBox()
  const narrowField = await field('矩形 X 最小').boundingBox()
  assert.ok(narrowCanvas && narrowCanvas.width > 0 && narrowCanvas.height > 0, `narrow canvas ${JSON.stringify(narrowCanvas)}`)
  assert.ok(narrowField && narrowField.width > 0 && narrowField.height > 0, `narrow field ${JSON.stringify(narrowField)}`)
  await page.screenshot({ path: join(ART, 'codex-redesign-qa-narrow.png') })
  await pass('narrow viewport keeps the canvas and coordinate field usable')
  await page.setViewportSize({ width: 1440, height: 1100 })

  await openLevel('other.level')
  await tab('hub.level').click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '页签操作', exact: true })
  await menu.waitFor()
  await menu.getByRole('menuitem', { name: '移动与分栏', exact: true }).click()
  await page.getByRole('menuitem', { name: '移动到右侧新分栏', exact: true }).click()
  assert.equal(await pane().locator('.editor-dock-leaf').count(), 2)
  const sash = page.getByRole('separator', { name: '调整左右宽度', exact: true })
  const sashBox = await sash.boundingBox()
  assert.ok(sashBox, 'splitter is visible')
  await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + Math.min(40, sashBox.height / 2))
  await page.mouse.down()
  await page.mouse.move(sashBox.x + 700, sashBox.y + 40, { steps: 12 })
  await page.mouse.up()
  await tab('hub.level').click()
  await selectVolume(1, '矩形')
  const hubPane = await hubEditor().evaluate((node) => {
    const list = node.querySelector('.level-list')
    const input = [...node.querySelectorAll('input')].find((item) => item.getAttribute('aria-label') === '矩形 X 最小')
    const inputBox = input?.getBoundingClientRect()
    return {
      width: node.clientWidth,
      listPosition: list ? getComputedStyle(list).position : null,
      fieldWidth: inputBox?.width ?? 0,
      fieldHeight: inputBox?.height ?? 0,
    }
  })
  assert.ok(hubPane.width > 0 && hubPane.width < 899, `hub pane ${JSON.stringify(hubPane)}`)
  assert.equal(hubPane.listPosition, 'absolute')
  assert.ok(hubPane.fieldWidth > 0 && hubPane.fieldHeight > 0, `hub field ${JSON.stringify(hubPane)}`)
  await pass('container query keeps a narrow split pane usable and overlays the object list')
  await openJson()
  await jsonBox().fill('{bad')
  const postsBeforeRole = commitPosts
  const ownerAgain = await h.login(h.credential, 'region redesign role')
  await h.api(ownerAgain.token, `/api/subjects/${account.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  let readOnly = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const disabled = await hubEditor().locator('[aria-label="矩形 X 最小"]').isDisabled().catch(() => false)
    const hint = await hubEditor().locator('.level-status-hint').innerText().catch(() => '')
    if (disabled || hint.includes('只读')) { readOnly = true; break }
    await page.waitForTimeout(400)
  }
  if (!readOnly) {
    defects.push({
      name: 'viewer role does not reach the open level editor',
      file: 'src/workspaces/GameplayWorkspace.tsx:844',
      detail: 'Owner PATCH role=viewer succeeded, and after about 3 seconds 矩形 X 最小 stayed enabled and the status hint did not show 只读. Discard and the author file were still checked.',
    })
  } else {
    await pass('open editor follows the viewer role downgrade')
  }
  const discard = page.getByRole('button', { name: '放弃未完成编辑', exact: true })
  assert.equal(await discard.isEnabled(), true)
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(400)
  assert.equal(commitPosts, postsBeforeRole)
  await discard.scrollIntoViewIfNeeded()
  const discardHits = await discard.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const samples = [
      ['left', rect.left + 4, rect.top + rect.height / 2],
      ['center', rect.left + rect.width / 2, rect.top + rect.height / 2],
      ['right', rect.right - 4, rect.top + rect.height / 2],
    ]
    return samples.map(([spot, x, y]) => {
      const target = document.elementFromPoint(x, y)
      return {
        spot, x, y,
        hit: target?.getAttribute?.('aria-label') || target?.textContent?.trim().slice(0, 40) || '',
        tag: target?.tagName || '',
        onButton: target === element || !!element.contains(target),
      }
    })
  })
  if (!discardHits.find((point) => point.spot === 'center' && point.onButton)) {
    defects.push({
      name: 'narrow split inspector overlay covers 放弃未完成编辑',
      file: 'src/workspaces/gameplay/LevelEditor.css:807',
      detail: `Hub pane under 899px: pointer samples ${JSON.stringify(discardHits)}. @container level-workspace sets .level-inspector to position:absolute; top:0; bottom:0; z-index:3, so a summary inside aside.level-inspector covers the pending banner. The matching @media rule is LevelEditor.css:758.`,
    })
  }
  const discardPoint = discardHits.find((point) => point.onButton)
  if (discardPoint) await page.mouse.click(discardPoint.x, discardPoint.y)
  else await discard.evaluate((element) => element.click())
  assert.equal(await page.getByRole('button', { name: '放弃未完成编辑', exact: true }).count(), 0)
  assert.equal(await disk(), saved)
  assert.equal(JSON.parse(await disk()).custom_data.author, 'qa')
  await pass('viewer pending cancel stays available and does not write the author file')

  assert.deepEqual(pageErrors, [])
  await pass('no page errors')
  console.log(`MOCK portal ${MOCK_PORT}: native acceptance was not claimed`)
  await writeFile(join(ART, 'codex-redesign-qa-run.json'), JSON.stringify({
    ok: defects.length === 0,
    mock: true,
    nativeAcceptance: false,
    passed,
    defects,
    notCovered,
    pageErrors,
    screenshots: [
      join(ART, 'codex-redesign-qa-desktop.png'),
      join(ART, 'codex-redesign-qa-narrow.png'),
      join(ART, 'codex-redesign-qa-custom-invalid.png'),
    ],
  }, null, 2))
} catch (error) {
  const failureShot = join(ART, 'codex-redesign-qa-failure.png')
  if (page) await page.screenshot({ path: failureShot }).catch(() => {})
  await writeFile(join(ART, 'codex-redesign-qa-run.json'), JSON.stringify({
    ok: false,
    mock: true,
    nativeAcceptance: false,
    passed,
    defects,
    notCovered,
    pageErrors,
    error: String(error?.stack || error),
    failureShot,
  }, null, 2))
  throw error
} finally {
  await browser?.close()
  await h.stop()
}
