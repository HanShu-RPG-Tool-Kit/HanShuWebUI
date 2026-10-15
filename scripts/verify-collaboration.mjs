import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'hanshu-service-test-'))
const binary = resolve('src-tauri/target/debug', process.platform === 'win32' ? 'project-server.exe' : 'project-server')
const children = []; const sockets = []
let base
async function start() {
  const child = spawn(binary, ['--project', root, '--listen', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.push(child)
  let output = ''; let errors = ''
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Service startup timed out')), 10000)
    child.stdout.on('data', data => { output += data; const match = /HanShu S: (http:\/\/[^\s]+)/.exec(output); if (match) { clearTimeout(timeout); resolve(match[1]) } })
    child.stderr.on('data', data => { errors += data }); child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Service exited ${code}: ${errors}`)) })
  }); return child
}
async function api(token, path, method = 'GET', data, status = 200, origin = undefined) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) })
  const body = await response.json(); assert.equal(response.status, status, `Unexpected status for ${method} ${path}: ${body.code ?? 'unknown'}`); return body
}
async function login(credential, clientName) { return api('', '/api/sessions', 'POST', { credential, clientName }) }
async function watch(token) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/events'); sockets.push(socket)
  const snapshots = []
  socket.addEventListener('message', e => snapshots.push(JSON.parse(e.data).data))
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.send(JSON.stringify({ token }))
  return { snapshots, async until(predicate) { const deadline = Date.now() + 5000; while (!snapshots.some(predicate)) { assert.ok(Date.now() < deadline, 'Missing collaboration broadcast'); await new Promise(r => setTimeout(r, 25)) } } }
}
const source = JSON.stringify({ format: 'hanshu.progress', version: 1, id: 'author-document', name: '原始进度', description: '', authorNotes: '', tags: [], completion: 'all', goals: [], visibility: [], acceptance: [], abandonable: true, repeat: { kind: 'once' }, rewardKits: [] })
try {
  const process1 = await start()
  const credential = await readFile(join(root, 'owner-key'), 'utf8')
  await api('', '/api/project', 'GET', undefined, 401)
  await api('', '/api/sessions', 'POST', { credential: 'wrong', clientName: 'bad' }, 401)
  const owner = await login(credential, 'owner')
  await api(owner.token, '/api/project', 'GET', undefined, 403, 'https://untrusted.example')
  const member = await api(owner.token, '/api/subjects', 'POST', { name: '自动化主体', kind: 'agent', role: 'editor' })
  const viewer = await api(owner.token, '/api/subjects', 'POST', { name: '观察主体', kind: 'account', role: 'viewer' })
  const a = await login(member.credential, '编辑窗口 A'); const b = await login(member.credential, '编辑窗口 B'); const v = await login(viewer.credential, '只读窗口')
  assert.equal(a.session.subjectId, b.session.subjectId); assert.notEqual(a.session.id, b.session.id)
  const observer = await watch(v.token)
  const folder = await api(a.token, '/api/resources', 'POST', { name: '进度', kind: 'folder', parentId: null })
  const doc = await api(a.token, '/api/resources', 'POST', { name: '测试.progress', kind: 'progress', parentId: folder.id, content: source })
  await observer.until(s => s.resources.some(r => r.id === doc.id))
  await api(v.token, `/api/resources/${doc.id}/lease`, 'POST', {}, 403)
  await api(v.token, `/api/resources/${doc.id}`, 'DELETE', { revision: 1 }, 403)
  await api(v.token, '/api/subjects', 'POST', { name: '伪造者', kind: 'agent', role: 'editor' }, 403)
  const lease = await api(a.token, `/api/resources/${doc.id}/lease`, 'POST', {})
  await api(b.token, `/api/resources/${doc.id}/lease`, 'POST', {}, 423)
  await api(b.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: lease.id, revision: 1, content: source }, 423)
  await api(a.token, '/api/heartbeat', 'POST', { resourceId: doc.id, leaseId: lease.id, typing: true })
  await observer.until(s => s.sessions.some(s => s.id === a.session.id && s.activity === 'typing'))
  const updated = JSON.stringify({ ...JSON.parse(source), name: '两个客户端共享的标题' })
  const saved = await api(a.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: lease.id, revision: 1, content: updated })
  assert.equal(saved.revision, 2)
  await observer.until(s => s.resources.some(r => r.id === doc.id && r.revision === 2))
  assert.equal((await api(v.token, `/api/resources/${doc.id}`)).content, updated)
  await api(a.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: lease.id, revision: 1, content: source }, 409)
  await api(a.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: lease.id, revision: 2, content: '{}' }, 400)
  const takeover = await api(owner.token, `/api/resources/${doc.id}/lease`, 'POST', { force: true })
  await api(a.token, `/api/resources/${doc.id}`, 'PUT', { leaseId: lease.id, revision: 2, content: source }, 423)
  await api(owner.token, `/api/resources/${doc.id}/lease`, 'DELETE', { leaseId: takeover.id })
  await api(b.token, `/api/resources/${doc.id}/lease`, 'POST', {})
  await api(owner.token, `/api/subjects/${member.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  assert.equal((await api(owner.token, '/api/project')).leases.length, 0)
  await api(b.token, `/api/resources/${doc.id}/lease`, 'POST', {}, 403)
  await api(owner.token, `/api/subjects/${member.subject.id}`, 'PATCH', { role: 'viewer', enabled: false })
  await api(a.token, '/api/project', 'GET', undefined, 401)
  const snapshot = await api(owner.token, '/api/project')
  assert.ok(!JSON.stringify(snapshot).includes(credential)); assert.ok(!('content' in snapshot.resources[0]))
  sockets.forEach(s => s.close()); process1.kill(); await new Promise(r => process1.once('exit', r))
  await start()
  await api(owner.token, '/api/project', 'GET', undefined, 401)
  const restored = await login(credential, '重启后管理者')
  assert.equal((await api(restored.token, `/api/resources/${doc.id}`)).content, updated)
  assert.equal((await api(restored.token, '/api/project')).leases.length, 0)
  console.log('协作服务集成验证通过：主体/会话隔离、权限、在线状态、广播、写权接管、版本冲突与重启持久化。')
} finally {
  sockets.forEach(s => s.close()); children.forEach(c => { if (c.exitCode === null) c.kill() })
}
