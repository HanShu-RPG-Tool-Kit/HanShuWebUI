import {projectMenu,waitProject} from './project-ui-helpers.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { harness } from './collaboration-harness.mjs'
import { active, openProgress, until, sleep } from './progress-collaboration-helpers.mjs'

const output = resolve('../output/project-sharing')
await mkdir(output, { recursive: true })
const h = await harness({ web: true, localProjects: true })
const results = [], errors = [], sessions = []
const passed = name => { results.push(name); console.log(`通过：${name}`) }
let browser
const panel = page => page.getByRole('dialog', { name: '分享工程', exact: true })
const title = page => active(page).getByLabel('进度标题', { exact: true })
const diskTitle = async () => JSON.parse(await readFile(join(h.root, 'assets/zh_cn/lang_progress/example.lang'), 'utf8')).name
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })))
  const [owner, editor, viewer] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [owner, editor, viewer]) {
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss())
    page.on('response', response => { if (/\/api\/share\/(?:join|resume)$/.test(response.url()) && response.ok()) void response.json().then(value => sessions.push({ page, token: value.token })) })
  }
  await owner.goto(h.base)
  await projectMenu(owner,'打开工程…')
  const form = owner.getByRole('form', { name: '打开工程', exact: true })
  await form.getByRole('button', { name: '打开本机工程…', exact: true }).click()
  const picker = owner.getByRole('region', { name: '选择本机工程目录', exact: true })
  await picker.getByRole('button', { name: '默认工程', exact: true }).click()
  await picker.getByRole('button', { name: '打开此文件夹', exact: true }).click()
  await projectMenu(owner,'分享工程…')
  await until(() => panel(owner).getByRole('switch', { name: '局域网共享' }).isEnabled(), 'Sharing panel not ready')
  await panel(owner).getByRole('switch', { name: '局域网共享' }).click()
  await panel(owner).getByRole('button', { name: '生成邀请链接', exact: true }).waitFor()
  await panel(owner).getByRole('button', { name: '生成邀请链接', exact: true }).click()
  const editorLink = await panel(owner).getByLabel('可编辑邀请链接', { exact: true }).inputValue()
  await panel(owner).getByLabel('邀请权限', { exact: true }).selectOption('viewer')
  await panel(owner).getByRole('button', { name: '生成邀请链接', exact: true }).click()
  const viewerLink = await panel(owner).getByLabel('只读邀请链接', { exact: true }).inputValue()
  assert.equal(new URL(editorLink).origin, new URL(viewerLink).origin)
  passed('本机打开工程后，一键开启共享并生成编辑与只读邀请，无需输入IP端口或凭证')

  async function joinGuest(page, link, name) {
    await page.goto(link)
    const form = page.getByRole('form', { name: '加入共享工程', exact: true })
    await form.getByLabel('显示名', { exact: true }).fill(name)
    await until(() => form.getByRole('button', { name: '加入工程', exact: true }).isEnabled(), 'Invitation not ready')
    await form.getByRole('button', { name: '加入工程', exact: true }).click()
    await waitProject(page,'统一工程验收')
    await until(() => !page.url().includes('#join='), 'Invitation fragment not cleared')
  }
  await joinGuest(editor, editorLink, '远端编辑者')
  await joinGuest(viewer, viewerLink, '远端查看者')
  await editor.getByRole('button',{name:'文件',exact:true}).click();assert.equal(await editor.getByRole('menuitem',{name:'分享工程…',exact:true}).isDisabled(),true);await editor.keyboard.press('Escape');await editor.getByRole('button',{name:'文件',exact:true}).click()
  await until(() => panel(owner).getByText('远端编辑者', { exact: true }).count(), 'Owner did not see guest')
  await owner.screenshot({ path: join(output, 'share-panel.png') })
  await panel(owner).getByRole('button', { name: '完成', exact: true }).click()
  for (const page of [owner, editor, viewer]) await openProgress(page)
  await until(() => title(editor).isEnabled(), 'Editor cannot edit')
  assert.equal(await title(viewer).isDisabled(), true)
  await title(editor).fill('邀请加入后共同编辑'); await title(editor).press('Tab')
  await until(async () => await diskTitle() === '邀请加入后共同编辑', 'Guest changes not on disk')
  await until(async () => await title(owner).inputValue() === '邀请加入后共同编辑' && await title(viewer).inputValue() === '邀请加入后共同编辑', 'Live peer reconciliation failed')
  passed('独立浏览器通过邀请只填显示名即可加入；编辑落盘并同步，本机与只读客户端即时可见')

  const before = await h.api(sessions.find(value => value.page === editor).token, '/api/project')
  await editor.reload()
  await waitProject(editor,'统一工程验收')
  assert.equal(await editor.getByRole('form', { name: '加入共享工程' }).count(), 0)
  await until(() => sessions.filter(value => value.page === editor).length >= 2, 'Refresh did not resume')
  const after = await h.api(sessions.filter(value => value.page === editor).at(-1).token, '/api/project')
  assert.equal(before.session.subjectId, after.session.subjectId)
  const cookies = await contexts[1].cookies(new URL(editorLink).origin)
  assert.equal(cookies.find(cookie => cookie.name.startsWith('hanshu_guest_')).httpOnly, true)
  assert.equal(await editor.evaluate(() => Object.entries(localStorage).some(([key, value]) => /credential|token/.test(key) || value.startsWith('hsk_'))), false)
  await openProgress(editor)
  passed('刷新自动恢复同一Subject，无需再输入姓名，长期凭证不进入URL或浏览器存储')

  await projectMenu(viewer,'关闭工程')
  await viewer.locator('.collab-widget[data-project-name=""]').waitFor()
  await sleep(400)
  assert.equal(await viewer.locator('.collab-widget[data-project-name=""]').count(), 1)
  await viewer.reload()
  await waitProject(viewer,'统一工程验收')
  await openProgress(viewer)
  passed('主动关闭工程不会立即自动重连，再次打开页面可恢复邀请身份')

  await projectMenu(owner,'分享工程…')
  await panel(owner).getByLabel('远端编辑者共享权限', { exact: true }).selectOption('viewer')
  await until(() => title(editor).isDisabled(), 'Role downgrade not reflected in UI')
  const row = panel(owner).locator('.project-share-guests>div').filter({ hasText: '远端编辑者' })
  await row.getByRole('button', { name: '移除', exact: true }).click()
  await row.getByText('已移除', { exact: true }).waitFor()
  await until(() => editor.locator('.collab-widget[data-online="false"]').count(), 'Removed guest did not disconnect')
  passed('分享面板显示独立加入者；降权使表单只读，移除使其断开')

  await until(() => panel(owner).getByRole('switch', { name: '局域网共享' }).isEnabled(), 'Owner sharing operation pending')
  await panel(owner).getByRole('switch', { name: '局域网共享' }).click()
  await until(async () => await panel(owner).getByRole('switch', { name: '局域网共享' }).getAttribute('aria-checked') === 'false', 'Sharing did not stop')
  await panel(owner).getByRole('button', { name: '完成', exact: true }).click()
  await until(() => viewer.locator('.collab-widget[data-online="false"]').count(), 'Sharing stop did not disconnect viewer')
  await title(owner).fill('关闭共享后本机继续工作'); await title(owner).press('Tab')
  await until(async () => await diskTitle() === '关闭共享后本机继续工作', 'Local editing stopped with sharing')
  assert.deepEqual(errors, [])
  passed('关闭共享断开远端，本机继续自动保存，所有页面无未捕获错误')
  await writeFile(join(output, 'ui-acceptance.json'), JSON.stringify({ checks: results.length, results, isolatedBrowserContexts: 3, physicalHosts: 1, pageErrors: errors, firewallChanged: false }, null, 2))
} finally { await browser?.close(); await h.stop() }
