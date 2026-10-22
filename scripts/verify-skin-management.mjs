import {projectMenu,waitProject,submission,closeCollaboration,loginProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'

// Exercise the public v9 protocol and actual browser controls against one real
// Rust S. Assertions inspect S's files and receipts, never React implementation.
const indexPath = '.hanshu/skinmanager/library.json'
const output = resolve('../output/skin-management')
const results = [], observed = [], pages = [], pageErrors = [], tokens = []
const sockets = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let upstream, dropCommand = null, browser
const commandOf = request => {
  const change = request?.changes.find(change => change.op === 'skin-library-command')
  return change?.content ? JSON.parse(Buffer.from(change.content, 'base64').toString()) : null
}
const proxy = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const commit = req.url === '/api/files/commit' ? JSON.parse(body.toString()) : null
  if (commit) observed.push(commit)
  const drop = dropCommand !== null && commandOf(commit)?.command === dropCommand
  if (drop) dropCommand = null
  const target = new URL(req.url, upstream)
  const outgoing = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, async response => {
    const responseChunks = []
    for await (const chunk of response) responseChunks.push(chunk)
    const responseBody = Buffer.concat(responseChunks)
    if (drop) {
      assert.equal(JSON.parse(responseBody).status, 'committed', 'Lose only an already committed response')
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': responseBody.length })
      res.write(responseBody.subarray(0, Math.max(1, Math.floor(responseBody.length / 2))))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(response.statusCode, response.headers); res.end(responseBody)
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
const heartbeat = setInterval(() => {
  for (const token of tokens) void h.api(token, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined)
}, 8000)
function passed(name) { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < deadline, label); await sleep(100) }
}
async function diskIndex() { return JSON.parse(await readFile(join(h.root, indexPath), 'utf8')) }
async function diskEntry(entryId) { return (await diskIndex()).entries.find(entry => entry.entryId === entryId) }
const refs = entries => entries.map(({ entryId, revision }) => ({ entryId, revision }))
async function request(token, command, extra = [], version = 'old-index-version-is-not-entry-precondition') {
  return h.prepare(token, [{ op: 'skin-library-command', path: indexPath, content: JSON.stringify(command), version }, ...extra])
}
async function run(token, command, extra = []) {
  try { return await h.api(token, '/api/files/commit', 'POST', await request(token, command, extra)) }
  finally { await h.release(token) }
}
function committed(receipt) { assert.equal(receipt.status, 'committed', JSON.stringify(receipt.error)); return receipt.skinCommandResult?.result }
function rejected(receipt, codes = ['invalid', 'conflict', 'not_found']) {
  assert.equal(receipt.status, 'rejected'); assert.ok(codes.includes(receipt.error.code), JSON.stringify(receipt.error))
}
function fixture(color = 255) {
  const rgba = Buffer.alloc(64 * 64 * 4, 255)
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = color; rgba[i + 1] = 150; rgba[i + 2] = 200 }
  const canonical = Buffer.alloc(15 + rgba.length)
  canonical.write('HSKN'); canonical[4] = 1
  canonical.writeUInt16BE(64, 7); canonical.writeUInt16BE(64, 9); canonical.writeUInt32BE(rgba.length, 11); rgba.copy(canonical, 15)
  const skinId = createHash('sha256').update(canonical).digest('hex')
  const payload = deflateSync(rgba), object = Buffer.alloc(16 + payload.length)
  canonical.copy(object, 0, 0, 11); object[11] = 1; object.writeUInt32BE(payload.length, 12); payload.copy(object, 16)
  const now = '2026-10-22T00:00:00.000Z'
  const entry = (entryId, name, extra = {}) => ({ entryId, skinId, name, active: true, tags: [], folderId: null, favorite: false, model: 'classic', textureWidth: 64, textureHeight: 64, source: { kind: 'skin-file' }, provenance: { author: null, sourceName: null, sourceUrl: null, sourceNote: null, originalCreatedAt: null }, license: { status: 'unspecified', name: null, url: null, note: null }, note: '', customId: null, createdAt: now, updatedAt: now, revision: 1, ...extra })
  return { skinId, objectPath: `.hanshu/skinmanager/objects/${skinId.slice(0, 2)}/${skinId}.skin`, object, entry }
}
async function importEntry(token, skin, id, name, extra = {}, includeObject = false) {
  return run(token, { command: 'import-entry', entry: skin.entry(id, name, extra) }, includeObject ? [{ path: skin.objectPath, content: skin.object }] : [])
}
async function createFolder(token, folderId, name, parentId = null) {
  return committed(await run(token, { command: 'create-folder', folderId, name, parentId })).folder
}
async function patch(token, entryId, changes) {
  const entry = await diskEntry(entryId)
  const request = await h.prepare(token, [{ op: 'skin-entry-patch', path: indexPath, content: JSON.stringify({ entryId, expectedRevision: entry.revision, changes }) }])
  try { const receipt = await h.api(token, '/api/files/commit', 'POST', request); assert.equal(receipt.status, 'committed', JSON.stringify(receipt)); return receipt }
  finally { await h.release(token) }
}
async function browserLogin(page, credential, name, navigate = true) {
  await loginProject(page,base,credential,name,navigate)
  await page.getByRole('tab',{name:'皮肤管理器',exact:true}).click()
}
const card = (page, name) => page.locator('.skinWorkspaceCenter').getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).first()
async function selectCard(page, name) { await closeCollaboration(page);
  await card(page, name).hover()
  await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).check()
}
async function saved(page) { await until(async () => await (await submission(page)).getByRole('status').innerText() === '修改已保存', 'Client did not settle'); await closeCollaboration(page) }
async function skinRoot(page) { await closeCollaboration(page); await page.getByRole('navigation', { name: '快速访问' }).getByRole('button', { name: '皮肤库', exact: true }).click() }
async function openNewFolder(page) { await closeCollaboration(page);
  await page.locator('.skinWorkspaceLeft').getByText('文件夹', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click()
  return page.getByRole('dialog', { name: '在根目录新建文件夹', exact: true })
}
async function openImport(page, skin, name) { await closeCollaboration(page);
  await skinRoot(page)
  await page.locator('.skinWorkspaceCenter [class*="browsePane"]').dispatchEvent('contextmenu', { clientX: 500, clientY: 400 })
  await page.getByRole('menuitem', { name: '导入到这里', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入皮肤', exact: true })
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: '添加文件…', exact: true }).click()
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: skin.object })
  await dialog.getByRole('button', { name: '导入选中的 1 项', exact: true }).waitFor()
  return dialog
}

try {
  assert.equal((await h.api('', '/health')).protocol, 11)
  const owner = await h.login(h.credential, 'skin management owner')
  const author = await h.api(owner.token, '/api/subjects', 'POST', { name: '皮肤管理协作者', kind: 'account', role: 'editor' })
  const a = await h.login(author.credential, 'skin management A'), b = await h.login(author.credential, 'skin management B')
  tokens.push(owner.token, a.token, b.token)
  const skin = fixture()
  committed(await run(a.token, { command: 'ensure-library' }))
  for (const [i, name] of ['HTTP A', 'HTTP B', 'HTTP C'].entries()) committed(await importEntry(a.token, skin, `http-${i}`, name, {}, i === 0))
  assert.ok((await h.files(a.token)).entries.some(entry => entry.path === skin.objectPath))
  assert.deepEqual((await diskIndex()).entries.map(entry => entry.revision), [1, 1, 1])
  passed('通过 S 导入命令创建条目，对象与索引同事务落盘，条目初始版本由 S 分配')

  const beforeIndependent = await diskEntry('http-1')
  await patch(b.token, 'http-0', { name: 'HTTP A 远端更新' })
  committed(await run(a.token, { command: 'batch-patch', expectedEntries: refs([beforeIndependent]), changes: { active: false } }))
  committed(await importEntry(a.token, skin, 'http-3', 'HTTP D'))
  assert.equal((await diskEntry('http-0')).name, 'HTTP A 远端更新'); assert.equal((await diskEntry('http-1')).active, false)
  passed('过期整库版本不阻塞独立条目批量修改和新导入，双方结果保留')

  const staleBatch = refs([await diskEntry('http-1'), await diskEntry('http-2')])
  await patch(b.token, 'http-1', { note: '远端资料' })
  rejected(await run(a.token, { command: 'batch-patch', expectedEntries: staleBatch, changes: { active: false, addTags: ['不得部分成功'] } }), ['conflict'])
  assert.equal((await diskEntry('http-2')).active, true); assert.deepEqual((await diskEntry('http-2')).tags, [])
  passed('批量中任一条目版本过期时整批拒绝，不部分修改其他条目')

  const parent = await createFolder(a.token, 'parent', 'HTTP 父目录')
  const child = await createFolder(a.token, 'child', 'HTTP 子目录', parent.folderId)
  rejected(await run(a.token, { command: 'create-folder', folderId: 'duplicate-name', name: parent.name, parentId: null }))
  rejected(await run(a.token, { command: 'patch-folder', expectedFolder: parent, changes: { parentId: child.folderId } }))
  rejected(await run(a.token, { command: 'delete-folder', expectedFolder: parent }))
  committed(await importEntry(a.token, skin, 'custom-first', '唯一标识条目', { customId: 'unique-one' }))
  rejected(await importEntry(a.token, skin, 'custom-second', '重复标识条目', { customId: 'unique-one' }))
  assert.ok(!(await diskIndex()).entries.some(entry => entry.entryId === 'custom-second'))
  passed('S 校验文件夹同级重名、移动成环、非空删除与 customId 唯一性')

  committed(await importEntry(a.token, skin, 'scoped-old', '清空范围原条目', { folderId: child.folderId }))
  const oldScope = { command: 'delete-folder-entries', folderId: parent.folderId, expectedFolders: [parent, child], expectedEntries: refs([await diskEntry('scoped-old')]) }
  committed(await importEntry(b.token, skin, 'scoped-new', '清空前新增条目', { folderId: parent.folderId }))
  rejected(await run(a.token, oldScope), ['conflict'])
  assert.ok(await diskEntry('scoped-old')); assert.ok(await diskEntry('scoped-new'))
  const scopeEntries = refs([await diskEntry('scoped-old'), await diskEntry('scoped-new')])
  const newChild = await createFolder(b.token, 'new-child', '清空前新增目录', parent.folderId)
  rejected(await run(a.token, { ...oldScope, expectedEntries: scopeEntries }), ['conflict'])
  committed(await run(a.token, { ...oldScope, expectedFolders: [parent, child, newChild], expectedEntries: scopeEntries }))
  assert.ok(!(await diskEntry('scoped-old'))); assert.ok(!(await diskEntry('scoped-new')))
  assert.ok(await diskEntry('http-0')); assert.equal((await diskIndex()).folders.length, 3)
  passed('清空子树校验完整范围，新增条目使旧操作整批拒绝；重新确认后仅删除目标条目并保留目录')

  await patch(a.token, 'http-0', { tags: ['测试标签'] })
  const tagScope = refs([await diskEntry('http-0')])
  await patch(b.token, 'http-2', { tags: ['测试标签'] })
  rejected(await run(a.token, { command: 'rename-tag', from: '测试标签', to: '新标签', expectedEntries: tagScope }), ['conflict'])
  const tagEntries = refs([await diskEntry('http-0'), await diskEntry('http-2')])
  committed(await run(a.token, { command: 'rename-tag', from: '测试标签', to: '新标签', expectedEntries: tagEntries }))
  assert.deepEqual((await diskEntry('http-0')).tags, ['新标签']); assert.deepEqual((await diskEntry('http-2')).tags, ['新标签'])
  passed('全局标签操作校验完整匹配集合，避免遗漏提交期间新增的标签引用')

  const atomicSkin = fixture(44)
  rejected(await importEntry(a.token, atomicSkin, 'invalid-folder-import', '不应落盘', { folderId: 'missing' }, true))
  assert.ok(!(await h.files(a.token)).entries.some(entry => entry.path === atomicSkin.objectPath))
  rejected(await run(a.token, { command: 'import-entry', entry: atomicSkin.entry('corrupt-import', '损坏对象') }, [{ path: atomicSkin.objectPath, content: Buffer.from('invalid skin') }]))
  assert.ok(!(await h.files(a.token)).entries.some(entry => entry.path === atomicSkin.objectPath))
  assert.ok(!(await diskEntry('invalid-folder-import'))); assert.ok(!(await diskEntry('corrupt-import')))
  passed('导入业务失败或对象校验失败时索引和新对象均不落盘')

  const replayFolder = await createFolder(a.token, 'replay-folder', 'HTTP 回执目录')
  const replayTarget = await createFolder(a.token, 'replay-target', 'HTTP 回执目标')
  const replayRequest = await request(a.token, { command: 'patch-folder', expectedFolder: replayFolder, changes: { parentId: replayTarget.folderId } })
  dropCommand = 'patch-folder'
  await assert.rejects(async () => {
    const response = await fetch(base + '/api/files/commit', { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(replayRequest) })
    await response.json()
  })
  await h.release(a.token)
  const exactReceipt = await h.api(a.token, `/api/files/transactions/${replayRequest.transactionId}`)
  assert.equal(exactReceipt.status, 'committed')
  const afterMove = await diskIndex()
  const replay = await h.api(a.token, '/api/files/commit', 'POST', replayRequest)
  assert.deepEqual(replay, exactReceipt); assert.deepEqual(await diskIndex(), afterMove)
  assert.equal(afterMove.folders.find(folder => folder.folderId === replayFolder.folderId).parentId, replayTarget.folderId)
  passed('移动文件夹成功回复丢失后查询和重复原事务返回原回执，目录只移动一次')

  if (!process.argv.includes('--api-only')) {
    committed(await importEntry(a.token, skin, 'browser-a', '浏览器皮肤 A'))
    committed(await importEntry(a.token, skin, 'browser-b', '浏览器皮肤 B'))
    browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
    let acceptDeletion = false
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1560, height: 1120 } })
      const page = await context.newPage(); pages.push(page)
      page.on('pageerror', error => { pageErrors.push(error.message); console.error('Browser error:', error.stack) })
      page.on('dialog', dialog => dialog.type() === 'confirm' && acceptDeletion ? dialog.accept() : dialog.dismiss())
    }
    const [pageA, pageB] = pages
    await Promise.all([browserLogin(pageA, author.credential, '管理浏览器 A'), browserLogin(pageB, author.credential, '管理浏览器 B')])
    await Promise.all(pages.map(saved))

    const newFolder = await openNewFolder(pageA)
    await newFolder.getByPlaceholder('文件夹名称', { exact: true }).fill('保留创建输入')
    await h.api(owner.token, '/api/files/leases', 'POST', { paths: [indexPath] })
    const beforeLocked = observed.length
    await newFolder.getByRole('button', { name: '创建', exact: true }).click()
    await (await submission(pageA)).getByText('提交冲突', { exact: true }).waitFor()
    assert.equal(await newFolder.getByPlaceholder('文件夹名称', { exact: true }).inputValue(), '保留创建输入')
    assert.equal(observed.slice(beforeLocked).filter(commandOf).length, 0)
    await h.release(owner.token)
    await (await submission(pageA)).getByRole('button', { name: '重试原提交', exact: true }).click()
    await saved(pageA)
    await until(async () => (await diskIndex()).folders.some(folder => folder.name === '保留创建输入'), 'Folder retry did not persist')
    if (await newFolder.isVisible()) await newFolder.getByRole('button', { name: '取消', exact: true }).click()
    await pageB.getByRole('tree', { name: '文件夹树' }).getByRole('button', { name: '保留创建输入', exact: true }).waitFor()
    passed('创建文件夹写权失败保留对话框输入，原提交重试成功并同步到另一浏览器')

    await skinRoot(pageA); await skinRoot(pageB)
    await selectCard(pageA, '浏览器皮肤 A')
    const toolbar = pageA.getByRole('toolbar', { name: '批量操作' })
    await toolbar.getByText('已勾选 1 项', { exact: true }).waitFor()
    let releasePlan, intercepted = false
    const gatePlan = async route => {
      if (!intercepted && route.request().postDataJSON().operations?.some(operation => operation.op === 'skin-library-command')) {
        intercepted = true; await new Promise(resolve => { releasePlan = resolve })
      }
      await route.continue()
    }
    await pageA.route('**/api/files/plan', gatePlan)
    await toolbar.getByRole('button', { name: '批量禁用', exact: true }).click()
    await until(() => Boolean(releasePlan), 'Batch edit did not reach S planning')
    try {
      await card(pageB, '浏览器皮肤 B').click()
      const details = pageB.locator('aside.skinWorkspaceRight')
      await details.getByTitle('点击编辑名称', { exact: true }).click()
      await details.getByLabel('名称', { exact: true }).fill('浏览器 B 独立保存')
      await details.getByLabel('名称', { exact: true }).press('Enter')
      await saved(pageB)
    } finally { releasePlan() }
    await saved(pageA); await pageA.unroute('**/api/files/plan', gatePlan)
    assert.equal((await diskEntry('browser-a')).active, false)
    assert.equal((await diskEntry('browser-b')).name, '浏览器 B 独立保存')
    passed('双浏览器实际交互：批量操作准备期间另一条目先保存，随后双方修改都成功')

    // Selection and destination remain available when the short index lease is busy.
    if (!await toolbar.isVisible()) await selectCard(pageA, '浏览器皮肤 A')
    await toolbar.getByRole('button', { name: '移动到文件夹…', exact: true }).click()
    const move = pageA.getByRole('dialog', { name: '移动到文件夹', exact: true })
    await h.api(owner.token, '/api/files/leases', 'POST', { paths: [indexPath] })
    await move.getByRole('button', { name: '保留创建输入', exact: true }).click()
    await (await submission(pageA)).getByText('提交冲突', { exact: true }).waitFor()
    assert.ok(await move.isVisible()); await toolbar.getByText('已勾选 1 项', { exact: true }).waitFor()
    assert.equal((await diskEntry('browser-a')).folderId, null)
    await h.release(owner.token)
    await (await submission(pageA)).getByRole('button', { name: '重试原提交', exact: true }).click(); await saved(pageA)
    const destination = (await diskIndex()).folders.find(folder => folder.name === '保留创建输入')
    assert.equal((await diskEntry('browser-a')).folderId, destination.folderId)
    if (await move.isVisible()) await move.getByRole('button', { name: '关闭', exact: true }).click()
    passed('移动失败保留选择和对话框；释放写权后重试原操作，准确移动所选条目')

    await skinRoot(pageA)
    if (await toolbar.isVisible()) await toolbar.getByRole('button', { name: '取消选择', exact: true }).click()
    await selectCard(pageA, '浏览器 B 独立保存')
    await card(pageB, '浏览器 B 独立保存').click()
    const bDetails = pageB.locator('aside.skinWorkspaceRight')
    await bDetails.getByTitle('点击编辑名称', { exact: true }).click()
    await bDetails.getByLabel('名称', { exact: true }).fill('浏览器 B 更新被选项')
    await bDetails.getByLabel('名称', { exact: true }).press('Enter'); await saved(pageB)
    await card(pageA, '浏览器 B 更新被选项').waitFor()
    await toolbar.getByRole('button', { name: '批量禁用', exact: true }).click()
    await (await submission(pageA)).getByText('提交冲突', { exact: true }).waitFor()
    assert.equal((await diskEntry('browser-b')).active, true)
    await toolbar.getByText('已勾选 1 项', { exact: true }).waitFor()
    assert.equal(await (await submission(pageA)).getByRole('button', { name: '处理冲突', exact: true }).count(), 0)
    assert.equal(await (await submission(pageA)).getByRole('button', { name: '重试原提交', exact: true }).count(), 0)
    await (await submission(pageA)).getByRole('button', { name: '放弃原操作，刷新皮肤库', exact: true }).click(); await saved(pageA)
    if (await toolbar.isVisible()) await toolbar.getByRole('button', { name: '取消选择', exact: true }).click()
    passed('勾选时的条目版本不会被远端刷新静默替换；过期批量操作拒绝并保留选择，不提供整库 JSON 覆盖')

    await pageA.locator('.skinWorkspaceCenter [class*="browsePane"]').dispatchEvent('contextmenu', { clientX: 500, clientY: 400 })
    await pageA.getByRole('menuitem', { name: '导入到这里', exact: true }).click()
    const importer = pageA.getByRole('dialog', { name: '导入皮肤', exact: true })
    const uiSkin = fixture(100)
    const chooser = pageA.waitForEvent('filechooser')
    await importer.getByRole('button', { name: '添加文件…', exact: true }).click()
    await (await chooser).setFiles({ name: '浏览器导入.skin', mimeType: 'application/octet-stream', buffer: uiSkin.object })
    const importButton = importer.getByRole('button', { name: '导入选中的 1 项', exact: true })
    await importButton.waitFor()
    const beforeImport = observed.length
    dropCommand = 'import-entry'; await importButton.click()
    await (await submission(pageA)).getByText('结果待确认', { exact: true }).waitFor()
    const imported = observed.slice(beforeImport).find(request => commandOf(request)?.command === 'import-entry')
    assert.ok(imported)
    const importedId = commandOf(imported).entry.entryId
    assert.ok(await diskEntry(importedId)); assert.ok((await h.files(a.token)).entries.some(entry => entry.path === uiSkin.objectPath))
    await importer.getByRole('button', { name: '关闭', exact: true }).last().click()
    await (await submission(pageA)).getByRole('button', { name: '查询提交结果', exact: true }).click(); await saved(pageA)
    assert.equal(observed.filter(request => request.transactionId === imported.transactionId).length, 1)
    assert.equal((await diskIndex()).entries.filter(entry => entry.entryId === importedId).length, 1)
    await card(pageB, (await diskEntry(importedId)).name).waitFor()
    passed('浏览器导入对象与条目成功回复丢失后查询原回执，另一端可见且不重复导入')

    await card(pageA, (await diskEntry(importedId)).name).click({ button: 'right' })
    const beforeDelete = observed.length
    acceptDeletion = true; dropCommand = 'delete-entries'
    await pageA.getByRole('menuitem', { name: '删除', exact: true }).click()
    await (await submission(pageA)).getByText('结果待确认', { exact: true }).waitFor(); acceptDeletion = false
    const deleted = observed.slice(beforeDelete).find(request => commandOf(request)?.command === 'delete-entries')
    assert.ok(deleted); assert.ok(!(await diskEntry(importedId)))
    await pageA.reload(); await browserLogin(pageA, author.credential, '管理 A 恢复删除回执', false)
    await (await submission(pageA)).getByRole('button', { name: '查询提交结果', exact: true }).click(); await saved(pageA)
    assert.equal(observed.filter(request => request.transactionId === deleted.transactionId).length, 1)
    assert.ok(!(await diskEntry(importedId))); assert.ok((await h.files(a.token)).entries.some(entry => entry.path === uiSkin.objectPath))
    passed('浏览器删除成功回复丢失后刷新恢复事务并查询确认，不重复删除，也不误删共享对象')

    const twinA = fixture(111), twinB = fixture(112)
    const beforeTwin = observed.length
    const [importA, importB] = await Promise.all([openImport(pageA, twinA, '并行 A.skin'), openImport(pageB, twinB, '并行 B.skin')])
    await sleep(700)
    assert.ok(!observed.slice(beforeTwin).some(request => request.changes.some(change => change.path.endsWith('/import-jobs.json'))), 'Validating a local import wrote a shared job queue')
    await Promise.all(pages.map(saved))
    await importA.getByRole('button', { name: '导入选中的 1 项', exact: true }).click()
    await until(async () => (await diskIndex()).entries.some(entry => entry.skinId === twinA.skinId), 'First prepared import did not save')
    await importA.getByRole('button', { name: '关闭', exact: true }).last().click(); await saved(pageA)
    const firstName = (await diskIndex()).entries.find(entry => entry.skinId === twinA.skinId).name
    await card(pageB, firstName).waitFor()
    await importB.getByRole('button', { name: '导入选中的 1 项', exact: true }).click()
    await until(async () => (await diskIndex()).entries.some(entry => entry.skinId === twinB.skinId), 'Peer refresh lost the other browser pending import')
    await importB.getByRole('button', { name: '关闭', exact: true }).last().click(); await saved(pageB)
    assert.equal((await diskIndex()).entries.filter(entry => [twinA.skinId, twinB.skinId].includes(entry.skinId)).length, 2)
    passed('双浏览器同时校验的导入队列留在本窗口；一端先保存并刷新另一端后，另一端仍可保存准备好的不同皮肤')
    assert.deepEqual(pageErrors, [])
  }
  await mkdir(output, { recursive: true })
  for (const [i, page] of pages.entries()) await page.screenshot({ path: join(output, `client-${i}.png`) })
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ date: new Date().toISOString(), protocol: 11, transport: 'HTTP/WebSocket', physicalDevices: 1, browserContexts: pages.length, scope: 'One local S with two isolated browser contexts', proxyFaults: ['truncated successful import/delete/move responses'], results, commitRequestsObserved: observed.length }, null, 2))
  console.log(`皮肤管理验收通过：${results.length} 组。`)
} catch (error) {
  console.error('Recent commands:', observed.slice(-8).map(request => ({ id: request.transactionId, command: commandOf(request), changes: request.changes.map(change => ({ op: change.op, path: change.path })) })))
  await mkdir(output, { recursive: true })
  for (const [i, page] of pages.entries()) {
    console.error(`MANAGEMENT CLIENT ${i}:`, (await page.locator('body').innerText().catch(() => '')).slice(-8000))
    await page.screenshot({ path: join(output, `failed-client-${i}.png`) }).catch(() => undefined)
  }
  throw error
} finally {
  clearInterval(heartbeat)
  if (browser) await browser.close()
  await h.stop()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => proxy.close(resolve))
}
