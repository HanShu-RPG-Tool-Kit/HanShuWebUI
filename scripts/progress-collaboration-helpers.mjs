import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { progress } from './collaboration-harness.mjs'

export const progressPath = 'src/progress/example.progress'
export const languagePath = 'assets/zh_cn/lang_progress/example.lang'
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < deadline, label); await sleep(75) }
}
export const diskJson = async (h, path) => JSON.parse(await readFile(join(h.root, path), 'utf8'))
export const fixtureProgress = () => ({
  ...structuredClone(progress),
  goals: [{ id: 'goal-counter', kind: 'acceptance:counter', config: { target: 10, bonus: 3 } }],
})
export const goalDefinition = `@goal("acceptance:counter")
@config(
    field("target", "int", default=10, label="目标数量"),
    field("bonus", "int", default=3, label="额外数量")
)
class AcceptanceCounterGoal(BaseGoalPy):
    pass
`
export async function seedProgress(h, token) {
  try {
    const receipt = await h.commit(token, [
      { path: progressPath, content: JSON.stringify(fixtureProgress()) },
      { path: 'src/goal/acceptance_counter.py', content: goalDefinition },
    ])
    assert.equal(receipt.status, 'committed')
  } finally { await h.release(token) }
}

// Real HTTP/WebSocket forwarding with faults at explicit transport boundaries.
// Holding a response happens only after S has committed; holding a request
// creates a legitimate stale-client race without inventing server results.
export async function progressProxy() {
  const sockets = new Set(), observed = [], receipts = []
  let upstream = '', nextFault = null, held = null, pendingRelease = null
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    let commit = null
    try { if (req.url === '/api/files/commit') commit = JSON.parse(body.toString()) } catch { /* Forward invalid requests unchanged. */ }
    if (commit) observed.push(commit)
    const semantic = commit?.changes.some(change => change.op.startsWith('progress-'))
    const fault = semantic ? nextFault : null
    if (fault) nextFault = null
    if (fault === 'before') {
      held = commit
      await new Promise(resolve => { pendingRelease = resolve })
      held = null; pendingRelease = null
    }
    const target = new URL(req.url, upstream)
    const outgoing = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, async response => {
      const chunks = []; for await (const chunk of response) chunks.push(chunk)
      const content = Buffer.concat(chunks)
      let receipt = null
      try { receipt = JSON.parse(content) } catch { /* Forward raw response. */ }
      if (commit) receipts.push({ request: commit, receipt })
      if (fault === 'after') {
        held = commit
        await new Promise(resolve => { pendingRelease = resolve })
        held = null; pendingRelease = null
      }
      if (fault === 'drop' && receipt?.status === 'committed') {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': content.length })
        res.write(content.subarray(0, Math.max(1, Math.floor(content.length / 2))))
        setTimeout(() => res.destroy(), 20)
      } else { res.writeHead(response.statusCode, response.headers); res.end(content) }
    })
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('{"code":"unavailable","message":"Test proxy upstream unavailable"}') })
    outgoing.end(body)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(upstream)
    const remote = connect(Number(target.port), target.hostname, () => {
      remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
      for (const [key, value] of Object.entries(req.headers)) remote.write(`${key}: ${key === 'host' ? target.host : value}\r\n`)
      remote.write('\r\n'); if (head.length) remote.write(head)
      socket.pipe(remote); remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    base: `http://127.0.0.1:${server.address().port}`, observed, receipts,
    setUpstream(value) { upstream = value },
    holdNextRequest() { assert.equal(nextFault, null); nextFault = 'before' },
    holdNextResponse() { assert.equal(nextFault, null); nextFault = 'after' },
    dropNextResponse() { assert.equal(nextFault, null); nextFault = 'drop' },
    get held() { return held },
    release() { pendingRelease?.() },
    async close() { pendingRelease?.(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

export const active = page => page.locator('.app-workspace-pane.active')
export async function login(page, base, credential, name, navigate = true) {
  if (navigate) await page.goto(base)
  await page.getByRole('button', { name: '打开工程…', exact: true }).click()
  const form = page.getByRole('form', { name: '打开工程', exact: true })
  await form.getByLabel('服务地址', { exact: true }).fill(base)
  await form.getByLabel('主体凭证', { exact: true }).fill(credential)
  await form.getByLabel('本端名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '连接并打开工程', exact: true }).click()
  await page.locator('.project-service-bar').getByText('统一工程验收', { exact: true }).waitFor()
}
export async function openProgress(page) {
  await page.getByRole('tab', { name: '进度流程', exact: true }).click()
  await active(page).getByLabel('筛选资源', { exact: true }).fill('example.progress')
  await active(page).locator('[role=treeitem][title="example.progress"]').click()
  await active(page).getByLabel('进度标题', { exact: true }).waitFor()
}
