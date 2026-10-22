import {projectMenu,waitProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { scriptPath, progressPath, progressLangPath, skinIndexPath, skinFixture, replyLossProxy, until } from './history-test-helpers.mjs'

// Browser acceptance uses visible controls against real S, with isolated
// browser storage per client. This does not claim a second physical LAN device.
const output = resolve('../output/project-history')
const proxy = await replyLossProxy(), h = await harness({ web: true, origins: [proxy.base] })
proxy.setUpstream(h.base)
const results = [], pages = [], pageErrors = []
let browser, ownerToken = ''
const heartbeat = setInterval(() => { if (ownerToken) void h.api(ownerToken, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined) }, 8000)
const passed = name => { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
const active = page => page.locator('.app-workspace-pane.active')
const dialog = page => page.getByRole('dialog', { name: '工程历史', exact: true })
const disk = path => readFile(join(h.root, path), 'utf8')
async function commit(edits) {
  try { const receipt = await h.commit(ownerToken, edits); assert.equal(receipt.status, 'committed'); return receipt }
  finally { await h.release(ownerToken) }
}
async function login(page, credential, name) {
  await page.addInitScript(value=>sessionStorage.setItem('hanshu.windowName',value),name)
  await page.goto(proxy.base)
  await projectMenu(page,'连接其他服务器…')
  const form = page.getByRole('form',{name:'连接其他服务器',exact:true})
  await form.getByLabel('服务地址', { exact: true }).fill(proxy.base)
  await form.getByLabel('主体凭证', { exact: true }).fill(credential)

  await form.getByRole('button', { name: '连接并打开工程', exact: true }).click()
  await waitProject(page,'统一工程验收')
}
async function openHistory(page) {
  await page.getByRole('button', { name: '工程历史', exact: true }).click()
  await dialog(page).waitFor()
  await dialog(page).getByRole('button', { name: '刷新工程历史', exact: true }).waitFor()
}
async function closeHistory(page) { await dialog(page).getByRole('button', { name: '关闭工程历史', exact: true }).click(); await dialog(page).waitFor({ state: 'hidden' }) }
async function selectVersion(page, sequence) {
  for (const summary of await dialog(page).locator('details:not([open]) > summary').all()) await summary.click()
  await dialog(page).getByRole('button', { name: `查看版本 ${sequence}`, exact: true }).first().click()
}
async function historyRefresh(page) { await dialog(page).getByRole('button', { name: '刷新工程历史', exact: true }).click() }
async function openProgress(page) {
  await page.getByRole('tab', { name: '进度流程', exact: true }).click()
  await active(page).getByLabel('筛选资源', { exact: true }).fill('example.progress')
  await active(page).locator('[role=treeitem][title="example.progress"]').click()
  await active(page).getByLabel('进度标题', { exact: true }).waitFor()
}
async function editorText(page) { return (await active(page).locator('.monaco-editor .view-lines').allTextContents()).join('\n').replace(/\u00a0/g, ' ') }
try {
  await mkdir(output, { recursive: true })
  assert.equal((await h.api('', '/health')).protocol, 10)
  const owner = await h.login(h.credential, '历史验收 API'); ownerToken = owner.token
  const editor = await h.api(ownerToken, '/api/subjects', 'POST', { name: '历史协作者', kind: 'account', role: 'editor' })
  const viewer = await h.api(ownerToken, '/api/subjects', 'POST', { name: '历史审阅者', kind: 'agent', role: 'viewer' })
  const skin = skinFixture(110)
  await commit([{ path: scriptPath, content: '标题：历史第一版\n\n第一版正文\n' }, { path: progressLangPath, content: JSON.stringify({ name: '历史进度第一版', description: '历史中的原始描述' }) }, { path: skin.objectPath, content: skin.object }, { path: skinIndexPath, content: JSON.stringify({ schemaVersion: 5, revision: 1, folders: [], entries: [skin.entry('history-ui-skin', '历史皮肤'), skin.entry('history-ui-other', '不应受影响的另一皮肤')] }) }])
  const first = (await h.api(ownerToken, '/api/history/stats')).head
  await commit([{ path: scriptPath, content: '标题：历史第二版\n\n第二版正文\n' }, { path: progressLangPath, content: JSON.stringify({ name: '历史进度第二版', description: '当前服务内容' }) }])
  const second = (await h.api(ownerToken, '/api/history/stats')).head
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1080 } })
    const page = await context.newPage(); pages.push(page)
    page.on('pageerror', error => pageErrors.push(error.message)); page.on('dialog', alert => alert.dismiss())
  }
  const [a, b, v] = pages
  await Promise.all([login(a, editor.credential, '历史窗口 A'), login(b, h.credential, '历史窗口 B'), login(v, viewer.credential, '历史只读窗口')])
  await Promise.all(pages.map(async page => { await page.getByRole('tab', { name: '剧本', exact: true }).click(); await active(page).locator('.monaco-editor .view-lines').first().waitFor() }))
  await Promise.all(pages.map(openHistory))
  for (const page of pages) {
    await until(async () => await dialog(page).getByLabel('较晚版本', { exact: true }).locator(`option[value="${first}"]`).count() === 1, 'First shared version missing')
    await until(async () => await dialog(page).getByLabel('较晚版本', { exact: true }).locator(`option[value="${second}"]`).count() === 1, 'Second shared version missing')
  }
  await selectVersion(b, first)
  await dialog(b).getByLabel('版本名称', { exact: true }).fill('可分享的进度里程碑')
  await dialog(b).getByRole('button', { name: '命名此版本', exact: true }).click()
  await until(async () => (await h.api(ownerToken, '/api/history')).entries.find(value => value.sequence === first)?.label === '可分享的进度里程碑', 'The named version was not persisted')
  await Promise.all([historyRefresh(a), historyRefresh(v)])
  await until(async () => (await dialog(a).innerText()).includes('可分享的进度里程碑') && (await dialog(v).innerText()).includes('可分享的进度里程碑'), 'Named version was not shared between clients')
  const viewerName = dialog(v).getByRole('button', { name: '命名此版本', exact: true })
  assert.ok(!await viewerName.count() || await viewerName.isDisabled())
  const viewerRestore = dialog(v).getByRole('button', { name: /^预览恢复/ })
  for (const button of await viewerRestore.all()) assert.ok(await button.isDisabled())
  passed('三个独立客户端读取同一工程历史和命名版本；审阅主体没有修改历史或恢复的能力')

  await dialog(b).getByLabel('较早版本', { exact: true }).selectOption(String(first))
  await dialog(b).getByLabel('较晚版本', { exact: true }).selectOption(String(second))
  await until(async () => /第一版正文/.test(await dialog(b).innerText()) && /第二版正文/.test(await dialog(b).innerText()), 'Text comparison did not show both historical states')
  await b.screenshot({ path: join(output, 'history-text-comparison.png') })
  passed('历史面板可比较两个已确认版本的文本，命名后仍指向原版本')

  await closeHistory(a)
  await active(a).locator('.monaco-editor .view-lines').first().click()
  await a.keyboard.press('Control+a'); await a.keyboard.type('local draft must survive history restore\n')
  await until(async () => (await editorText(a)).includes('local draft must survive'), 'Draft input did not appear')
  assert.match(await disk(scriptPath), /第二版正文/)
  await selectVersion(b, first)
  await dialog(b).getByRole('button', { name: '预览恢复当前文件', exact: true }).click()
  const restorePlan = dialog(b).getByRole('region', { name: '历史恢复计划', exact: true })
  await restorePlan.waitFor()
  assert.match(await restorePlan.innerText(), /story\.hs/)
  const beforeRestoreCount = (await h.api(ownerToken, '/api/history/stats')).revisions
  proxy.dropNextRestore()
  await dialog(b).getByRole('button', { name: '确认恢复', exact: true }).click()
  await until(async () => /待确认|结果未知|尚未确认/.test(await dialog(b).innerText()), 'Lost success reply did not remain recoverable inside history dialog')
  assert.match(await disk(scriptPath), /第一版正文/)
  const sent = proxy.observed.filter(value => value.changes.some(change => change.op === 'history-restore')).length
  const query = dialog(b).getByRole('button', { name: /查询.*结果|确认.*结果/ })
  await query.click()
  await until(async () => !/待确认|结果未知|尚未确认/.test(await dialog(b).innerText()), 'The original restore receipt was not reconciled')
  assert.equal(proxy.observed.filter(value => value.changes.some(change => change.op === 'history-restore')).length, sent)
  assert.equal((await h.api(ownerToken, '/api/history/stats')).revisions, beforeRestoreCount + 1)
  assert.match(await editorText(a), /local draft must survive history restore/)
  await b.screenshot({ path: join(output, 'history-restored-with-receipt.png') })
  passed('恢复成功但回复丢失在历史面板现场确认原事务；没有重复恢复，另一客户端的未提交草稿保留')

  await historyRefresh(b); await selectVersion(b, second)
  await dialog(b).getByRole('button', { name: '预览恢复当前文件', exact: true }).click()
  await dialog(b).getByRole('region', { name: '历史恢复计划', exact: true }).waitFor()
  await commit([{ path: scriptPath, content: '标题：恢复预览之后的新提交\n\n保留协作者内容\n' }])
  await dialog(b).getByRole('button', { name: '确认恢复', exact: true }).click()
  await until(async () => /冲突|已变化|重新.*预览|重新.*计划/.test(await dialog(b).innerText()), 'Stale restore preview did not report a conflict')
  assert.match(await disk(scriptPath), /保留协作者内容/)
  assert.match(await editorText(a), /local draft must survive history restore/)
  await dialog(b).getByRole('button', { name: '放弃原恢复并重新预览', exact: true }).click()
  await until(async () => await dialog(b).getByRole('button', { name: '确认恢复', exact: true }).isEnabled(), 'Rejected restore could not be replaced with a fresh preview')
  assert.equal(await dialog(b).getByRole('alert').count(), 0, 'Replanning left an obsolete error behind')
  passed('预览恢复之后若协作者继续修改，旧计划被拒绝并保留最新内容及其他窗口草稿')

  await closeHistory(b); await closeHistory(v)
  for (const workspace of ['进度流程', '皮肤管理器']) {
    await b.getByRole('tab', { name: workspace, exact: true }).click()
    await openHistory(b); assert.ok(await dialog(b).isVisible()); await closeHistory(b)
  }
  const indexBeforeSkin = JSON.parse(await disk(skinIndexPath))
  const otherBeforeSkin = indexBeforeSkin.entries.find(entry => entry.entryId === 'history-ui-other')
  await commit([{ op: 'skin-entry-patch', path: skinIndexPath, content: JSON.stringify({ entryId: 'history-ui-skin', expectedRevision: 1, changes: { name: '历史皮肤修改后' } }) }])
  await active(b).locator('.skinWorkspaceCenter').getByRole('button').filter({ has: b.getByText('历史皮肤修改后', { exact: true }) }).first().click()
  await openHistory(b); await selectVersion(b, first)
  await until(async () => await dialog(b).getByLabel('历史皮肤条目', { exact: true }).count() === 1, 'Selected skin did not expose entry-level history restoration')
  assert.equal(await dialog(b).getByLabel('历史皮肤条目', { exact: true }).inputValue(), 'history-ui-skin')
  await dialog(b).getByRole('button', { name: '预览恢复皮肤条目', exact: true }).click()
  await dialog(b).getByRole('region', { name: '历史恢复计划', exact: true }).waitFor()
  await dialog(b).getByRole('button', { name: '确认恢复', exact: true }).click()
  await until(async () => JSON.parse(await disk(skinIndexPath)).entries.find(entry => entry.entryId === 'history-ui-skin').name === '历史皮肤', 'Skin entry was not restored by the visible history controls')
  assert.deepEqual(JSON.parse(await disk(skinIndexPath)).entries.find(entry => entry.entryId === 'history-ui-other'), otherBeforeSkin)
  assert.match(await disk(scriptPath), /保留协作者内容/)
  await until(async () => (await dialog(b).innerText()).includes('已恢复，新的版本已加入工程历史'), 'Skin restore did not settle in the dialog')
  await b.screenshot({ path: join(output, 'history-skin-entry-restored.png') })
  await closeHistory(b)
  passed('皮肤工作区历史自动带入所选条目，明确预览并恢复单条目，不回退另一皮肤及剧本内容')

  await openProgress(b); await openHistory(b)
  await dialog(b).getByRole('button', { name: '当前资源', exact: true }).click()
  assert.equal(await dialog(b).getByLabel('筛选历史文件', { exact: true }).inputValue(), progressPath)
  await until(async () => await dialog(b).getByLabel('较晚版本', { exact: true }).inputValue() === String(second), 'Progress resource filtering lost language-only title history or kept an unrelated selected revision')
  assert.equal(await dialog(b).getByLabel('较早版本', { exact: true }).inputValue(), String(first))
  await dialog(b).getByRole('button', { name: `对比文件 ${progressLangPath}`, exact: true }).click()
  await until(async () => /历史进度第一版/.test(await dialog(b).innerText()) && /历史进度第二版/.test(await dialog(b).innerText()), 'Owned language comparison was not visible in progress history')
  await b.setViewportSize({ width: 900, height: 1000 })
  await b.screenshot({ path: join(output, 'history-progress-narrow.png') })
  const box = await dialog(b).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 901)
  assert.equal(await b.locator('body').evaluate(element => element.scrollWidth > window.innerWidth), false)
  passed('工程历史入口覆盖剧本、进度流程和皮肤；当前资源快捷筛选准确，窄窗口无横向溢出')

  assert.deepEqual(pageErrors, [])
  await writeFile(join(output, 'ui-acceptance.json'), JSON.stringify({ protocol: 10, physicalHosts: 1, isolatedBrowserContexts: 3, tests: results, pageErrors }, null, 2))
  console.log(`工程历史浏览器验收通过：${results.length} 组。`)
} finally { clearInterval(heartbeat); await browser?.close(); await h.stop(); await proxy.close() }
