/** Native game workbench + real project S + production streaming. Requires an owned isolated no-Axiom client. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { loginProject, closeCollaboration } from './project-ui-helpers.mjs'
import { INTERACTIVE_STREAM_BODY, RPIN_BUTTON_DOWN, RPIN_BUTTON_UP, RPIN_KEY_DOWN, RPIN_KEY_UP, RPIN_MOVE, encodeRpin, devtoolStreamEndpoints, pictureLetterbox } from '../src/workspaces/gameplay/streamInput.ts'

const target = process.env.REGION_MCT_TARGET, wrapper = process.env.REGION_MCT_WRAPPER
assert.ok(target && wrapper, 'Explicit isolated native test target and maintained wrapper required')
const artifacts = resolve(process.env.REGION_NATIVE_ARTIFACTS ?? 'node_modules/.cache/native-world-editor')
await mkdir(artifacts, { recursive: true })
const bridge = spawn('python', ['-u', wrapper], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
const pending: { label: string; resolve(value: any): void; reject(error: Error): void }[] = []
createInterface({ input: bridge.stdout }).on('line', line => {
  const event = JSON.parse(line); if (event.ready) return
  const next = pending.shift(); if (!next) return
  if (event.error || event.result?.error) next.reject(Error(next.label + ": " + JSON.stringify(event)))
  else next.resolve(event.result)
})
bridge.on('exit', code => { for (const p of pending.splice(0)) p.reject(Error(`bridge exited: ${code}`)) })
function nativeOnce(tool: string, args: Record<string, unknown> = {}): Promise<any> { return new Promise((resolve, reject) => { pending.push({ label: tool + (args.select ? ' '+JSON.stringify(args.select) : ''), resolve, reject }); bridge.stdin.write(JSON.stringify({ tool, args: { target, ...args } }) + '\n') }) }
async function native(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return await nativeOnce(tool, args) }
    catch (error) {
      if (tool !== 'mct_act' || !String(error).includes('stale_token') || attempt >= 3) throw error
      await nativeOnce('mct_state', { afterFrames: 15 })
    }
  }
}
const state = () => native('mct_state', { afterFrames: 3 })
async function until(fn: () => Promise<any>, label: string, timeout = 18000) {
  const end = Date.now() + timeout; let last: any
  while (Date.now() < end) { last = await fn(); if (last) return last; await new Promise(r => setTimeout(r, 100)) }
  throw Error(`Timed out: ${label}; last=${JSON.stringify(last)}`)
}
async function widget(text: string, type?: string) {
  const s = await state(); const found = s.widgets.filter((w: any) => w.visible && w.text === text && (!type || w.type === type))
  assert.equal(found.length, 1, `one native widget ${text}: ${JSON.stringify(s.widgets)}`); return { s, w: found[0] }
}
async function press(text: string) { return native('mct_act', { action: 'press', select: { text }, settleFrames: 4 }) }
async function readyPress(text:string) { await until(async () => (await state()).widgets.some((w:any)=>w.type==='button'&&w.text===text&&w.active&&w.visible), 'native action ready: '+text); return press(text) }
async function deleteNative() { await until(async () => (await state()).widgets.some((w: any) => w.type === 'button' && w.text.includes('删除') && w.active), 'native delete available after draft acknowledgement'); return native('mct_act', { action: 'press', select: { textContains: '删除', type: 'button' }, settleFrames: 4 }) }
async function set(text: string, value: string) { await until(async () => (await state()).widgets.some((w: any) => w.text === text && w.type === 'edit_box' && w.active), 'native input available after author acknowledgement'); return native('mct_act', { action: 'set_text', select: { text, type: 'edit_box' }, text: value, settleFrames: 4 }) }
async function dragWidget(text: string, dx: number, dy: number) {
  let previous = ''
  for (let i = 0; i < 30; i++) { const s = await native('mct_state', { afterFrames: 8 }); if (s.screenToken === previous) break; previous = s.screenToken }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { s, w } = await widget(text)
    try { return await native('mct_drag', { screenToken: s.screenToken, widgetId: w.id, dx, dy }) }
    catch (error) { if (!String(error).includes('stale_token') || attempt === 3) throw error }
  }
}
async function command(command: string) { const r = await native('mct_server_command', { command }); await state(); return r }
const prefs = { host: '127.0.0.1', port: Number(process.env.REGION_NATIVE_PORT ?? 8768), password: process.env.REGION_NATIVE_PASSWORD ?? 'mchhui' }
const endpoints = devtoolStreamEndpoints(prefs), headers = { 'X-DevTool-Password': prefs.password, 'Content-Type': 'application/json' }
let input: WebSocket | undefined, sequence = 0
async function send(events: any[], afterFrames = 4) { assert.equal(input?.readyState, WebSocket.OPEN); input!.send(encodeRpin(events.map(e => ({ flags: 0, mods: 0, seq: ++sequence, ...e })))); return native('mct_state', { afterFrames }) }
async function click(button = 1) { await send([{ type: RPIN_BUTTON_DOWN, button, x: 640, y: 360 }]); await send([{ type: RPIN_BUTTON_UP, button, x: 640, y: 360 }]) }
async function startInput() {
  const r = await fetch(endpoints.start, { method: 'POST', headers, body: JSON.stringify(INTERACTIVE_STREAM_BODY) }); assert.equal(r.status, 200)
  input = new WebSocket(endpoints.input)
  await new Promise<void>((resolve, reject) => { input!.addEventListener('open', () => resolve(), { once: true }); input!.addEventListener('error', () => reject(Error('RPIN open')), { once: true }) })
}
async function stopInput() { input?.close(); input = undefined; await fetch(endpoints.stop, { method: 'POST', headers }) }
const report: any = { native: true, mocked: false, noAxiom: true, passed: [], captures: [], pageErrors: [], editTrace: [], authorCommits: [] }
function pass(label: string) { report.passed.push(label); console.log('PASS NATIVE', label) }
async function capture(name: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = await native('mct_state', { afterFrames: 20 }); const crop = { x: 0, y: 0, width: s.window.width, height: s.window.height }
    try {
      const result = await native('mct_capture', { screenToken: s.screenToken, crop, waitFrames: 3 })
      report.captures.push({ name, purpose: 'Verify native workbench world, layout and projected controls at original framebuffer resolution', ...result }); return
    } catch (error) { if (!String(error).includes('stale_token') || attempt === 4) throw error }
  }
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let h: any
const path = 'src/level/native_editor.level'
const initial = { tags: ['native-workbench'], regions: [{ id: '院子', areas: [{ x: [82, 93], z: [-200, -190], y: [80, 83] }], custom_data: { nested: { keep: ['a', 2] } } }], landmarks: [], custom_data: { acceptance: 'preserve-region-extra', priority: 3, enabled: true, nested: { keep: ['a', 2] } } }
const initialText = JSON.stringify(initial, null, 2) + '\n'
try {
  let s = await until(async () => { const s = await state().catch(error => { if (/Bridge unavailable|WinError 2/.test(String(error))) return null; throw error }); if (!s) return false; const warning = s.widgets.find((w: any) => w.text === '继续进入主菜单'); if (warning) { await native('mct_press', { screenToken: s.screenToken, widgetId: warning.id }); return false }; return s.player && s.world && (!s.screen || s.screen.class.endsWith('RegionEditScreen')) ? s : false }, 'owned test world loaded', 60000); assert.equal(s.player.name, 'Dev'); assert.ok(s.world.integratedServer); if (s.screen?.class.endsWith('RegionEditScreen')) { await native('mct_close_screen', { screenToken: s.screenToken }); s = await state() }; assert.equal(s.screen, null)
  report.session = s.session
  const health = await fetch(`http://${prefs.host}:${prefs.port}/health`, { headers }).then(r => r.json()); assert.ok(!health.services.includes('tiles')); assert.equal((await fetch(`http://${prefs.host}:${prefs.port}/tiles/status`, { headers })).status, 404)
  pass('obsolete web map tile service and HTTP route are removed')
  await command('gamemode creative Dev'); await command('fill 68 80 -218 110 80 -170 minecraft:stone'); await command('fill 68 81 -218 110 95 -170 minecraft:air'); await command('tp Dev 88.5 81 -207.5 0 60')
  await command('item replace entity Dev weapon.mainhand with rpgtoolkit:map_wand')
  await until(async () => { const s = await state(); return s.player.y === 81 && s.player.x === 88.5 }, 'player stands on the owned test platform without assuming creative flight')
  const playerBefore = (await native('mct_server_state')).players
  await startInput(); await click()
  await until(async () => (await state()).screen?.class.endsWith('RegionEditScreen'), 'wand opens independent workbench')
  await widget('复制'); await widget('世界视口')
  // Repeated runs clean only this owned world's unsaved local editor draft, through native product actions.
  for (let i = 0; i < 20; i++) {
    const row = (await state()).widgets.find((w: any) => /\/ \d+$/.test(w.text))
    if (!row) break
    await press(row.text); await deleteNative(); await native('mct_state', { afterFrames: 15 })
  }
  pass('map wand right-click opens native standalone workbench with no Axiom dependency')
  await press('矩形 B')
  let view = await widget('世界视口')
  assert.ok((await dragWidget('世界视口', 120, 70)).pressHandled)
  await until(async () => (await state()).widgets.some((w: any) => w.text.endsWith('/ 1')), 'standalone rectangle created')
  await press('对准 F'); await state()
  await until(async () => (await state()).widgets.some((w: any) => w.text === '控制点 Y 上界' && w.visible), 'finite native height gizmo')
  await capture('standalone-rectangle')
  pass('native rectangle creation uses world geometry and exposes a draggable finite upper face')
  let top = await widget('控制点 Y 上界')
  const localY = top.s.widgets.filter((w: any) => w.type === 'edit_box')[2].text
  await dragWidget('控制点 Y 上界', 0, -25)
  const localChanged = await until(async () => { const fields = (await state()).widgets.filter((w: any) => w.type === 'edit_box'); return fields[2]?.text && fields[2].text !== localY ? fields[2].text : false }, 'local Y drag changes actual property')
  await press('撤销'); await until(async () => (await state()).widgets.filter((w: any) => w.type === 'edit_box')[2]?.text === localY, 'local undo')
  await press('重做'); await until(async () => (await state()).widgets.filter((w: any) => w.type === 'edit_box')[2]?.text === localChanged, 'local redo')
  pass('standalone projected height control accepts native drag and local undo/redo')
  await press('关闭'); assert.equal((await state()).screen, null)
  assert.deepEqual((await native('mct_server_state')).players, playerBefore, 'world camera never moves the server player')
  await stopInput()
  pass('closing native editor restores gameplay camera without moving authoritative player')

  h = await harness({ web: true })
  const owner = await h.login(h.credential, 'native world editor fixture')
  await h.commit(owner.token, [{ path, content: initialText }]); await h.release(owner.token)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } }); page.setDefaultTimeout(14000)
  await page.addInitScript(() => {
    const times: number[] = []; (window as any).__nativeFrameTimes = times
    const original = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if (this.canvas.closest('.level-stream')) { times.push(performance.now()); if (times.length > 2000) times.shift() }
      return (original as any).apply(this, args)
    } as any
  })
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('websocket', socket => {
    for (const event of ['framesent', 'framereceived'] as const) socket.on(event, frame => {
      try {
        const message = JSON.parse(String(frame.payload))
        if (event === 'framereceived' && Array.isArray(message.result?.shaders)) report.shaderLibrary = message.result.shaders
        if (event === 'framereceived' && message.result?.effectsPreview) report.effectsPreview = message.result.effectsPreview
        if (typeof message.method !== 'string' || !message.method.startsWith('level.edit.')) return
        const p = message.params || {}
        const trace = { direction: event, method: message.method, phase: p.phase, reason: p.reason, revision: p.revision ?? p.baseRevision, selection: p.selection, gestureId: p.gestureId }
        report.editTrace.push(trace)
        if (event === 'framereceived' && message.method === 'level.edit.changed') {
          if (p.phase === 'commit') report.authorCommits.push(trace)
          if (p.phase === 'preview') report.lastNativePreview = trace
        }
        if (report.editTrace.length > 200) report.editTrace.shift()
      } catch { /* Product RPIN frames are binary; author documents are intentionally omitted. */ }
    })
  })
  await loginProject(page, h.base, h.credential, '原生世界编辑器实机验收'); await closeCollaboration(page)
  const button = (name: string) => page.getByRole('button', { name, exact: true })
  const field = (name: string) => page.getByLabel(name === 'X 最小' || name === 'X 最大' ? `矩形 ${name}` : name, { exact: true })
  await page.getByRole('tab', { name: '游戏性', exact: true }).click()
  await page.getByRole('treeitem', { name: 'native_editor.level', exact: true }).click(); await field('三维体积视图').waitFor()
  await page.locator('.level-tree-row > button[title="院子"]').click()
  const expand = button('展开区域 院子'); if (await expand.count()) await expand.click()
  await page.locator('.level-tree-volume').first().click()
  await button('编辑').click(); await page.getByRole('menuitem', { name: '游戏开发服务器', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '游戏开发服务器', exact: true })
  await dialog.getByLabel('端口', { exact: true }).fill(String(prefs.port)); await dialog.getByLabel('门户密码', { exact: true }).fill(prefs.password)
  await dialog.getByRole('button', { name: '应用', exact: true }).click(); await dialog.getByText('已连接', { exact: true }).waitFor(); await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await button('游戏内').click()
  await until(async () => (await state()).screen?.class.endsWith('RegionEditScreen'), 'browser opens native editor')
  const stream = page.getByLabel('本地云游戏画面', { exact: true }); await stream.waitFor()
  await until(async () => { const phase = await stream.getAttribute('data-state'); if (phase === 'error') throw Error('Browser stream: ' + await stream.textContent()); return phase === 'live' && await stream.getAttribute('data-frame') === '1' }, 'live browser stream with actual decoded frame')
  await native('mct_state', { afterFrames: 10 })
  await press('对准 F')
  await until(async () => (await state()).widgets.some((w: any) => w.text === '控制点 Y 上界' && w.visible), 'bound upper face')
  pass('browser interactive stream opens the same independent world workbench, retaining browser inspector')

  // Existing runtime effects must be authored through the visual inspector and rendered by the real client.
  await page.getByRole('tab', { name: '环境与音乐', exact: true }).click()
  await until(async () => await page.getByText('来自当前游戏资源库', { exact: true }).count(), 'typed game effect library is loaded')
  await page.getByLabel('启用环境雾', { exact: true }).check(); await button('清晨薄雾').click()
  await page.getByLabel('雾的作用方式', { exact: true }).selectOption('volume')
  await page.getByRole('tab', { name: /天空与云/ }).click(); await page.getByLabel('启用天空与云', { exact: true }).check()
  await page.getByRole('button', { name: /添加天空图层/ }).click(); await button('渐变天空').click()
  await page.getByRole('tab', { name: /画面滤镜/ }).click(); await page.getByLabel('启用画面滤镜', { exact: true }).check()
  if (process.env.REGION_EXPECT_PAK_EFFECT) { await page.getByRole('button', { name: /添加画面滤镜/ }).click(); await button('PAK森林滤镜').click() }
  await page.getByLabel('曝光', { exact: true }).fill('-0.6'); await page.getByLabel('曝光', { exact: true }).blur()
  await page.getByRole('tab', { name: /区域音乐/ }).click(); await page.getByLabel('启用区域音乐', { exact: true }).check()
  await page.getByLabel('音乐优先级', { exact: true }).fill('12'); await page.getByLabel('音乐优先级', { exact: true }).blur()
  await button('应用效果').click()
  await until(async () => await button('应用效果').isDisabled(), 'effects are acknowledged as the same author draft')
  await button('▶ 在游戏画面中预览').click()
  await until(async () => report.effectsPreview?.active && report.effectsPreview.skySource === 'editor_preview' && report.effectsPreview.postSource === 'editor_preview', 'actual sky/post render channel preview')
  await button('▶ 在游戏客户端试听').click(); await until(async () => report.effectsPreview?.music, 'real client music audition')
  if (process.env.REGION_EXPECT_PAK_EFFECT) { await button('刷新资源').click(); const entry=await until(async()=>report.shaderLibrary?.find((r:any)=>r.id==='project:published_tint'),'published client PAK resource is exposed by game library'); assert.ok(!entry.error,entry.error); report.publishedPakEffect=entry;pass('exported client PAK mounts namespaced GLSL and textures; actual game filter renders without GPU errors') }
  report.musicAudition = { ...report.effectsPreview }
  await capture('region-effects-real-render-preview')
  assert.equal(await readFile(join(h.root, path), 'utf8'), initialText)
  await button('■ 停止预览并恢复').click()
  await until(async () => report.effectsPreview && !report.effectsPreview.active && report.effectsPreview.skySource !== 'editor_preview' && report.effectsPreview.postSource !== 'editor_preview', 'stop restores the received environment')
  pass('browser authors fog/sky/post/music together and previews real render channels and client music without publishing')
  await press('环境与音乐'); await press('画面滤镜')
  await until(async () => (await state()).widgets.some((w: any) => w.type === 'edit_box' && w.text === '-0.6'), 'native typed effect control receives C exposure')
  await set('-0.6', '0.75'); await press('应用属性')
  await until(async () => await page.getByRole('tab', { name: /画面滤镜/ }).click().then(() => page.getByLabel('曝光', { exact: true }).inputValue()) === '0.75', 'native exposure commit reaches Web effect form')
  await press('环境雾'); await press('雾的范围 ▾'); await press('颜色与光照')
  await press('白天雾色 · 更换颜色')
  const red = (await state()).widgets.find((w: any) => w.text.startsWith('红色分量 ')); assert.ok(red)
  await dragWidget(red.text, -24, 0); await press('‹ 返回参数'); await press('应用属性')
  await until(async () => !await page.getByText('游戏内属性尚未应用。请先在游戏编辑器里应用或重载属性。', { exact: true }).count(), 'native RGB edit acknowledgement')
  await capture('native-effects-color-inspector')
  await press('▶ 预览区域环境'); await native('mct_state', { afterFrames: 20 }); await capture('native-effects-preview')
  await press('■ 停止预览并恢复')
  pass('native visual effect sliders and RGB palette commit through the same author draft and own reversible preview')
  await press('保存')
  const effectSaved = await until(async () => { const d = JSON.parse(await readFile(join(h.root, path), 'utf8')); return d.regions[0].environment?.effects.post.parameters.filters[0].params.exposure === .75 ? d : false }, 'native Save persists all effect sections via S')
  assert.equal(effectSaved.regions[0].music.priority, 12); assert.equal(effectSaved.regions[0].environment.effects.fog.scope, 'volume')
  assert.deepEqual(effectSaved.regions[0].custom_data, initial.regions[0].custom_data)
  await button('撤销地图编辑').click(); await button('重做地图编辑').click()
  await page.keyboard.press('Control+s')
  await until(async () => JSON.parse(await readFile(join(h.root, path), 'utf8')).regions[0].environment.effects.post.parameters.filters[0].params.exposure === .75, 'shared effect redo and save')
  pass('effect sections, decimal geometry and nested custom data survive native save and cross-end undo/redo')
  await page.getByRole('tab', { name: /环境雾/ }).click(); await page.getByLabel('雾的作用方式', { exact: true }).selectOption('player'); await button('应用效果').click()
  await page.getByRole('tab', { name: '范围与高度', exact: true }).click(); await press('范围与高度')
  // The earlier no-implicit-save assertion now uses the explicitly saved effect baseline.
  const effectBaselineText = await readFile(join(h.root, path), 'utf8')

  // Drive native GUI through observed projected widgets, then observe the actual WebUI draft.
  top = await widget('控制点 Y 上界'); const before = Number(await field('Y 最大').inputValue())
  const heightCommitIndex = report.authorCommits.length
  await dragWidget('控制点 Y 上界', 0, -26)
  let after = await until(async () => { const v = Number(await field('Y 最大').inputValue()); return v !== before ? v : false }, 'native Y drag reaches C sidebar')
  await confirmedNativeCommit(heightCommitIndex)
  assert.equal(await readFile(join(h.root, path), 'utf8'), effectBaselineText)
  pass('native height drag updates browser sidebar through same draft without implicit disk save')
  await press('撤销'); await until(async () => Number(await field('Y 最大').inputValue()) === before, 'native undo shared with C')
  await button('重做地图编辑').click(); await until(async () => Number(await field('Y 最大').inputValue()) === after, 'C redo shared with native')
  // Actual browser pointer events go through the production RPIN encoder, not direct native GUI calls.
  async function streamPoint(x: number, y: number, nativeWindow: { width: number; height: number }) {
    const box = await stream.boundingBox(); assert.ok(box)
    const k = Math.min(box.width / nativeWindow.width, box.height / nativeWindow.height)
    return { x: box.x + (box.width - nativeWindow.width * k) / 2 + x * k, y: box.y + (box.height - nativeWindow.height * k) / 2 + y * k }
  }
  async function streamHandles() {
    return stream.evaluate(e => ({ handles: JSON.parse((e as HTMLElement).dataset.editHandles || '[]'), window: JSON.parse((e as HTMLElement).dataset.editWindow || 'null') }))
  }
  async function centeredHandles() {
    return until(async () => { const m = await streamHandles(); const h = m.handles.find((h: any) => h.id === 'maxY'); return h && Math.abs(h.screenX - m.window.width / 2) < 3 ? m : false }, 'stream metadata reflects the newly focused camera')
  }
  async function confirmedNativeCommit(previousCount: number) {
    const commit = await until(async () => report.authorCommits[previousCount], 'native commit notification received')
    await until(async () => Number(await stream.getAttribute('data-edit-revision')) > commit.revision, 'C acknowledges the actual native commit rather than its preview')
    return commit
  }
  let projected = await until(async () => {
    const m = await streamHandles(), s = await state()
    const h = m.handles.find((h: any) => h.id === 'maxY'), w = s.widgets.find((w: any) => w.text === '控制点 Y 上界' && w.visible)
    const scale = s.window.scale
    return h && w && Math.abs(h.screenX - (w.x + w.width / 2) * scale) < 3 && Math.abs(h.screenY - (w.y + w.height / 2) * scale) < 3 ? m : false
  }, 'stream projection catches up after effect inspector resize and acknowledged height undo/redo')
  let upper = projected.handles.find((h: any) => h.id === 'maxY')
  let point = await streamPoint(upper.screenX, upper.screenY, projected.window)
  await stream.focus(); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x, point.y - 24, { steps: 12 }); await page.mouse.up()
  const browserY = await until(async () => { const v = Number(await field('Y 最大').inputValue()); return v !== after ? v : false }, 'real browser height drag')
  after = browserY
  await until(async () => (await state()).widgets.filter((w: any) => w.type === 'edit_box').some((w: any) => w.text === String(after)), 'browser gesture acknowledged natively')
  pass('actual browser pointer drags native height handle through production stream input')
  const bodyProbe = await streamHandles()
  const moveProbe = bodyProbe.handles.find((h: any) => h.id === 'move' || h.id === 'center')
  const cornerProbe = bodyProbe.handles.find((h: any) => h.id === 'minXminZ')
  assert.ok(moveProbe && cornerProbe)
  let bodyPoint = await streamPoint((moveProbe.screenX + cornerProbe.screenX) / 2, (moveProbe.screenY + cornerProbe.screenY) / 2, bodyProbe.window)
  async function browserTool(name: string) {
    await until(async () => (await state()).widgets.some((w: any) => w.type === 'button' && (w.text === name || w.text === '· '+name) && w.active), 'tool ready after prior draft acknowledgement')
    const observed = (await state()).widgets.find((w:any)=>w.type==='button'&&(w.text===name||w.text==='· '+name))
    const { s, w } = await widget(observed.text, 'button')
    const p = await streamPoint((w.x + w.width / 2) * s.window.scale, (w.y + w.height / 2) * s.window.scale, s.window)
    await page.mouse.click(p.x, p.y)
  }
  const createCanvas = await widget('世界视口')
  const startPoint = await streamPoint((createCanvas.w.x + createCanvas.w.width * .48) * createCanvas.s.window.scale, (createCanvas.w.y + createCanvas.w.height * .6) * createCanvas.s.window.scale, createCanvas.s.window)
  const endPoint = { x: startPoint.x + 48, y: startPoint.y + 28 }
  await browserTool('矩形 B')
  const clickCommits = report.authorCommits.length
  await page.mouse.click(startPoint.x, startPoint.y); await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 })
  await capture('two-point-rectangle-preview')
  assert.equal(report.authorCommits.length, clickCommits, 'first point and rubber-band preview do not commit history')
  await page.mouse.click(endPoint.x, endPoint.y)
  await confirmedNativeCommit(clickCommits)
  await until(async () => await page.locator('.level-tree-volume').count() === 2, 'browser two-click rectangle commits once')
  await button('撤销地图编辑').click(); await until(async () => await page.locator('.level-tree-volume').count() === 1, 'one undo removes the entire two-click creation')
  pass('actual browser tool click and two-point rectangle preview create one undoable volume')
  await browserTool('矩形 B'); const dragCommits = report.authorCommits.length
  await page.mouse.move(startPoint.x, startPoint.y); await page.mouse.down(); await page.mouse.move(endPoint.x, endPoint.y, { steps: 12 }); await page.mouse.up()
  await confirmedNativeCommit(dragCommits)
  await until(async () => await page.locator('.level-tree-volume').count() === 2, 'actual browser drag creation commits to the author tree')
  await button('撤销地图编辑').click(); await until(async () => await page.locator('.level-tree-volume').count() === 1, 'browser drag creation undo')
  pass('actual browser rectangle drag creates geometry through production mouse input')
  await browserTool('选择 V'); await press('对准 F')
  const freshBody = await centeredHandles()
  const cornerIds = ['minXminZ','maxXminZ','minXmaxZ','maxXmaxZ'], corners = cornerIds.map(id=>freshBody.handles.find((h:any)=>h.id===id))
  assert.ok(corners.every(Boolean))
  const candidates = []
  for (const u of [.2,.35,.5,.65,.8]) for (const v of [.2,.35,.5,.65,.8]) {
    const weights=[(1-u)*(1-v),u*(1-v),(1-u)*v,u*v]
    const x=corners.reduce((n:number,h:any,i:number)=>n+h.screenX*weights[i],0), y=corners.reduce((n:number,h:any,i:number)=>n+h.screenY*weights[i],0)
    const clearance=Math.min(...freshBody.handles.map((h:any)=>Math.hypot(x-h.screenX,y-h.screenY)))
    candidates.push({x,y,clearance})
  }
  const bodyTarget=candidates.sort((a,b)=>b.clearance-a.clearance)[0];assert.ok(bodyTarget.clearance>24,'body target avoids actual projected gizmos')
  bodyPoint=await streamPoint(bodyTarget.x,bodyTarget.y,freshBody.window)
  const bodyCommits = report.authorCommits.length
  await page.mouse.move(bodyPoint.x, bodyPoint.y); await page.mouse.down(); await page.mouse.move(bodyPoint.x + 48, bodyPoint.y + 24, { steps: 12 }); await page.mouse.up()
  await confirmedNativeCommit(bodyCommits)
  await until(async () => await field('X 最小').count() === 1 && Number(await field('X 最小').inputValue()) !== 82, 'first drag selects and commits movement of the rendered volume')
  await button('撤销地图编辑').click(); await page.locator('.level-tree-volume').first().click()
  await until(async () => Number(await field('X 最小').inputValue()) === 82, 'body drag undo restores original coordinates')
  pass('first browser drag selects and moves a volume by its visible body')
  await press('对准 F'); await native('mct_state', { afterFrames: 20 })
  const resizeMeta = await centeredHandles()
  const edge = resizeMeta.handles.find((h: any) => h.id === 'maxX')
  const edgePoint = await streamPoint(edge.screenX, edge.screenY, resizeMeta.window)
  const edgeCommits = report.authorCommits.length
  await page.mouse.move(edgePoint.x, edgePoint.y); await page.mouse.down(); await page.mouse.move(edgePoint.x + 38, edgePoint.y, { steps: 12 }); await page.mouse.up()
  await confirmedNativeCommit(edgeCommits)
  await until(async () => Number(await field('X 最大').inputValue()) !== 93, 'browser boundary drag commits the resized selection')
  await button('撤销地图编辑').click(); await until(async () => Number(await field('X 最大').inputValue()) === 93, 'boundary drag undo')
  pass('actual browser boundary control resizes the selection and uses shared undo')
  await browserTool('圆形 C')
  const circleCommits = report.authorCommits.length
  await page.mouse.click(startPoint.x, startPoint.y); await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 })
  await until(async () => await field('半径').count() === 1, 'native circle preview is displayed before cancelling')
  const circleRevision = report.lastNativePreview.revision
  await until(async () => Number(await stream.getAttribute('data-edit-revision')) === circleRevision, 'circle preview baseline is acknowledged')
  await button('撤销地图编辑').click()
  await until(async () => await page.locator('.level-tree-volume').count() === 1 && await field('Y 最大').count() === 1, 'browser undo cancels only the active preview')
  assert.equal(Number(await field('Y 最大').inputValue()), Number(after)); assert.equal(Number(await stream.getAttribute('data-edit-revision')), circleRevision)
  await page.mouse.click(startPoint.x, startPoint.y); await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 })
  await until(async () => await field('半径').count() === 1, 'second circle preview')
  await stream.focus(); await page.keyboard.press('Control+z')
  await until(async () => await page.locator('.level-tree-volume').count() === 1 && await field('Y 最大').count() === 1, 'native undo cancels only the active preview')
  assert.equal(Number(await field('Y 最大').inputValue()), Number(after)); assert.equal(Number(await stream.getAttribute('data-edit-revision')), circleRevision)
  pass('browser and native undo cancel an unfinished preview without undoing prior author changes')
  await page.mouse.click(startPoint.x, startPoint.y); await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 })
  await stream.focus(); await page.keyboard.press('Escape')
  await until(async () => await page.locator('.level-tree-volume').count() === 1, 'Escape cancels the two-point circle preview')
  await page.mouse.click(startPoint.x, startPoint.y); await page.mouse.move(endPoint.x, endPoint.y, { steps: 8 }); await page.mouse.click(endPoint.x, endPoint.y)
  await confirmedNativeCommit(circleCommits)
  await until(async () => await field('半径').count() === 1 && Number(await field('半径').inputValue()) >= 1, 'browser two-point circle commits actual geometry')
  await button('撤销地图编辑').click(); await page.locator('.level-tree-volume').first().click()
  await until(async () => await field('X 最大').count() === 1 && Number(await field('X 最大').inputValue()) === 93, 'circle creation undo restores the prior selection')
  pass('browser two-point circle supports preview cancellation and one shared undo')
  await press('对准 F'); await native('mct_state', { afterFrames: 20 })
  const freeBefore = (await centeredHandles()).handles.find((h: any) => h.id === 'maxY')
  const freePose = (await native('mct_server_state')).players
  await stream.focus(); await page.keyboard.down('d'); await native('mct_state', { afterFrames: 15 }); await page.keyboard.up('d')
  await until(async () => { const h = (await streamHandles()).handles.find((h: any) => h.id === 'maxY'); return h && h.screenX < freeBefore.screenX - 1 }, 'D moves the camera without a held mouse button')
  assert.deepEqual((await native('mct_server_state')).players, freePose)
  pass('browser WASD moves the world camera without holding a mouse button')
  const beforeRise = await until(async () => { const m = await streamHandles(); const h = m.handles.find((h: any) => h.id === 'maxY'); return h && h.screenX < freeBefore.screenX - 1 ? h : false }, 'movement metadata settled')
  await page.keyboard.down('e'); await native('mct_state', { afterFrames: 15 }); await page.keyboard.up('e')
  await until(async () => { const h = (await streamHandles()).handles.find((h: any) => h.id === 'maxY'); return h && h.screenY > beforeRise.screenY + 1 }, 'E raises only the detached camera')
  assert.deepEqual((await native('mct_server_state')).players, freePose)
  pass('browser E raises the editor camera without moving the player')
  await press('对准 F'); await native('mct_state', { afterFrames: 20 })
  // Observe real presentation, including browser decode and draw, while moving only the editor camera.
  const serverPose = (await native('mct_server_state')).players.map((p: any) => ({ uuid: p.uuid, x: p.x, y: p.y, z: p.z }))
  const canvas = await widget('世界视口'); const c = canvas.w
  point = await streamPoint((c.x + c.width / 2) * canvas.s.window.scale, (c.y + c.height / 2) * canvas.s.window.scale, canvas.s.window)
  projected = await centeredHandles(); const beforeX = projected.handles.find((h: any) => h.id === 'maxY').screenX
  await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'right' }); await page.keyboard.down('d')
  await native('mct_state', { afterFrames: 45 }); await page.keyboard.up('d'); await page.mouse.up({ button: 'right' })
  await until(async () => { const h = (await streamHandles()).handles.find((h: any) => h.id === 'maxY'); return h && h.screenX < beforeX - 1 }, 'D moves camera right, world handle moves left')
  assert.deepEqual((await native('mct_server_state')).players.map((p: any) => ({ uuid: p.uuid, x: p.x, y: p.y, z: p.z })), serverPose)
  pass('browser RMB and D move detached camera in expected direction without moving server player')
  // Reframe independently: after movement the following turn can legitimately move the handle outside the viewport.
  await press('对准 F'); await native('mct_state', { afterFrames: 20 })
  await until(async () => { const m = await streamHandles(); const h = m.handles.find((h: any) => h.id === 'maxY'); return h && h.screenX > m.window.width * .35 && h.screenX < m.window.width * .65 }, 'focus places the turn probe back inside the viewport')
  const turnBefore = (await streamHandles()).handles.find((h: any) => h.id === 'maxY').screenX
  await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'right' }); await page.mouse.move(point.x + 25, point.y + 8, { steps: 8 }); await page.mouse.up({ button: 'right' })
  await until(async () => { const h = (await streamHandles()).handles.find((h: any) => h.id === 'maxY'); return h && Math.abs(h.screenX - turnBefore) > 3 }, 'actual browser right drag turns native camera')
  assert.deepEqual((await native('mct_server_state')).players.map((p: any) => ({ uuid: p.uuid, x: p.x, y: p.y, z: p.z })), serverPose)
  pass('actual browser relative right-drag turns camera without edge lock or player motion')

  await press('对准 F'); await native('mct_state', { afterFrames: 30 })
  await page.evaluate(() => { (window as any).__nativeFrameTimes.length = 0 })
  await page.waitForTimeout(5000)
  const frameTimes = await page.evaluate(() => (window as any).__nativeFrameTimes as number[])
  const gaps = frameTimes.slice(1).map((v, i) => v - frameTimes[i]).sort((a, b) => a - b)
  report.presentation = { seconds: 5, frames: frameTimes.length, fps: (frameTimes.length - 1) * 1000 / (frameTimes.at(-1)! - frameTimes[0]), medianGapMs: gaps[Math.floor(gaps.length / 2)], p95GapMs: gaps[Math.floor(gaps.length * .95)], maxGapMs: gaps.at(-1) }
  assert.ok(frameTimes.length >= 50, `no presentation starvation: ${JSON.stringify(report.presentation)}`)
  assert.ok(report.presentation.maxGapMs < 1000, `no multi-second presentation stalls: ${JSON.stringify(report.presentation)}`)
  pass('real browser decode and presentation continue under live streaming with measured frame intervals')
  assert.equal(Number(await field('Y 最大').inputValue()), Number(after), 'intermediate create/move/resize/undo checks retain the original height change')
  await set(String(after), String(Number(after) + 2))
  await until(async () => await page.getByText('游戏内属性尚未应用。请先在游戏编辑器里应用或重载属性。', { exact: true }).count(), 'native dirty guard reaches C')
  await press('保存')
  const saved = await until(async () => { const d = JSON.parse(await readFile(join(h.root, path), 'utf8')); return d.regions[0].areas[0].y[1] === Number(after) + 2 ? d : false }, 'native Save applies form then saves through S')
  assert.deepEqual(saved.custom_data, initial.custom_data); assert.deepEqual(saved.regions[0].custom_data, initial.regions[0].custom_data)
  pass('native property edit, shared undo/redo, ACK-before-save and S persistence preserve unknown nested data')
  await set(String(Number(after) + 2), '-')
  await native('mct_act', { action: 'key', select: { text: '-', type: 'edit_box' }, key: 90, modifiers: 2, settleFrames: 4 })
  assert.ok((await state()).widgets.some((w: any) => w.type === 'edit_box' && w.text === String(Number(after) + 2)))
  await until(async () => await field('Y 最大').isEnabled(), 'native text undo clears only uncommitted input')
  await set(String(Number(after) + 2), '-')
  await press('保存'); await state()
  assert.equal(JSON.parse(await readFile(join(h.root, path), 'utf8')).regions[0].areas[0].y[1], Number(after) + 2)
  assert.ok((await state()).widgets.some((w: any) => w.type === 'edit_box' && w.text === '-'))
  await press('重载属性')
  await until(async () => await field('Y 最大').isEnabled(), 'native invalid form discard restores C')
  pass('invalid native height stays editable and cannot write or overwrite the saved document')
  await set(String(Number(after) + 2), String(Number(after) + 3))
  await stream.focus(); await page.keyboard.press('Control+s')
  await until(async () => JSON.parse(await readFile(join(h.root, path), 'utf8')).regions[0].areas[0].y[1] === Number(after) + 3, 'stream CtrlS applies native input and saves via S')
  pass('actual browser CtrlS flushes native properties and saves only after acknowledgement')


  await field('Y 最大').fill(String(Number(after) + 4)); await field('Y 最大').blur()
  await until(async () => (await state()).widgets.some((w: any) => w.type === 'edit_box' && w.text === String(Number(after) + 4)), 'C property reflected natively')
  await capture('bound-inspector-and-world')
  await field('Y 最大').fill('-')
  await until(async () => { const fields = (await state()).widgets.filter((w: any) => w.type === 'edit_box'); return fields.length > 0 && fields.every((w: any) => !w.active) }, 'unfinished C form makes native editor read-only')
  const savedBeforeReadonly = await readFile(join(h.root, path), 'utf8')
  await press('保存'); assert.equal(await readFile(join(h.root, path), 'utf8'), savedBeforeReadonly)
  await button('放弃未完成编辑').click()
  await until(async () => (await state()).widgets.some((w: any) => w.type === 'edit_box' && w.active), 'C discard releases native editing')
  pass('unfinished browser property disables native edits and prevents native save')
  // Create all supported shapes through the native world canvas, then inspect actual C properties.
  await press('圆形 C'); await dragWidget('世界视口', 45, 25)
  await until(async () => await field('半径').count() && Number(await field('半径').inputValue()) >= 1, 'native circle reaches C')
  assert.equal(Number(await field('Y 最小').inputValue()), 80)
  await press('对准 F'); await native('mct_state', { afterFrames: 30 })
  await press('多边形 P')
  for (const [fx, fy] of [[.38,.43],[.58,.43],[.50,.65]]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { s, w } = await widget('世界视口')
      try { await native('mct_drag', { screenToken: s.screenToken, x: Math.round(w.x + w.width * fx), y: Math.round(w.y + w.height * fy), dx: 0, dy: 0 }); break }
      catch (error) { if (!String(error).includes('stale_token') || attempt === 3) throw error }
    }
    await state()
  }
  await native('mct_act', { action: 'key', key: 257, settleFrames: 4 })
  await until(async () => await field('顶点 1 X').count() === 1, 'native polygon Enter reaches C')
  assert.equal(Number(await field('Y 最小').inputValue()), 80)
  assert.equal(Number(await field('Y 最大').inputValue()), 83)
  pass('native circle and polygon use the clicked ground plane and keep finite height')
  await press('地标 L'); await dragWidget('世界视口', 0, 0)
  await until(async () => await field('地标 Y').count() === 1, 'native landmark click reaches C')
  assert.equal(Number(await field('地标 Y').inputValue()), 81)
  await deleteNative()
  await until(async () => await field('地标 Y').count() === 0, 'native landmark deletion')
  await button('撤销地图编辑').click()
  await until(async () => await page.locator('.level-tree-landmark').count() === 1, 'shared undo restores deleted landmark in the author tree')
  await page.locator('.level-tree-landmark').first().click()
  await until(async () => await field('地标 Y').count() === 1, 'restored landmark property projection')
  assert.equal(Number(await field('地标 Y').inputValue()), 81)
  pass('landmark is placed on the actual block top and deletion uses shared undo')
  await capture('circle-polygon-landmark')

  await button('离线 3D').click(); await field('三维体积视图').waitFor()
  await page.keyboard.press('Control+s')
  await until(async () => JSON.parse(await readFile(join(h.root, path), 'utf8')).regions[0].areas[0].y[1] === Number(after) + 4, 'C save')
  const finalDoc = JSON.parse(await readFile(join(h.root, path), 'utf8')); assert.ok(finalDoc.regions[0].areas.some((a: any) => a.shape === 'circle')); assert.ok(finalDoc.regions[0].areas.some((a: any) => Array.isArray(a.points))); assert.equal(finalDoc.landmarks[0].param.y, 81); assert.deepEqual(finalDoc.custom_data, initial.custom_data)
  await page.screenshot({ path: join(artifacts, 'browser-offline-properties.png') })
  pass('browser properties and offline 3D remain available and save the shared result')
  await press('关闭'); assert.equal((await state()).screen, null)
  const gameplay = await state(); report.captures.push({ name: 'gameplay-hud-restored', ...(await native('mct_capture', { screenToken: gameplay.screenToken, crop: { x: Math.floor((gameplay.window.width - 680) / 2), y: gameplay.window.height - 160, width: 680, height: 160 }, waitFrames: 3 })) })
  pass('stopping the stream and closing the workbench return to normal gameplay')
  await until(async () => field('地标 Y').isEnabled(), 'S save receipt leaves the browser editable')
  const editorTab = page.getByRole('tab', { name: 'native_editor.level', exact: true })
  await editorTab.getByRole('button', { name: '关闭 native_editor.level', exact: true }).click()
  await editorTab.waitFor({ state: 'hidden' })
  await page.getByRole('treeitem', { name: 'native_editor.level', exact: true }).click()
  await field('三维体积视图').waitFor()
  await page.locator('.level-tree-row > button[title="院子"]').click()
  const reopenExpand = button('展开区域 院子'); if (await reopenExpand.count()) await reopenExpand.click()
  await page.locator('.level-tree-volume').first().click()
  assert.equal(Number(await field('Y 最大').inputValue()), Number(after) + 4)
  assert.equal(await page.locator('.level-tree-volume').count(), 3)
  await page.locator('.level-tree-landmark').first().click()
  assert.equal(Number(await field('地标 Y').inputValue()), 81)
  pass('closing and reopening the saved level retains native geometry and landmark properties')
  const offline = field('三维体积视图'); await offline.focus()
  const orbitBefore = await offline.getAttribute('data-orbit'), diskBeforeNavigation = await readFile(join(h.root, path), 'utf8')
  await page.keyboard.down('d'); await page.waitForTimeout(160); await page.keyboard.up('d')
  await until(async () => await offline.getAttribute('data-orbit') !== orbitBefore, 'offline WASD camera moves')
  const stoppedOrbit = await offline.getAttribute('data-orbit'); await page.waitForTimeout(120)
  assert.equal(await offline.getAttribute('data-orbit'), stoppedOrbit)
  assert.equal(await readFile(join(h.root, path), 'utf8'), diskBeforeNavigation)
  pass('offline WASD moves only the simulated camera and stops on key release')
  await button('矩形').click()
  const offBox = await offline.boundingBox(); assert.ok(offBox)
  await page.mouse.click(offBox.x + offBox.width * .35, offBox.y + offBox.height * .4)
  await page.mouse.move(offBox.x + offBox.width * .5, offBox.y + offBox.height * .55, { steps: 8 })
  await page.screenshot({ path: join(artifacts, 'browser-two-click-preview.png') })
  await page.mouse.click(offBox.x + offBox.width * .5, offBox.y + offBox.height * .55)
  await until(async () => await page.locator('.level-tree-volume').count() === 4 && await field('X 最小').count() === 1, 'offline two-click rectangle commits and selects its result')
  await button('撤销地图编辑').click(); await until(async () => await page.locator('.level-tree-volume').count() === 3, 'offline two-click creation is one undo')
  assert.equal(await readFile(join(h.root, path), 'utf8'), diskBeforeNavigation)
  pass('offline two-click rectangle shares the same preview and single-commit workflow')
  // Create a new engineering effect through the real resource editor and compile it on the real GPU.
  await button('游戏内').click()
  await until(async () => (await state()).screen?.class.endsWith('RegionEditScreen'), 'custom effect native session')
  await page.getByRole('tab', { name: '环境与音乐', exact: true }).click()
  await press('环境与音乐'); await press('制作效果 / 网页资源编辑')
  const author = page.getByRole('dialog', { name: '自定义着色器效果', exact: true }); await author.waitFor()
  await author.getByLabel('着色器资源ID', { exact: true }).fill('project:forest_tint')
  await author.getByLabel('着色器显示名称', { exact: true }).fill('森林染色')
  await author.getByRole('tab', { name: '参数与控件', exact: true }).click()
  await author.getByLabel('中文标签 amount', { exact: true }).fill('林地染色强度')
  await author.getByRole('button', { name: '编译并预览', exact: true }).click()
  await author.getByText('编译通过，正在游戏画面中预览；工程文件尚需显式保存。', { exact: true }).waitFor()
  await until(async () => report.effectsPreview?.active && report.effectsPreview.compiledSources === 1, 'custom source is compiled and used by game render channels')
  const goodPreview = { ...report.effectsPreview }; report.customShaderPreview = goodPreview
  await capture('custom-shader-native-preview')
  const sourceDiskBefore = await readFile(join(h.root, path), 'utf8')
  await author.getByRole('tab', { name: 'GLSL 源码', exact: true }).click()
  const code = author.getByRole('textbox', { name: 'GLSL源码', exact: true }); await code.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\ninvalid_glsl_token\n')
  await author.getByRole('button', { name: '编译并预览', exact: true }).click()
  await author.getByRole('alert').filter({ hasText: '编译／预览失败' }).waitFor()
  await until(async () => report.effectsPreview?.active && report.effectsPreview.compiledSources === 1, 'last successful preview survives bad GLSL')
  assert.equal(await readFile(join(h.root, path), 'utf8'), sourceDiskBefore)
  await author.getByRole('button', { name: '恢复上次成功版本', exact: true }).click()
  await author.getByRole('button', { name: '编译并预览', exact: true }).click(); await author.getByText('编译通过，正在游戏画面中预览；工程文件尚需显式保存。', { exact: true }).waitFor()
  await author.getByRole('button', { name: '保存资源', exact: true }).click()
  await author.getByText('效果定义与GLSL源码已通过工程事务保存。保存不代表着色器已通过游戏编译。', { exact: true }).waitFor()
  const shaderBase = join(h.root, 'assets/project/rpgtoolkit/effects/post/forest_tint')
  assert.equal(JSON.parse(await readFile(shaderBase+'.json','utf8')).params.amount.label, '林地染色强度')
  assert.ok(!(await readFile(shaderBase+'.glsl','utf8')).includes('invalid_glsl_token'))
  await author.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('tab', { name: /画面滤镜/ }).click(); await field('林地染色强度').fill('0.65'); await button('应用效果').click(); await page.keyboard.press('Control+s')
  const customDoc = await until(async () => { const d=JSON.parse(await readFile(join(h.root,path),'utf8'));return d.regions[0].environment.effects.post.parameters.filters.some((f:any)=>f.shader==='project:forest_tint'&&f.params.amount===.65)?d:false }, 'custom shader ID and parameter save through S')
  assert.ok(!JSON.stringify(customDoc).includes('rpgtoolkit_editor:'))
  pass('native resource action opens Web GLSL authoring; valid GPU preview, failed compile recovery and paired resource save work without author alias leakage')
  await readyPress('画面滤镜')
  const effectGroup = (await state()).widgets.find((w:any)=>w.type==='button'&&w.text.endsWith(' ▾')&&w.text.includes(' · '));assert.ok(effectGroup)
  await readyPress(effectGroup.text)
  const customGroup = (await state()).widgets.find((w:any)=>w.type==='button'&&w.text.endsWith(' · 森林染色'));assert.ok(customGroup)
  await readyPress(customGroup.text)
  if (!(await state()).widgets.some((w:any)=>w.type==='edit_box'&&w.text==='0.65')) { const s=await state(),buttons=s.widgets.filter((w:any)=>w.type==='button'&&w.text==='›'&&w.x>s.window.guiWidth/2);assert.equal(buttons.length,1);await native('mct_press',{screenToken:s.screenToken,widgetId:buttons[0].id}) }
  await set('0.65','0.7'); await readyPress('应用属性')
  await until(async () => await field('林地染色强度').inputValue()==='0.7', 'native Chinese custom shader parameter commits to Web')
  await readyPress('保存'); await until(async () => JSON.parse(await readFile(join(h.root,path),'utf8')).regions[0].environment.effects.post.parameters.filters.some((f:any)=>f.shader==='project:forest_tint'&&f.params.amount===.7), 'native custom parameter saved through S')
  await capture('native-custom-effect-workbench')
  await button('离线 3D').click(); await field('三维体积视图').waitFor(); await readyPress('关闭')
  pass('custom resources remain available to the same Web properties and native workbench; stop and close restore gameplay')
  assert.deepEqual(report.pageErrors, []); report.ok = true
} catch (error) {
  report.ok = false; report.error = error instanceof Error ? error.stack : String(error); console.error(report.error); process.exitCode = 1
  report.failureState = await state().catch(() => null); await capture('failure').catch(() => {})
  report.inputStatus = await fetch(`http://${prefs.host}:${prefs.port}/stream/input/status`, { headers }).then(r => r.json()).catch(() => null)
  const failurePage = browser?.contexts()[0]?.pages()[0]; if (failurePage) { report.browserStream = await failurePage.locator('.level-stream').evaluate(e => ({ phase: (e as HTMLElement).dataset.state, text: e.textContent, meta: (e as HTMLElement).dataset.editRevision })).catch(() => null); await failurePage.screenshot({ path: join(artifacts, 'browser-failure.png') }).catch(() => {}) }
} finally {
  if (input) await stopInput().catch(() => {})
  await browser?.close(); await h?.stop()
  await writeFile(join(artifacts, 'native-world-editor-result.json'), JSON.stringify(report, null, 2))
  bridge.stdin.end(); console.log(JSON.stringify({ ok: report.ok, passed: report.passed.length, report: join(artifacts, 'native-world-editor-result.json') }))
}
