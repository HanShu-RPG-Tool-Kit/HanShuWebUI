import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { active, diskJson, languagePath, login, openProgress, progressPath, progressProxy, seedProgress, sleep, until } from './progress-collaboration-helpers.mjs'

// One physical host, three storage-isolated real browser clients and real S.
// Only transport fault injection uses a proxy. All form interaction uses the
// public rendered controls; no React internals or fake service implementation.
const proxy = await progressProxy(), h = await harness({ web: true, origins: [proxy.base] })
proxy.setUpstream(h.base)
const output = resolve('../output/progress-collaboration'), results = [], pages = [], errors = []
let browser, ownerToken = ''
const heartbeat = setInterval(() => { if (ownerToken) void h.api(ownerToken, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined) }, 8000)
const passed = name => { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
const source = () => diskJson(h, progressPath)
const language = () => diskJson(h, languagePath)
const title = page => active(page).getByLabel('进度标题', { exact: true })
const number = (page, name) => active(page).getByLabel(name, { exact: true })
const status = page => page.getByRole('region', { name: '工程提交状态', exact: true })
const semanticRequests = () => proxy.observed.filter(request => request.changes.some(change => change.op === 'progress-command'))
async function saved(page) {
  await until(async () => await status(page).getByRole('status').innerText() === '修改已保存', 'Client did not settle its semantic operation')
}
async function setNumber(page, label, value) { await number(page, label).fill(String(value)); await number(page, label).press('Enter') }
async function noLeases() { assert.equal((await h.api(ownerToken, '/api/project')).leases.length, 0, 'Progress form held long-lived leases') }
async function undo(page) { await active(page).getByRole('button', { name: /^撤销/ }).click() }
async function redo(page) { await active(page).getByRole('button', { name: /^重做/ }).click() }
try {
  await mkdir(output, { recursive: true })
  assert.equal((await h.api('', '/health')).protocol, 10)
  const owner = await h.login(h.credential, 'progress browser setup'); ownerToken = owner.token
  const editorA = await h.api(ownerToken, '/api/subjects', 'POST', { name: '进度窗口作者 A', kind: 'account', role: 'editor' })
  const editorB = await h.api(ownerToken, '/api/subjects', 'POST', { name: '进度窗口作者 B', kind: 'account', role: 'editor' })
  const viewer = await h.api(ownerToken, '/api/subjects', 'POST', { name: '进度只读审阅者', kind: 'agent', role: 'viewer' })
  await seedProgress(h, ownerToken)
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } })
    await context.addInitScript(() => {
      window.__directProjectIo = 0
      Object.defineProperty(window, 'showDirectoryPicker', { value: () => { window.__directProjectIo++; throw new Error('C must not open the OS project directory') } })
      for (const [type, method] of [['FileSystemFileHandle', 'createWritable'], ['FileSystemDirectoryHandle', 'removeEntry']]) {
        if (window[type]) Object.defineProperty(window[type].prototype, method, { value: () => { window.__directProjectIo++; throw new Error('C must not mutate the OS project directory') } })
      }
    })
    const page = await context.newPage(); pages.push(page)
    page.on('pageerror', error => { errors.push(error.message); console.error(error.stack) }); page.on('dialog', dialog => dialog.dismiss())
  }
  const [a, b, v] = pages
  await Promise.all([login(a, proxy.base, editorA.credential, '进度窗口 A'), login(b, proxy.base, editorB.credential, '进度窗口 B'), login(v, proxy.base, viewer.credential, '进度只读窗口')])
  await Promise.all(pages.map(openProgress))
  await until(() => title(a).isEnabled(), 'Writer progress form still requires manually taking write ownership')
  assert.ok(await title(b).isEnabled()); assert.ok(await title(v).isDisabled())
  assert.equal(await active(a).getByRole('button', { name: '开始编辑', exact: true }).count(), 0)
  assert.equal(proxy.observed.length, 0, 'Merely opening a progress form issued a project mutation')
  const initialFiles = (await h.files(ownerToken)).entries
  assert.ok(initialFiles.some(file => file.path === 'src/goal/acceptance_counter.py'))
  assert.ok(!initialFiles.some(file => file.path === 'src/script/acceptance_counter.py'), 'Opening a page silently moved its goal definition to an ordinary script folder')
  await noLeases()
  await title(a).fill('无需保存按钮的进度标题')
  await until(async () => (await language()).name === '无需保存按钮的进度标题', 'Idle title input did not autosubmit')
  await until(async () => await title(b).inputValue() === '无需保存按钮的进度标题', 'Peer title did not update')
  await active(b).getByRole('button', { name: '完成任一', exact: true }).click()
  await until(async () => (await source()).completion === 'any', 'Discrete completion operation did not autosubmit')
  await Promise.all([saved(a), saved(b)])
  await noLeases()
  passed('三个独立客户端中写者直接编辑、读者只读；文本停顿和离散操作自动提交并同步，不保留文件写权')

  proxy.holdNextRequest()
  await setNumber(a, '目标数量', 20)
  await until(() => proxy.held !== null, 'A did not reach held progress command')
  await setNumber(b, '额外数量', 7)
  await until(async () => (await source()).goals[0].config.bonus === 7, 'B distinct parameter did not save during A request hold')
  proxy.release()
  await until(async () => (await source()).goals[0].config.target === 20, 'A original field operation did not merge into latest server document')
  await Promise.all([saved(a), saved(b)])
  assert.deepEqual((await source()).goals[0].config, { target: 20, bonus: 7 })
  await until(async () => await number(a, '额外数量').inputValue() === '7' && await number(b, '目标数量').inputValue() === '20', 'Browser forms did not converge')
  await undo(a)
  await until(async () => (await source()).goals[0].config.target === 10, 'Own operation undo did not reach S')
  assert.equal((await source()).goals[0].config.bonus, 7)
  await saved(a); await redo(a)
  await until(async () => (await source()).goals[0].config.target === 20, 'Own operation redo did not reach S')
  assert.equal((await source()).goals[0].config.bonus, 7)
  await saved(a); await noLeases()
  passed('真实并发的不同目标参数合并，撤销与重做本窗口操作不会回退另一作者的参数')

  const beforeIme = semanticRequests().length, originalTitle = (await language()).name
  await title(a).dispatchEvent('compositionstart', { data: '' })
  await title(a).fill('zhongwen')
  await sleep(850)
  assert.equal((await language()).name, originalTitle, 'IME intermediate input was committed')
  assert.equal(semanticRequests().length, beforeIme, 'Composition issued a semantic request')
  await title(a).fill('中文输入完成')
  await title(a).dispatchEvent('compositionend', { data: '中文输入完成' })
  await until(async () => (await language()).name === '中文输入完成', 'Completed composition did not autosubmit')
  await saved(a)
  assert.equal(semanticRequests().length, beforeIme + 1)
  passed('中文组合输入期间不提交半成品，compositionend 后仅提交最终文字')

  proxy.holdNextResponse()
  await title(a).fill('回执尚未收到的标题')
  await until(() => proxy.held !== null, 'Did not hold committed progress response')
  assert.equal((await language()).name, '回执尚未收到的标题')
  await title(a).fill('提交期间继续输入的最终标题')
  await sleep(700)
  assert.equal(await title(a).inputValue(), '提交期间继续输入的最终标题')
  proxy.release()
  await until(async () => (await language()).name === '提交期间继续输入的最终标题', 'Later typing was not submitted after original acknowledgement')
  await saved(a)
  assert.equal(await title(a).inputValue(), '提交期间继续输入的最终标题')
  passed('提交结果返回期间继续输入保留，并在上一操作确认后自动提交后续修改')

  const beforeLost = await h.api(ownerToken, '/api/history/stats')
  proxy.dropNextResponse()
  await title(a).fill('成功但回复丢失的标题')
  await until(async () => /结果待确认|结果未知|尚未确认|待确认/.test(await active(a).innerText()) || /结果待确认/.test(await status(a).innerText()), 'Lost successful response was not presented as uncertain')
  assert.equal((await language()).name, '成功但回复丢失的标题')
  await until(async () => await title(b).inputValue() === '成功但回复丢失的标题', 'B did not observe the committed unknown outcome')
  await title(b).fill('另一作者在旧回执确认前提交的标题')
  await until(async () => (await language()).name === '另一作者在旧回执确认前提交的标题', 'B could not edit after the unknown successful operation')
  await saved(b)
  const sentBeforeQuery = semanticRequests().length
  await a.getByRole('button', { name: '查询提交结果', exact: true }).first().click()
  await saved(a)
  assert.equal(semanticRequests().length, sentBeforeQuery, 'Confirming success resubmitted the command')
  assert.equal((await h.api(ownerToken, '/api/history/stats')).revisions, beforeLost.revisions + 2)
  assert.equal((await language()).name, '另一作者在旧回执确认前提交的标题')
  await until(async () => await title(a).inputValue() === '另一作者在旧回执确认前提交的标题', 'Historical receipt regressed the form or failed to adopt the current confirmed server text')
  await noLeases()
  passed('成功回复丢失后查询原事务，不重复提交；较旧回执不回退另一作者随后提交的内容')

  await until(async () => await number(b, '目标数量').inputValue() === '20', 'B lacks latest target before conflict')
  proxy.holdNextRequest()
  await setNumber(a, '目标数量', 30)
  await until(() => proxy.held !== null, 'Did not hold stale same-field command')
  await setNumber(b, '目标数量', 40)
  await until(async () => (await source()).goals[0].config.target === 40, 'B same-field edit did not save')
  await saved(b); proxy.release()
  await until(async () => /冲突/.test(await active(a).innerText()) || /提交冲突/.test(await status(a).innerText()), 'Stale same-field operation did not surface conflict')
  assert.equal(await number(a, '目标数量').inputValue(), '30', 'Conflict discarded local field input')
  assert.equal((await source()).goals[0].config.target, 40)
  await a.screenshot({ path: join(output, 'progress-conflict-keeps-input.png') })
  passed('同字段竞争由真实 S 拒绝，界面保留本地填写并提示冲突，不回退已提交的另一作者内容')

  await active(a).getByRole('button', { name: '采用服务器版本', exact: true }).click()
  await until(async () => await number(a, '目标数量').inputValue() === '40', 'Explicit remote adoption did not clear rejected local intent')
  await saved(a)
  await setNumber(a, '额外数量', 8)
  await until(async () => (await source()).goals[0].config.bonus === 8, 'A undo-conflict fixture did not save')
  await saved(a)
  await until(async () => await number(b, '额外数量').inputValue() === '8', 'B did not receive A undo-conflict fixture')
  await setNumber(b, '额外数量', 9)
  await until(async () => (await source()).goals[0].config.bonus === 9, 'B intervening same-field change did not save')
  await saved(b)
  const beforeUndoConflict = (await h.api(ownerToken, '/api/history/stats')).revisions
  await undo(a)
  await until(async () => /冲突/.test(await status(a).innerText()), 'Undo over a peer same-field edit was not rejected')
  assert.equal((await source()).goals[0].config.bonus, 9)
  assert.equal((await h.api(ownerToken, '/api/history/stats')).revisions, beforeUndoConflict)
  await active(a).getByRole('button', { name: '取消本次撤销', exact: true }).click()
  await saved(a)
  passed('显式采用服务器版本解除冲突；之后若同字段被他人修改，撤销在 S 拒绝且保留他人值与历史')

  await h.api(ownerToken, '/api/files/leases', 'POST', { paths: [progressPath] })
  await setNumber(b, '额外数量', 12)
  await until(async () => /写权|锁定|占用/.test(await status(b).innerText()), 'Locked autosubmit did not surface recoverable failure')
  assert.equal((await source()).goals[0].config.bonus, 9)
  await b.reload(); await login(b, proxy.base, editorB.credential, '进度窗口 B 刷新恢复', false); await openProgress(b)
  await until(async () => await number(b, '额外数量').inputValue() === '12', 'Reload lost unconfirmed local progress parameter')
  assert.equal((await source()).goals[0].config.bonus, 9)
  await h.release(ownerToken)
  await b.getByRole('button', { name: '重试原提交', exact: true }).first().click()
  await until(async () => (await source()).goals[0].config.bonus === 12, 'Restored locked command did not retry')
  await saved(b); await noLeases()
  passed('临时写权失败保留操作和字段草稿；刷新恢复原提交，释放锁后重试成功')

  await h.api(ownerToken, `/api/subjects/${editorB.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  await until(() => title(b).isDisabled(), 'Active client did not become read-only after server role change')
  await h.api(ownerToken, `/api/subjects/${editorB.subject.id}`, 'PATCH', { role: 'editor', enabled: true })
  await until(() => title(b).isEnabled(), 'Role restoration did not re-enable progress form')
  await noLeases()
  passed('在线权限变更立即影响表单可编辑性，恢复编辑权限无需手动申请长期写权')

  const beforeCloneTitle = (await language()).name, beforeCloneRequests = semanticRequests().length
  await title(a).dispatchEvent('compositionstart', { data: '' })
  await title(a).fill('只属于原窗口的未提交草稿')
  const popupPromise = a.waitForEvent('popup')
  await a.evaluate(url => { window.open(url, '_blank') }, proxy.base)
  const duplicate = await popupPromise
  duplicate.on('pageerror', error => errors.push(error.message)); duplicate.on('dialog', dialog => dialog.dismiss())
  try {
    await login(duplicate, proxy.base, editorA.credential, '复制窗口不能继承原草稿', false)
    await openProgress(duplicate)
    await until(async () => await title(duplicate).inputValue() === beforeCloneTitle, 'A live duplicate inherited another window\'s pending progress draft')
    assert.ok(await active(duplicate).getByRole('button', { name: '撤销', exact: true }).isDisabled(), 'A live duplicate inherited another window\'s undo stack')
    assert.equal(await title(a).inputValue(), '只属于原窗口的未提交草稿')
    await sleep(700)
    assert.equal(semanticRequests().length, beforeCloneRequests, 'A duplicate automatically submitted the original window\'s pending draft')
    assert.equal((await language()).name, beforeCloneTitle)
  } finally { await duplicate.close() }
  await undo(a)
  await title(a).dispatchEvent('compositionend', { data: '' })
  await saved(a)
  assert.equal(await title(a).inputValue(), beforeCloneTitle)
  passed('真实 window.open 复制窗口隔离未提交草稿与撤销栈，原窗口输入保留且复制窗口不会替它提交')

  const beforeReplacementTitle = (await language()).name, beforeReplacementRequests = semanticRequests().length
  await title(a).dispatchEvent('compositionstart', { data: '' })
  await title(a).fill('不能写入同路径替换文档的旧草稿')
  const replacement = { ...await source(), id: 'replacement-progress-document' }
  try { assert.equal((await h.commit(ownerToken, [{ path: progressPath, content: JSON.stringify(replacement) }])).status, 'committed') }
  finally { await h.release(ownerToken) }
  await active(a).getByRole('button', { name: '舍弃本地草稿并打开替换后的进度', exact: true }).waitFor()
  await title(a).dispatchEvent('compositionend', { data: '不能写入同路径替换文档的旧草稿' })
  await sleep(700)
  assert.equal(semanticRequests().length, beforeReplacementRequests, 'Old pending intent was rebound to a replacement document identity')
  assert.equal((await source()).id, 'replacement-progress-document')
  assert.equal((await language()).name, beforeReplacementTitle)
  assert.equal(await title(a).inputValue(), '不能写入同路径替换文档的旧草稿')
  assert.ok(await title(a).isDisabled(), 'Replaced document did not pause old editing intent')
  await active(a).getByRole('button', { name: '舍弃本地草稿并打开替换后的进度', exact: true }).click()
  await until(async () => await active(a).getByLabel('文档 ID', { exact: true }).inputValue() === 'replacement-progress-document', 'Explicit replacement adoption did not load the new identity')
  assert.equal(await title(a).inputValue(), beforeReplacementTitle)
  assert.ok(await active(a).getByRole('button', { name: '撤销', exact: true }).isDisabled())
  await saved(a)
  passed('同路径换成新文档身份时暂停旧草稿，即使原字段值相同也不套用；显式舍弃后才打开新文档')

  for (const page of pages) assert.equal(await page.evaluate(() => window.__directProjectIo), 0)
  assert.deepEqual(errors, [])
  await a.screenshot({ path: join(output, 'progress-autosubmit-collaboration.png') })
  await writeFile(join(output, 'ui-acceptance.json'), JSON.stringify({ protocol: 10, physicalHosts: 1, isolatedBrowserContexts: 3, browserPages: 4, tests: results, pageErrors: errors }, null, 2))
  console.log(`进度操作浏览器验收通过：${results.length} 组。`)
} catch (error) {
  for (const [index, page] of pages.entries()) {
    console.error(`CLIENT ${index}:`, (await page.locator('body').innerText()).slice(-5000))
    await page.screenshot({ path: join(output, `progress-failure-${index}.png`) }).catch(() => undefined)
  }
  throw error
} finally { clearInterval(heartbeat); proxy.release(); await browser?.close(); await h.stop(); await proxy.close() }
