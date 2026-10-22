import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'

// Real Rust S plus three isolated browser contexts. The proxy loses only a
// confirmed successful reply; assertions use visible controls and server state.
// This is a single-host test, not an assertion of two-physical-device acceptance.
const output = resolve('../output/unified-presence')
const indexPath = '.hanshu/skinmanager/library.json'
const scriptPath = 'src/hanshu/story.hs', flowPath = 'src/story/presence.hflow'
const progressPath = 'src/progress/example.progress'
const results = [], observed = [], pages = [], pageErrors = [], sockets = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let upstream, browser, dropNextPatch = false, dropNextCommand = null, ownerToken = ''
const proxy = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const commit = req.url === '/api/files/commit' ? JSON.parse(body.toString()) : null
  if (commit) observed.push(commit)
  const commandChange = commit?.changes.find(change => change.op === 'skin-library-command')
  const command = commandChange?.content ? JSON.parse(Buffer.from(commandChange.content, 'base64').toString()).command : null
  const drop = dropNextPatch && commit?.changes.some(change => change.op === 'skin-entry-patch') || dropNextCommand !== null && command === dropNextCommand
  if (drop) { dropNextPatch = false; dropNextCommand = null }
  const target = new URL(req.url, upstream)
  const outgoing = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, async response => {
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const content = Buffer.concat(chunks)
    if (drop) {
      assert.equal(JSON.parse(content).status, 'committed', 'Drop only a committed response')
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': content.length })
      res.write(content.subarray(0, Math.max(1, Math.floor(content.length / 2))))
      setTimeout(() => res.destroy(), 20)
    } else { res.writeHead(response.statusCode, response.headers); res.end(content) }
  })
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('{"code":"unavailable","message":"Proxy failure"}') })
  outgoing.end(body)
})
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
proxy.on('upgrade', (req, socket, head) => {
  const target = new URL(upstream)
  const remote = connect(Number(target.port), target.hostname, () => {
    remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
    for (const [key, value] of Object.entries(req.headers)) remote.write(`${key}: ${key === 'host' ? target.host : value}\r\n`)
    remote.write('\r\n'); if (head.length) remote.write(head)
    socket.pipe(remote); remote.pipe(socket)
  })
  remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
})
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
const base = `http://127.0.0.1:${proxy.address().port}`
const h = await harness({ web: true, origins: [base] }); upstream = h.base
const heartbeat = setInterval(() => { if (ownerToken) void h.api(ownerToken, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined) }, 8000)
function passed(name) { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < deadline, label); await sleep(100) }
}
const active = page => page.locator('.app-workspace-pane.active')
const bar = page => active(page).getByRole('region', { name: '当前文件协作者', exact: true })
const resourceState = page => bar(page).getByRole('region', { name: '当前资源保存状态', exact: true })
const details = page => active(page).locator('aside.skinWorkspaceRight')
const title = page => active(page).getByLabel('进度标题', { exact: true })
const state = () => h.api(ownerToken, '/api/project')
const diskIndex = async () => JSON.parse(await readFile(join(h.root, indexPath), 'utf8'))
const diskEntry = async id => (await diskIndex()).entries.find(entry => entry.entryId === id)
async function presence(session, path, activity, entryId = null) {
  await until(async () => {
    const value = (await state()).sessions.find(candidate => candidate.id === session.id)?.filePresence
    return path === null ? value === null : value?.path === path && (value.entryId ?? null) === entryId && (!activity || value.activity === activity)
  }, `Wrong presence for ${session.name}: ${path}/${entryId} ${activity ?? ''}`)
}
async function capsule(page, clientName, activity) {
  await until(async () => await bar(page).locator(`[aria-label*="${clientName}"][aria-label*="${activity}"]`).count() > 0, `Missing ${activity} capsule for ${clientName}`)
}
async function absentCapsule(page, clientName) {
  await until(async () => await bar(page).locator(`[aria-label*="${clientName}"]`).count() === 0, `Unrelated ${clientName} is shown for this resource`)
}
async function noLease(session) { assert.equal((await state()).leases.filter(lease => lease.sessionId === session.id).length, 0, 'Editing intent acquired a persistent write lease') }
async function assertFree(page) {
  assert.equal(await bar(page).getByRole('button', { name: /^(开始编辑|重新申请写权|结束编辑)$/ }).count(), 0, 'Optimistic editor exposes manual write ownership')
}
async function login(page, credential, name) {
  await page.goto(base)
  await page.getByRole('button', { name: '打开工程…', exact: true }).click()
  const form = page.getByRole('form', { name: '打开工程', exact: true })
  await form.getByLabel('服务地址', { exact: true }).fill(base)
  await form.getByLabel('主体凭证', { exact: true }).fill(credential)
  await form.getByLabel('本端名称', { exact: true }).fill(name)
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST')
  await form.getByRole('button', { name: '连接并打开工程', exact: true }).click()
  const { token } = await (await reply).json()
  await page.locator('.project-service-bar').getByText('统一工程验收', { exact: true }).waitFor()
  return { token, id: (await h.api(token, '/api/project')).session.id, name }
}
async function openProgressFile(page, name) {
  await page.getByRole('tab', { name: '进度流程', exact: true }).click()
  await active(page).getByLabel('筛选资源', { exact: true }).fill(name)
  await active(page).locator(`[role=treeitem][title="${name}"]`).click()
  await bar(page).waitFor(); await resourceState(page).waitFor()
}
async function openSkin(page, name) {
  await page.getByRole('tab', { name: '皮肤管理器', exact: true }).click()
  await active(page).locator('.skinWorkspaceCenter').getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).first().click()
  await details(page).getByTitle('点击编辑名称', { exact: true }).waitFor()
  await bar(page).waitFor(); await resourceState(page).waitFor()
}
async function editSkinName(page, value) {
  const input = details(page).getByLabel('名称', { exact: true })
  if (!await input.count()) await details(page).getByTitle('点击编辑名称', { exact: true }).click()
  await input.fill(value)
  return input
}
async function saved(page) { await until(async () => /^(已同步|修改已保存|已保存)$/.test(await resourceState(page).getByRole('status').innerText()), 'Current resource did not settle') }
function skinFixture() {
  const rgba = Buffer.alloc(64 * 64 * 4, 255), canonical = Buffer.alloc(15 + rgba.length)
  canonical.write('HSKN'); canonical[4] = 1; canonical.writeUInt16BE(64, 7); canonical.writeUInt16BE(64, 9); canonical.writeUInt32BE(rgba.length, 11); rgba.copy(canonical, 15)
  const skinId = createHash('sha256').update(canonical).digest('hex'), payload = deflateSync(rgba), object = Buffer.alloc(16 + payload.length)
  canonical.copy(object, 0, 0, 11); object[11] = 1; object.writeUInt32BE(payload.length, 12); payload.copy(object, 16)
  const now = '2026-10-22T00:00:00.000Z'
  const entry = (entryId, name) => ({ entryId, skinId, name, active: true, tags: [], folderId: null, favorite: false, model: 'classic', textureWidth: 64, textureHeight: 64, source: { kind: 'skin-code' }, provenance: { author: null, sourceName: null, sourceUrl: null, sourceNote: null, originalCreatedAt: null }, license: { status: 'unspecified', name: null, url: null, note: null }, note: '', customId: null, createdAt: now, updatedAt: now, revision: 1 })
  return { objectPath: `.hanshu/skinmanager/objects/${skinId.slice(0, 2)}/${skinId}.skin`, object, index: { schemaVersion: 5, revision: 1, folders: [], entries: [entry('presence-skin-a', '协作皮肤 A'), entry('presence-skin-b', '协作皮肤 B')] } }
}

try {
  await mkdir(output, { recursive: true })
  assert.equal((await h.api('', '/health')).protocol, 9)
  const owner = await h.login(h.credential, '验收 API'); ownerToken = owner.token
  const editor = await h.api(ownerToken, '/api/subjects', 'POST', { name: '创作者', kind: 'account', role: 'editor' })
  const viewer = await h.api(ownerToken, '/api/subjects', 'POST', { name: '审阅主体', kind: 'agent', role: 'viewer' })
  const skin = skinFixture()
  const flow = { format: 'hanshu.progress-tree', version: 1, id: 'presence-flow', entry: { id: 'entry', target: null, title: { text: 'entry.title' }, description: { text: 'entry.description' } }, nodes: {}, layout: { positions: { entry: { x: 80, y: 80 } } } }
  await h.commit(ownerToken, [{ path: skin.objectPath, content: skin.object }, { path: indexPath, content: JSON.stringify(skin.index) }, { path: flowPath, content: JSON.stringify(flow) }]); await h.release(ownerToken)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1060 } })
    const page = await context.newPage(); pages.push(page)
    page.on('pageerror', error => { pageErrors.push(error.message); console.error(error.stack) }); page.on('dialog', dialog => dialog.dismiss())
  }
  const [a, b, v] = pages
  const [sa, sb, sv] = await Promise.all([login(a, editor.credential, '窗口 A'), login(b, editor.credential, '窗口 B'), login(v, viewer.credential, '审阅窗口')])
  await Promise.all(pages.map(async page => { await page.getByRole('tab', { name: '剧本', exact: true }).click(); await bar(page).waitFor(); await resourceState(page).waitFor() }))
  await Promise.all([presence(sa, scriptPath, 'viewing'), presence(sb, scriptPath, 'viewing'), presence(sv, scriptPath, 'viewing')])
  for (const page of pages) { await capsule(page, '窗口 A', '查看中'); await capsule(page, '窗口 B', '查看中'); await capsule(page, '审阅窗口', '查看中'); await assertFree(page) }
  await noLease(sa); await noLease(sb); await noLease(sv)
  assert.match(await bar(v).innerText(), /只读/)
  passed('剧本使用统一头像和保存状态；两个编辑窗口与只读主体可见，查看不获取写权')

  await active(a).locator('.monaco-editor .view-lines').first().click()
  await a.keyboard.press('Control+a'); await a.keyboard.type('shared script presence draft\n')
  await presence(sa, scriptPath, 'editing'); await capsule(b, '窗口 A', '编辑中'); await noLease(sa)
  assert.match(await resourceState(a).innerText(), /未保存/)
  assert.equal(await readFile(join(h.root, scriptPath), 'utf8'), h.fixtures[scriptPath])
  await a.keyboard.press('Control+s')
  await until(async () => (await readFile(join(h.root, scriptPath), 'utf8')).includes('shared script presence draft'), 'Script did not save')
  await saved(a); await presence(sa, scriptPath, 'viewing')
  await until(async () => (await active(b).locator('.monaco-editor .view-lines').allTextContents()).join('').replace(/\u00a0/g, ' ').includes('shared script presence draft'), 'Peer script did not update')
  await until(async () => (await state()).leases.every(lease => lease.sessionId !== sa.id), 'Short save lease was not released')
  passed('剧本本地输入显示编辑中和未保存，不持有长期写权；提交成功同步内容并清除草稿状态')

  await Promise.all([openProgressFile(a, 'presence.hflow'), openProgressFile(b, 'presence.hflow')])
  await presence(sa, flowPath, 'viewing'); await presence(sb, flowPath, 'viewing'); await absentCapsule(a, '审阅窗口'); await assertFree(a)
  const startNode = active(a).getByRole('button', { name: '开始节点（信号源），不可删除；Ctrl+点击发出 S(未激活 → 已激活)', exact: true })
  const rect = await startNode.boundingBox(); assert.ok(rect)
  await a.mouse.move(rect.x + 45, rect.y + 15); await a.mouse.down(); await a.mouse.move(rect.x + 130, rect.y + 60, { steps: 10 }); await a.mouse.up()
  await presence(sa, flowPath, 'editing'); await capsule(b, '窗口 A', '编辑中'); await noLease(sa)
  assert.match(await resourceState(a).innerText(), /未保存/)
  await a.keyboard.press('Control+s')
  await until(async () => JSON.parse(await readFile(join(h.root, flowPath), 'utf8')).layout.positions.entry.x !== 80, 'Flow movement did not save')
  await saved(a); await presence(sa, flowPath, 'viewing')
  passed('流程节点移动采用相同的编辑意图、未保存和已保存状态，仍由保存时短租约保护')

  await Promise.all([openProgressFile(a, 'example.progress'), openProgressFile(b, 'example.progress'), openProgressFile(v, 'example.progress')])
  await presence(sa, progressPath, 'viewing'); assert.ok(await title(a).isDisabled()); assert.ok(await title(v).isDisabled())
  await bar(a).getByRole('button', { name: '开始编辑', exact: true }).click()
  await until(() => title(a).isEnabled(), 'Progress did not obtain editing authority')
  await presence(sa, progressPath, 'editing'); await capsule(b, '窗口 A', '编辑中')
  assert.ok((await state()).leases.some(lease => lease.sessionId === sa.id && lease.resourceId === `file:${progressPath}`))
  assert.ok(await title(b).isDisabled()); assert.ok(await title(v).isDisabled())
  await bar(a).getByRole('button', { name: '结束编辑', exact: true }).click()
  await until(() => title(a).isDisabled(), 'Progress ending editing did not disable form'); await noLease(sa)
  passed('进度仍显式申请和释放写权；统一状态栏没有改变互斥编辑和只读权限')

  await Promise.all([openSkin(a, '协作皮肤 A'), openSkin(b, '协作皮肤 A'), openSkin(v, '协作皮肤 B')])
  await Promise.all([presence(sa, indexPath, 'viewing', 'presence-skin-a'), presence(sb, indexPath, 'viewing', 'presence-skin-a'), presence(sv, indexPath, 'viewing', 'presence-skin-b')])
  await capsule(a, '窗口 B', '查看中'); await absentCapsule(a, '审阅窗口'); await absentCapsule(v, '窗口 A'); await assertFree(a)
  assert.ok(await details(v).getByTitle('点击编辑名称', { exact: true }).isDisabled(), 'A read-only skin visitor can edit metadata')
  const draftName = await editSkinName(a, '皮肤 A 的本地草稿')
  await presence(sa, indexPath, 'editing', 'presence-skin-a'); await capsule(b, '窗口 A', '编辑中'); await noLease(sa)
  assert.match(await resourceState(a).innerText(), /未保存/)
  assert.equal((await diskEntry('presence-skin-a')).name, '协作皮肤 A')
  await openSkin(b, '协作皮肤 B'); await presence(sb, indexPath, 'viewing', 'presence-skin-b')
  await absentCapsule(a, '窗口 B'); await capsule(b, '审阅窗口', '查看中')
  await draftName.press('Enter'); await until(async () => (await diskEntry('presence-skin-a')).name === '皮肤 A 的本地草稿', 'Skin draft did not save')
  await saved(a); await presence(sa, indexPath, 'viewing', 'presence-skin-a')
  passed('皮肤以选中条目区分协作者；同条目编辑意图可见，不同条目互不混淆且不因在线状态加锁')

  await h.api(ownerToken, '/api/files/leases', 'POST', { paths: [indexPath] })
  await (await editSkinName(a, '写权冲突后保留的名称')).press('Enter')
  await until(async () => /冲突|写权|锁定/.test(await resourceState(a).innerText()), 'Skin failure did not appear at current resource')
  assert.equal((await diskEntry('presence-skin-a')).name, '皮肤 A 的本地草稿')
  await a.screenshot({ path: join(output, 'skin-inline-conflict.png') })
  await openSkin(a, '协作皮肤 B'); await presence(sa, indexPath, 'viewing', 'presence-skin-b')
  assert.ok(!/提交冲突|提交失败|结果待确认|重试原提交/.test(await resourceState(a).innerText()), 'Another skin inherited the first skin failure')
  await openSkin(a, '皮肤 A 的本地草稿')
  await resourceState(a).getByRole('button', { name: '重试原提交', exact: true }).waitFor()
  assert.ok((await details(a).innerText()).includes('写权冲突后保留的名称') || await details(a).getByLabel('名称', { exact: true }).inputValue().catch(() => '') === '写权冲突后保留的名称', 'Skin input was lost during resource switch')
  await h.release(ownerToken)
  await resourceState(a).getByRole('button', { name: '重试原提交', exact: true }).click()
  await until(async () => (await diskEntry('presence-skin-a')).name === '写权冲突后保留的名称', 'Inline retry did not save original input')
  await saved(a)
  passed('失败状态留在对应皮肤现场，切换条目不误报；返回后输入仍在并可原地重试')

  dropNextPatch = true
  await (await editSkinName(a, '成功回复丢失的名称')).press('Enter')
  await until(async () => /待确认|结果未知|尚未确认/.test(await resourceState(a).innerText()), 'Lost reply did not become uncertain inline')
  assert.equal((await diskEntry('presence-skin-a')).name, '成功回复丢失的名称')
  assert.equal(await resourceState(a).getByRole('button', { name: /放弃|丢弃/ }).count(), 0, 'Unknown outcome can be discarded from inline status')
  const beforeConfirm = observed.length
  await a.screenshot({ path: join(output, 'skin-inline-uncertain.png') })
  await resourceState(a).getByRole('button', { name: /查询.*结果|确认.*结果/ }).click()
  await saved(a)
  assert.equal(observed.length, beforeConfirm, 'Querying an unknown result resubmitted a new mutation')
  passed('成功回复丢失在当前条目标记待确认，可原地查询原回执且不会重复提交或丢弃未知结果')

  await active(a).locator('.skinWorkspaceLeft').getByText('文件夹', { exact: true }).click({ button: 'right' })
  await a.getByRole('menuitem', { name: '新建文件夹', exact: true }).click()
  const newFolder = a.getByRole('dialog', { name: '在根目录新建文件夹', exact: true })
  await newFolder.getByPlaceholder('文件夹名称', { exact: true }).fill('弹窗确认原提交')
  dropNextCommand = 'create-folder'
  await newFolder.getByRole('button', { name: '创建', exact: true }).click()
  const folderState = newFolder.getByRole('region', { name: '当前资源保存状态', exact: true })
  await until(async () => /结果待确认/.test(await folderState.innerText()), 'Folder unknown result did not stay in its dialog')
  assert.equal(await newFolder.getByPlaceholder('文件夹名称', { exact: true }).inputValue(), '弹窗确认原提交')
  assert.ok(await newFolder.getByPlaceholder('文件夹名称', { exact: true }).isDisabled(), 'Unknown folder operation allowed a second creation')
  const beforeFolderQuery = observed.length
  await folderState.getByRole('button', { name: '查询提交结果', exact: true }).click()
  await newFolder.waitFor({ state: 'hidden' })
  assert.equal(observed.length, beforeFolderQuery)
  assert.equal((await diskIndex()).folders.filter(folder => folder.name === '弹窗确认原提交').length, 1)
  passed('文件夹弹窗保留未知结果的原始输入，阻止第二次创建；原地确认成功后关闭且只创建一次')

  const offlineDraft = await editSkinName(a, '断线保留的皮肤输入')
  await a.context().setOffline(true)
  await until(async () => /断开|离线/.test(await bar(a).innerText()), 'Offline state not shown at resource', 30000)
  assert.equal(await offlineDraft.inputValue(), '断线保留的皮肤输入')
  await a.context().setOffline(false)
  await until(async () => !/断开|离线/.test(await bar(a).innerText()), 'Connection did not recover', 30000)
  await presence(sa, indexPath, 'editing', 'presence-skin-a'); await noLease(sa)
  assert.equal(await offlineDraft.inputValue(), '断线保留的皮肤输入')
  await offlineDraft.press('Enter'); await until(async () => (await diskEntry('presence-skin-a')).name === '断线保留的皮肤输入', 'Reconnected skin draft did not save')
  await saved(a)
  await until(async () => !/Failed to fetch/.test(await a.locator('.project-service-bar').innerText()), 'A recovered connection still displays its previous network failure')
  passed('断线保留皮肤输入；重连恢复当前条目编辑意图，不凭在线状态恢复或持有写锁')

  await a.getByRole('tab', { name: '剧本', exact: true }).click(); await presence(sa, scriptPath, 'viewing')
  await absentCapsule(b, '窗口 A')
  await openProgressFile(a, 'presence.hflow'); await presence(sa, flowPath, 'viewing')
  await (await editSkinName(b, '另一窗口更新的皮肤 B')).press('Enter'); await saved(b)
  await sleep(1200); await presence(sa, flowPath, 'viewing')
  await openSkin(a, '另一窗口更新的皮肤 B'); await presence(sa, indexPath, 'viewing', 'presence-skin-b'); await capsule(b, '窗口 A', '查看中')
  await sleep(1200); await presence(sa, indexPath, 'viewing', 'presence-skin-b')
  assert.equal((await state()).sessions.filter(session => session.subjectId === editor.subject.id).length, 2, 'Changing workspaces created new sessions')
  await a.screenshot({ path: join(output, 'unified-skin-wide.png') })
  await a.setViewportSize({ width: 900, height: 950 })
  await a.screenshot({ path: join(output, 'unified-skin-narrow.png') })
  const bounds = await bar(a).boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 901, 'Collaborator bar overflows narrow viewport')
  await a.setViewportSize({ width: 1500, height: 1060 })
  passed('跨工作区切换准确转移当前资源，隐藏编辑器不清除新焦点；窄窗口头像状态栏不溢出')

  assert.deepEqual(pageErrors, [])
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ date: new Date().toISOString(), protocol: 9, transport: 'real HTTP/WebSocket through loopback fault proxy', physicalDevices: 1, secondPhysicalDeviceTested: false, browserContexts: 3, browserPages: 3, results, observedCommitRequests: observed.length }, null, 2))
  console.log(`统一协作体验验收通过：${results.length} 组；同机三个隔离浏览器环境。`)
} catch (error) {
  for (const [index, page] of pages.entries()) { console.error(`CLIENT ${index}:`, (await page.locator('body').innerText().catch(() => '')).slice(0, 6500)); await page.screenshot({ path: join(output, `failed-client-${index}.png`) }).catch(() => undefined) }
  throw error
} finally {
  clearInterval(heartbeat)
  if (browser) await browser.close()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => proxy.close(resolve)); await h.stop()
}
