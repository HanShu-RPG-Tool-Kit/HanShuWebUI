import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'hanshu-ui-test-'))
const binary = resolve('src-tauri/target/debug', process.platform === 'win32' ? 'project-server.exe' : 'project-server')
let service; let browser; let base
async function start(port = 0) {
  service = spawn(binary, ['--project', root, '--listen', `127.0.0.1:${port}`, '--web-root', resolve('dist')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let text = ''; let stderr = ''
  base = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Service startup timed out')), 10000)
    service.stdout.on('data', chunk => { text += chunk; const match = /HanShu S: (http:\/\/[^\s]+)/.exec(text); if (match) { clearTimeout(timeout); resolve(match[1]) } }); service.stderr.on('data', chunk => { stderr += chunk }); service.on('error', reject); service.on('exit', code => { clearTimeout(timeout); reject(new Error(`Service exited: ${code} ${stderr}`)) })
  })
}
async function stop() { if (service.exitCode !== null) return; service.kill(); await new Promise(resolve => service.once('exit', resolve)) }
async function api(token, path, method = 'GET', data) { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) }); assert.ok(r.ok, `API failed: ${method} ${path}`); return r.json() }
async function until(condition, label) { const deadline = Date.now() + 10000; while (!await condition()) { assert.ok(Date.now() < deadline, label); await new Promise(r => setTimeout(r, 50)) } }
async function login(page, key, name, navigate = true) {
  if (navigate) { await page.goto(base); await page.getByRole('tab', { name: '进度流程', exact: true }).click(); await page.getByRole('button', { name: '共享工程', exact: true }).click() }
  const workspace = page.getByRole('region', { name: '共享工程', exact: true })
  await workspace.getByLabel('服务地址', { exact: true }).fill(base)
  await workspace.getByLabel('主体凭证', { exact: true }).fill(key)
  await workspace.getByLabel('本端名称', { exact: true }).fill(name)
  await workspace.getByRole('button', { name: '以此凭证连接', exact: true }).click()
  await workspace.getByText('● 已连接', { exact: true }).waitFor()
  await workspace.getByRole('button', { name: '◇ 协作验证.progress', exact: true }).click()
  await workspace.getByLabel('进度标题', { exact: true }).waitFor()
  return workspace
}
const source = JSON.stringify({ format: 'hanshu.progress', version: 1, id: 'ui-test', name: '协作验证', description: '用于验证两个客户端的写权与草稿恢复。', authorNotes: '', tags: [], completion: 'all', goals: [], visibility: [], acceptance: [], abandonable: true, repeat: { kind: 'once' }, rewardKits: [] })
try {
  await start()
  const key = await readFile(join(root, 'owner-key'), 'utf8')
  const owner = await api('', '/api/sessions', 'POST', { credential: key, clientName: 'test setup' })
  const editor = await api(owner.token, '/api/subjects', 'POST', { name: '创作主体', kind: 'account', role: 'editor' })
  const viewer = await api(owner.token, '/api/subjects', 'POST', { name: '旁观机器人', kind: 'agent', role: 'viewer' })
  const doc = await api(owner.token, '/api/resources', 'POST', { parentId: null, name: '协作验证.progress', kind: 'progress', content: source })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const pages = await Promise.all(['A', 'B', 'V'].map(async () => { const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); return context.newPage() }))
  const errors = []; pages.forEach(page => page.on('pageerror', error => errors.push(error.message)))
  const [a, b, v] = await Promise.all([login(pages[0], editor.credential, '窗口 A'), login(pages[1], editor.credential, '窗口 B'), login(pages[2], viewer.credential, '旁观端')])
  assert.ok(await v.getByLabel('进度标题', { exact: true }).isDisabled())
  assert.ok(await v.getByRole('button', { name: '申请写权', exact: true }).isDisabled())
  await a.getByRole('button', { name: '申请写权', exact: true }).click()
  await until(() => a.getByLabel('进度标题', { exact: true }).isEnabled(), 'A did not acquire write access')
  await until(() => b.getByRole('button', { name: '申请写权', exact: true }).isDisabled(), 'B could still acquire occupied document')
  await a.getByLabel('进度标题', { exact: true }).fill('第一份共同进度')
  await a.getByRole('button', { name: '保存', exact: true }).click()
  await until(async () => await b.getByLabel('进度标题', { exact: true }).inputValue() === '第一份共同进度', 'Reader did not receive the saved title')
  await a.getByRole('button', { name: '释放写权', exact: true }).click()
  await until(() => b.getByRole('button', { name: '申请写权', exact: true }).isEnabled(), 'B cannot take released access')
  await b.getByRole('button', { name: '申请写权', exact: true }).click()
  await until(() => b.getByLabel('进度标题', { exact: true }).isEnabled(), 'B did not acquire released access')
  await b.getByLabel('进度标题', { exact: true }).fill('断线后仍保留的本地草稿')
  const takeover = await api(owner.token, `/api/resources/${doc.id}/lease`, 'POST', { force: true })
  await until(() => b.getByLabel('进度标题', { exact: true }).isDisabled(), 'Takeover did not disable the old editor')
  assert.equal(await b.getByLabel('进度标题', { exact: true }).inputValue(), '断线后仍保留的本地草稿')
  await api(owner.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: takeover.id, revision: 2, content: JSON.stringify({ ...JSON.parse(source), name: '服务端最新版' }) })
  await b.getByText('远端已有新版本，本窗口草稿保留。可先下载草稿，再读取最新版。', { exact: true }).waitFor()
  const output = resolve('../output/collaboration-v1'); await mkdir(output, { recursive: true })
  await pages[1].screenshot({ path: join(output, 'shared-progress.png'), fullPage: false })
  const port = Number(new URL(base).port); await stop()
  await until(() => b.getByLabel('进度标题', { exact: true }).isDisabled(), 'Disconnected client is editable')
  assert.equal(await b.getByLabel('进度标题', { exact: true }).inputValue(), '断线后仍保留的本地草稿')
  await start(port)
  await login(pages[1], editor.credential, '重新连接的窗口 B', false)
  assert.equal(await b.getByLabel('进度标题', { exact: true }).inputValue(), '断线后仍保留的本地草稿')
  assert.ok(await b.getByRole('button', { name: '保存', exact: true }).isDisabled())
  assert.deepEqual(errors, [])
  console.log('浏览器验收通过：三个隔离客户端、只读表单、写权交接、保存广播、接管及断线重启后的草稿保留。')
} finally { if (browser) await browser.close(); if (service) await stop() }
