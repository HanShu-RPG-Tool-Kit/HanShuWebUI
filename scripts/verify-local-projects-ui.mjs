import {projectMenu,waitProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, access, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { active, openProgress, until } from './progress-collaboration-helpers.mjs'

const output = resolve('../output/local-project-opening')
await mkdir(output, { recursive: true })
const workspace = await mkdtemp(join(output, 'ui-'))
const alpha = join(workspace, '工程甲'), beta = join(workspace, '工程乙'), cancelled = join(workspace, '未打开工程'), removed = join(workspace, '将被删除')
for (const directory of [alpha, beta, cancelled, removed]) await mkdir(directory)
const h = await harness({ root: join(workspace, 'default'), web: true, localProjects: true })
for (const [path, content] of Object.entries(h.fixtures)) {
  await mkdir(join(alpha, path, '..'), { recursive: true })
  await writeFile(join(alpha, path), path === 'project.json' ? JSON.stringify({ version: 1, id: 'alpha-editor', name: '工程甲' }) : content)
}
let browser, heldRoute, releaseRoute
const pages = [], errors = [], opened = [], results = []
const passed = name => { results.push(name); console.log(`通过：${name}`) }
const form = page => page.getByRole('form', { name: '打开工程', exact: true })
const picker = page => page.getByRole('region', { name: '选择本机工程目录', exact: true })
async function pick(page, name, navigate = false) {
  if (navigate) await page.goto(h.base)
  await projectMenu(page,'打开工程…')
  await form(page).getByRole('button', { name: '打开本机工程…', exact: true }).click()
  await picker(page).getByRole('button', { name: '工程所在目录', exact: true }).click()
  await picker(page).getByRole('option', { name, exact: true }).click()
}
async function open(page, name, navigate = false) {
  await pick(page, name, navigate)
  await picker(page).getByRole('button', { name: '打开此文件夹', exact: true }).click()
  await waitProject(page,name)
}
async function value(path) { return JSON.parse(await readFile(join(alpha, path), 'utf8')) }
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(() => {
    window.__directProjectIo = 0
    Object.defineProperty(window, 'showDirectoryPicker', { value: () => { window.__directProjectIo++; throw new Error('C cannot open a writable OS directory') } })
  })
  const a = await context.newPage(), b = await context.newPage(); pages.push(a, b)
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.dismiss())
    page.on('response', response => { if (response.url().endsWith('/api/local/open') && response.ok()) void response.json().then(value => opened.push(value)) })
  }

  await pick(a, '未打开工程', true)
  await a.screenshot({ path: join(output, 'local-folder-picker.png') })
  await picker(a).getByRole('button', { name: '返回', exact: true }).click()
  await form(a).getByRole('button', { name: '取消', exact: true }).click()
  await assert.rejects(access(join(cancelled, '.hanshu')))
  assert.equal(opened.length, 0)
  passed('Web提供本机目录选择，浏览并取消不创建工程或连接')

  await open(a, '工程甲')
  await until(() => opened.length === 1, 'Local opening did not return a connection')
  const alphaConnection = opened[0]
  await openProgress(a)
  const title = active(a).getByLabel('进度标题', { exact: true })
  await until(() => title.isEnabled(), 'Local progress form not ready')
  await title.fill('在本机目录中自动保存'); await title.press('Tab')
  await until(async () => (await value('assets/zh_cn/lang_progress/example.lang')).name === '在本机目录中自动保存', 'Progress did not save to selected local directory')
  assert.equal(JSON.parse(await readFile(join(h.root, 'assets/zh_cn/lang_progress/example.lang'), 'utf8')).name, '共同进度')
  passed('无需填写地址或凭证即可打开已有工程，进度操作通过S落盘到所选目录')

  await open(b, '工程甲', true)
  await until(() => opened.length === 2, 'Second client did not open same local project')
  assert.equal(opened[1].url, alphaConnection.url)
  await openProgress(b)
  await until(async () => await active(b).getByLabel('进度标题', { exact: true }).inputValue() === '在本机目录中自动保存', 'Second local window did not read shared project')
  await open(a, '工程乙')
  assert.equal(JSON.parse(await readFile(join(beta, 'project.json'), 'utf8')).name, '工程乙')
  await until(() => active(b).getByLabel('进度标题', { exact: true }).isEnabled(), 'Switching one window stopped peer project service')
  await active(b).getByLabel('进度标题', { exact: true }).fill('另一窗口继续编辑工程甲')
  await active(b).getByLabel('进度标题', { exact: true }).press('Tab')
  await until(async () => (await value('assets/zh_cn/lang_progress/example.lang')).name === '另一窗口继续编辑工程甲', 'Peer lost write access after another client switched')
  passed('空目录初始化为新工程，同一目录复用S，切换不影响原工程协作者')

  await open(a, '工程甲')
  assert.equal(opened.at(-1).url, alphaConnection.url)
  await a.reload()
  await open(a, '工程甲')
  await openProgress(a)
  await until(() => active(a).getByLabel('进度标题', { exact: true }).isEnabled(), 'Reopened form not ready')
  assert.equal(await active(a).getByLabel('进度标题', { exact: true }).inputValue(), '另一窗口继续编辑工程甲')
  passed('重新打开和刷新后仍能自动连接既有S并读取保存结果')

  let holding = true
  await a.route('**/api/files/commit', async route => {
    if (holding) { holding = false; heldRoute = route; await new Promise(resolve => { releaseRoute = resolve }); heldRoute = null }
    await route.continue()
  })
  await active(a).getByLabel('进度标题', { exact: true }).fill('在途操作完成后再切换')
  await active(a).getByLabel('进度标题', { exact: true }).press('Tab')
  await until(() => heldRoute, 'No autosubmit in flight')
  const beforeSwitch = opened.length
  await pick(a, '工程乙')
  await picker(a).getByRole('button', { name: '打开此文件夹', exact: true }).click()
  await form(a).getByRole('alert').filter({ hasText: '请等待当前保存结束' }).waitFor()
  assert.equal(opened.length, beforeSwitch)
  releaseRoute()
  await until(async () => (await value('assets/zh_cn/lang_progress/example.lang')).name === '在途操作完成后再切换', 'Queued local edit was lost during attempted switch')
  await a.unroute('**/api/files/commit')
  await picker(a).getByRole('button', { name: '返回', exact: true }).click()
  await form(a).getByRole('button', { name: '取消', exact: true }).click()
  passed('有在途提交时阻止工程切换，原输入和请求完成后仍可保存')

  await pick(a, '将被删除')
  await rmdir(removed)
  await picker(a).getByRole('button', { name: '打开此文件夹', exact: true }).click()
  await form(a).getByRole('alert').filter({ hasText: '目录已不存在' }).waitFor()
  await picker(a).getByRole('button', { name: '返回', exact: true }).click()
  await form(a).getByRole('button', { name: '取消', exact: true }).click()
  await waitProject(a,'工程甲')
  assert.equal(await active(a).getByLabel('进度标题', { exact: true }).inputValue(), '在途操作完成后再切换')
  passed('打开失效目录显示错误并保留当前工程')

  for (const page of pages) assert.equal(await page.evaluate(() => window.__directProjectIo), 0)
  assert.deepEqual(errors, [])
  await a.screenshot({ path: join(output, 'opened-local-project.png') })
  await a.setViewportSize({ width: 700, height: 800 })
  await pick(a, '工程乙')
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
  await a.screenshot({ path: join(output, 'local-folder-picker-narrow.png') })
  passed('本机目录工程保持C无直接写盘能力，窄窗口可用且无页面异常')
  await writeFile(join(output, 'ui-acceptance.json'), JSON.stringify({ checks: results.length, results, workspace, physicalHosts: 1, browserPages: pages.length, directClientWrites: 0, pageErrors: errors }, null, 2))
  console.log(`本机工程浏览器验收 ${results.length} 组通过。`)
} catch (error) {
  for (let index = 0; index < pages.length; index++) await pages[index].screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => undefined)
  throw error
} finally { releaseRoute?.(); await browser?.close(); await h.stop() }
