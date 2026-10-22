import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'

// A real S, two independent browser contexts, and a fault-injecting HTTP/WS
// proxy. These checks use user-facing controls and authoritative disk contents;
// they do not call React internals or substitute a mock project client.
const indexPath = '.hanshu/skinmanager/library.json'
const results = [], observed = [], pages = [], pageErrors = []
const sockets = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let upstream, holdNextPatch = false, releaseHeldPatch, heldPatchId, dropNextPatch = false
const proxy = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const commit = req.url === '/api/files/commit' ? JSON.parse(body.toString()) : null
  if (commit) observed.push(commit)
  const isPatch = commit?.changes.some(change => change.op === 'skin-entry-patch')
  const hold = isPatch && holdNextPatch
  const drop = isPatch && dropNextPatch
  if (hold) holdNextPatch = false
  if (drop) dropNextPatch = false
  const target = new URL(req.url, upstream)
  const outgoing = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, async response => {
    const responseChunks = []
    for await (const chunk of response) responseChunks.push(chunk)
    const responseBody = Buffer.concat(responseChunks)
    if (hold) {
      assert.equal(JSON.parse(responseBody).status, 'committed')
      heldPatchId = commit.transactionId
      await new Promise(resolve => { releaseHeldPatch = resolve })
    }
    if (drop) {
      assert.equal(JSON.parse(responseBody).status, 'committed', 'Lose only an already committed response')
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': responseBody.length })
      res.write(responseBody.subarray(0, Math.max(1, Math.floor(responseBody.length / 2))))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(response.statusCode, response.headers)
    res.end(responseBody)
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
    remote.write('\r\n')
    if (head.length) remote.write(head)
    socket.pipe(remote); remote.pipe(socket)
  })
  remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
})
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
const base = `http://127.0.0.1:${proxy.address().port}`
const h = await harness({ web: true, origins: [base] }); upstream = h.base
let browser
const output = resolve('../output/skin-collaboration')
const tokens = []
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
async function patchRequest(token, entryId, expectedRevision, changes, version) {
  const plan = await h.api(token, '/api/files/plan', 'POST', { operations: [{ op: 'skin-entry-patch', path: indexPath, destination: null }] })
  const leases = await h.api(token, '/api/files/leases', 'POST', { paths: plan.leasePaths })
  return { transactionId: randomUUID(), changes: [{
    op: 'skin-entry-patch', path: indexPath, version: version ?? null,
    destination: null, destinationVersion: null,
    content: Buffer.from(JSON.stringify({ entryId, expectedRevision, changes })).toString('base64'),
    leaseId: leases.find(lease => lease.resourceId === `file:${indexPath}`).id,
  }] }
}
async function patch(token, entryId, expectedRevision, changes, version) {
  const request = await patchRequest(token, entryId, expectedRevision, changes, version)
  try { return await h.api(token, '/api/files/commit', 'POST', request) }
  finally { await h.release(token) }
}
function skinFixture() {
  const rgba = Buffer.alloc(64 * 64 * 4, 255)
  const canonical = Buffer.alloc(15 + rgba.length)
  canonical.write('HSKN'); canonical[4] = 1
  canonical.writeUInt16BE(64, 7); canonical.writeUInt16BE(64, 9); canonical.writeUInt32BE(rgba.length, 11); rgba.copy(canonical, 15)
  const skinId = createHash('sha256').update(canonical).digest('hex')
  const payload = deflateSync(rgba), object = Buffer.alloc(16 + payload.length)
  canonical.copy(object, 0, 0, 11); object[11] = 1; object.writeUInt32BE(payload.length, 12); payload.copy(object, 16)
  const pngChunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8)
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6
  const rows = Buffer.alloc(64 * (64 * 4 + 1))
  for (let y = 0; y < 64; y++) rgba.copy(rows, y * 257 + 1, y * 256, (y + 1) * 256)
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
  const now = '2026-10-22T00:00:00.000Z'
  const entry = (entryId, name) => ({ entryId, skinId, name, active: true, tags: [], folderId: null, favorite: false, model: 'classic', textureWidth: 64, textureHeight: 64, source: { kind: 'skin-code' }, provenance: { author: null, sourceName: null, sourceUrl: null, sourceNote: null, originalCreatedAt: null }, license: { status: 'unspecified', name: null, url: null, note: null }, note: '', customId: null, createdAt: now, updatedAt: now, revision: 1 })
  return { objectPath: `.hanshu/skinmanager/objects/${skinId.slice(0, 2)}/${skinId}.skin`, object, pngPath: `.hanshu/skinmanager/cache/png/${skinId}.png`, png, index: { schemaVersion: 5, revision: 1, folders: [], entries: [entry('skin-entry-a', '皮肤 A'), entry('skin-entry-b', '皮肤 B')] } }
}
async function browserLogin(page, credential, name, navigate = true) {
  if (navigate) await page.goto(base)
  await page.getByRole('button', { name: '打开工程…', exact: true }).click()
  const form = page.getByRole('form', { name: '打开工程', exact: true })
  await form.getByLabel('服务地址', { exact: true }).fill(base)
  await form.getByLabel('主体凭证', { exact: true }).fill(credential)
  await form.getByLabel('本端名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '连接并打开工程', exact: true }).click()
  await page.locator('.project-service-bar').getByText('统一工程验收', { exact: true }).waitFor()
}
const details = page => page.locator('aside.skinWorkspaceRight')
const submitState = page => page.getByRole('region', { name: '工程提交状态', exact: true })
async function openSkin(page, name) {
  await page.getByRole('tab', { name: '皮肤管理器', exact: true }).click()
  await page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).first().click()
  await details(page).getByTitle('点击编辑名称', { exact: true }).waitFor()
}
async function editName(page, name) {
  const field = details(page).getByLabel('名称', { exact: true })
  if (!await field.count()) await details(page).getByTitle('点击编辑名称', { exact: true }).click()
  await field.fill(name)
  return field
}
async function saveName(page, name) { const field = await editName(page, name); await field.press('Enter') }
async function saved(page) {
  await until(async () => await submitState(page).getByRole('status').innerText() === '修改已保存', 'Client submission did not settle')
}

try {
  assert.equal((await h.api('', '/health')).protocol, 9)
  const owner = await h.login(h.credential, 'skin setup')
  const author = await h.api(owner.token, '/api/subjects', 'POST', { name: '皮肤协作编辑者', kind: 'account', role: 'editor' })
  const a = await h.login(author.credential, 'skin API A'), b = await h.login(author.credential, 'skin API B')
  tokens.push(owner.token, a.token, b.token)
  const fixture = skinFixture()
  await h.commit(owner.token, [{ path: fixture.objectPath, content: fixture.object }, { path: fixture.pngPath, content: fixture.png }, { op: 'mkdir', path: '.hanshu/skinmanager/tmp' }, { path: indexPath, content: JSON.stringify(fixture.index) }])
  await h.release(owner.token)
  const originalVersion = (await h.files(a.token)).entries.find(entry => entry.path === indexPath).version
  const first = await patch(a.token, 'skin-entry-a', 1, { name: 'HTTP A' }, originalVersion)
  const second = await patch(b.token, 'skin-entry-b', 1, { name: 'HTTP B' }, originalVersion)
  assert.equal(first.status, 'committed'); assert.equal(second.status, 'committed')
  assert.equal((await diskEntry('skin-entry-a')).name, 'HTTP A'); assert.equal((await diskEntry('skin-entry-b')).name, 'HTTP B')
  assert.equal(first.skinEntries[0].revision, 2); assert.equal(second.skinEntries[0].revision, 2)
  passed('两个旧索引客户端修改不同条目均成功，精确条目回执与双方结果完整保留')

  const staleEntry = await patch(a.token, 'skin-entry-a', 1, { name: '不得覆盖 HTTP A' }, originalVersion)
  assert.equal(staleEntry.status, 'rejected'); assert.equal(staleEntry.error.code, 'conflict')
  const staleIndex = await h.prepare(a.token, [{ path: indexPath, content: JSON.stringify(fixture.index), version: originalVersion }])
  const staleIndexResult = await h.api(a.token, '/api/files/commit', 'POST', staleIndex)
  assert.equal(staleIndexResult.status, 'rejected'); assert.equal(staleIndexResult.error.code, 'conflict')
  await h.release(a.token)
  assert.equal((await diskEntry('skin-entry-a')).name, 'HTTP A'); assert.equal((await diskEntry('skin-entry-b')).name, 'HTTP B')
  passed('同条目过期 patch 和旧整库写入均拒绝，条目提交不削弱原文件 CAS')

  const mixed = await patchRequest(a.token, 'skin-entry-a', 2, { note: '不得部分成功' }, originalVersion)
  const unrelated = await h.prepare(a.token, [{ path: 'meta/docs/notes.md', content: '不得部分成功', version: 'stale' }])
  mixed.changes.push(...unrelated.changes)
  const mixedResult = await h.api(a.token, '/api/files/commit', 'POST', mixed)
  assert.equal(mixedResult.status, 'rejected'); assert.equal(mixedResult.error.code, 'conflict')
  await h.release(a.token)
  assert.equal((await diskEntry('skin-entry-a')).note, '')
  assert.equal(await readFile(join(h.root, 'meta/docs/notes.md'), 'utf8'), h.fixtures['meta/docs/notes.md'])
  passed('条目 patch 与其他文件共用事务，任一版本冲突时整批不落盘')

  if (!process.argv.includes('--api-only')) {
    browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1550, height: 1120 } })
      const page = await context.newPage(); pages.push(page)
      page.on('pageerror', error => { pageErrors.push(error.message); console.error('Browser error:', error.stack) }); page.on('dialog', dialog => dialog.dismiss())
    }
    const [pageA, pageB] = pages
    await Promise.all([browserLogin(pageA, author.credential, '皮肤浏览器 A'), browserLogin(pageB, author.credential, '皮肤浏览器 B')])
    await Promise.all(pages.map(page => openSkin(page, 'HTTP A')))
    await Promise.all(pages.map(saved))

    const aInput = await editName(pageA, 'A 尚未提交的名称')
    await saveName(pageB, 'B 更新后的名称')
    await until(async () => (await diskEntry('skin-entry-a')).name === 'B 更新后的名称', 'Peer skin edit did not persist')
    await saved(pageB)
    await details(pageA).getByText('远端已有更新，本地输入已保留。', { exact: true }).waitFor()
    assert.equal(await aInput.inputValue(), 'A 尚未提交的名称')
    assert.equal(await aInput.evaluate(input => document.activeElement === input), true, 'Remote update stole the input focus')
    passed('另一端修改同条目后，未失焦输入与编辑焦点保留并显示远端更新提示')

    await pageA.reload(); await browserLogin(pageA, author.credential, '皮肤浏览器 A 恢复草稿', false)
    await openSkin(pageA, 'B 更新后的名称')
    assert.equal(await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText(), 'A 尚未提交的名称')
    await details(pageA).getByText('远端已有更新，本地输入已保留。', { exact: true }).waitFor()
    assert.equal((await diskEntry('skin-entry-a')).name, 'B 更新后的名称')
    await details(pageA).getByRole('button', { name: '采用远端', exact: true }).click()
    await until(async () => await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText() === 'B 更新后的名称', 'Explicit server adoption did not update the form')
    passed('刷新恢复未提交草稿及原基准，采用远端是显式操作且不写回旧内容')

    // Freeze A after its form captured the entry revision but before acquiring a
    // lease. B can legitimately commit in this interval; A must not rebase itself.
    let releasePlan, interceptedPlan = false
    const gatePlan = async route => {
      const request = route.request().postDataJSON()
      if (!interceptedPlan && request.operations?.some(operation => operation.op === 'skin-entry-patch')) {
        interceptedPlan = true
        await new Promise(resolve => { releasePlan = resolve })
      }
      await route.continue()
    }
    await pageA.route('**/api/files/plan', gatePlan)
    const beforeStale = observed.length
    await saveName(pageA, 'A 需要处理冲突的名称')
    await until(() => Boolean(releasePlan), 'A did not reach the held operation plan')
    try {
      await saveName(pageB, 'B 在 A 提交前保存的新名称')
      await until(async () => (await diskEntry('skin-entry-a')).name === 'B 在 A 提交前保存的新名称', 'B could not save during A planning')
      await saved(pageB)
    } finally { releasePlan() }
    await submitState(pageA).getByText('提交冲突', { exact: true }).waitFor()
    await pageA.unroute('**/api/files/plan', gatePlan)
    assert.equal(await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText(), 'A 需要处理冲突的名称')
    assert.equal((await diskEntry('skin-entry-a')).name, 'B 在 A 提交前保存的新名称')
    const staleBrowserRequest = observed.slice(beforeStale).find(request => request.changes.some(change => change.op === 'skin-entry-patch' && JSON.parse(Buffer.from(change.content, 'base64').toString()).changes.name === 'A 需要处理冲突的名称'))
    assert.ok(staleBrowserRequest, 'The stale write must reach S and be rejected by entry revision')
    const staleBrowserReceipt = await h.api(a.token, `/api/files/transactions/${staleBrowserRequest.transactionId}`)
    assert.equal(staleBrowserReceipt.status, 'rejected'); assert.equal(staleBrowserReceipt.error.code, 'conflict')
    await details(pageA).getByRole('button', { name: '保留修改并重新提交', exact: true }).click()
    await until(async () => (await diskEntry('skin-entry-a')).name === 'A 需要处理冲突的名称', 'Explicit conflict resolution did not save the retained draft')
    await saved(pageA)
    passed('真实并发提交中同条目旧版本被 S 拒绝，保留草稿并经显式处理后重新提交')

    holdNextPatch = true; heldPatchId = undefined
    await saveName(pageA, '先提交的名称')
    await until(() => Boolean(heldPatchId), 'Did not intercept the successful skin response')
    const continuing = await editName(pageA, '保存期间继续输入的名称')
    releaseHeldPatch(); releaseHeldPatch = undefined
    await saved(pageA)
    assert.equal(await continuing.inputValue(), '保存期间继续输入的名称', 'Save acknowledgement overwrote later local input')
    assert.equal((await diskEntry('skin-entry-a')).name, '先提交的名称')
    await continuing.press('Enter')
    await until(async () => (await diskEntry('skin-entry-a')).name === '保存期间继续输入的名称', 'Continued input could not save after the first response')
    await saved(pageA)
    passed('保存回执只确认已提交内容，期间继续输入保留且可再次提交')

    await h.api(owner.token, '/api/files/leases', 'POST', { paths: [indexPath] })
    const beforeLocked = observed.length
    await saveName(pageA, '获取写权失败的草稿')
    await submitState(pageA).getByText('提交冲突', { exact: true }).waitFor()
    assert.equal(observed.length, beforeLocked, 'A lease acquisition failure sent a commit anyway')
    assert.equal((await diskEntry('skin-entry-a')).name, '保存期间继续输入的名称')
    assert.equal(await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText(), '获取写权失败的草稿')
    await h.release(owner.token)
    await openSkin(pageA, 'HTTP B')
    await saveName(pageA, '同客户端另一条目仍可编辑')
    await until(async () => (await diskEntry('skin-entry-b')).name === '同客户端另一条目仍可编辑', 'A failed patch blocked an unrelated entry in the same client')
    await until(async () => await submitState(pageA).getByRole('status').innerText() === '1 次提交待处理', 'Independent entry save did not settle while the original failure stayed recoverable')
    await openSkin(pageA, '保存期间继续输入的名称')
    assert.equal(await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText(), '获取写权失败的草稿')
    await submitState(pageA).getByRole('button', { name: '重试原提交', exact: true }).click()
    await until(async () => (await diskEntry('skin-entry-a')).name === '获取写权失败的草稿', 'Retry after lease release did not persist original draft')
    await saved(pageA)
    passed('写权失败不发送提交、不丢草稿；独立条目可继续编辑，原请求释放写权后可重试')

    const beforeUnknown = observed.length
    dropNextPatch = true
    await saveName(pageA, '丢失回复但已保存的名称')
    await submitState(pageA).getByText('结果待确认', { exact: true }).waitFor()
    const unknown = observed.slice(beforeUnknown).find(request => request.changes.some(change => change.op === 'skin-entry-patch'))
    assert.ok(unknown)
    assert.equal((await diskEntry('skin-entry-a')).name, '丢失回复但已保存的名称')
    await pageA.reload(); await browserLogin(pageA, author.credential, '皮肤浏览器 A 恢复回执', false)
    await openSkin(pageA, '丢失回复但已保存的名称')
    await submitState(pageA).getByRole('button', { name: '查询提交结果', exact: true }).click()
    await saved(pageA)
    assert.equal(observed.filter(request => request.transactionId === unknown.transactionId).length, 1, 'Receipt confirmation submitted the patch twice')
    assert.equal(await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText(), '丢失回复但已保存的名称')
    passed('皮肤成功回执丢失后刷新恢复事务，查询确认精确结果且不重复 patch')

    const beforeHistorical = observed.length
    dropNextPatch = true
    await saveName(pageA, '等待确认的历史皮肤名称')
    await submitState(pageA).getByText('结果待确认', { exact: true }).waitFor()
    const historical = observed.slice(beforeHistorical).find(request => request.changes.some(change => change.op === 'skin-entry-patch'))
    assert.ok(historical)
    const historicalEntry = await diskEntry('skin-entry-a')
    const newer = await patch(b.token, 'skin-entry-a', historicalEntry.revision, { name: '历史回执之后的远端新名称' })
    assert.equal(newer.status, 'committed')
    await pageA.locator('.skinWorkspaceCenter').getByText('历史回执之后的远端新名称', { exact: true }).waitFor()
    await submitState(pageA).getByRole('button', { name: '查询提交结果', exact: true }).click()
    await saved(pageA)
    await until(async () => await details(pageA).getByTitle('点击编辑名称', { exact: true }).innerText() === '历史回执之后的远端新名称', 'An old successful receipt rolled the clean entry view back over a later peer revision')
    assert.equal(observed.filter(request => request.transactionId === historical.transactionId).length, 1)
    assert.equal((await diskEntry('skin-entry-a')).name, '历史回执之后的远端新名称')
    passed('确认历史皮肤回执不回退后来远端版本，无后续本地修改时显示最新条目')

    assert.deepEqual(pageErrors, [])
  }
  await mkdir(output, { recursive: true })
  for (const [i, page] of pages.entries()) await page.screenshot({ path: join(output, `client-${i}.png`) })
  await writeFile(join(output, 'acceptance.json'), JSON.stringify({ date: new Date().toISOString(), protocol: 9, transport: 'HTTP/WebSocket', physicalDevices: 1, browserContexts: pages.length, scope: 'One local S with two isolated browser contexts', proxyFaults: ['held successful patch response', 'truncated successful patch response'], results, commitRequestsObserved: observed.length }, null, 2))
  console.log(`皮肤协作验收通过：${results.length} 组。`)
} catch (error) {
  console.error('Recent commits:', observed.slice(-5).map(request => ({ transactionId: request.transactionId, changes: request.changes.map(change => ({ op: change.op, path: change.path })) })))
  await mkdir(output, { recursive: true })
  for (const [i, page] of pages.entries()) {
    console.error(`SKIN CLIENT ${i}:`, (await page.locator('body').innerText().catch(() => '')).slice(-7000))
    await page.screenshot({ path: join(output, `failed-client-${i}.png`) }).catch(() => undefined)
  }
  throw error
} finally {
  releaseHeldPatch?.(); clearInterval(heartbeat)
  if (browser) await browser.close()
  await h.stop()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => proxy.close(resolve))
}
