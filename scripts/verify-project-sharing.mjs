import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'

const output = resolve('../output/project-sharing')
await mkdir(output, { recursive: true })
const h = await harness({ web: true, localProjects: true })
const results = []
const passed = name => { results.push(name); console.log(`通过：${name}`) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let lan, socket
async function api(base, token, path, method = 'GET', body, status = 200, cookie) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...token ? { Authorization: `Bearer ${token}` } : {}, ...cookie ? { Cookie: cookie } : {} }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const value = await response.json().catch(() => null)
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`)
  return { ...value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
const invitation = url => new URLSearchParams(new URL(url).hash.slice(1)).get('join')
try {
  const owner = await h.login(h.credential, '本机管理者')
  await h.api('', '/api/share/enable', 'POST', undefined, 401)
  const initial = await h.api(owner.token, '/api/share/enable', 'POST')
  assert.equal(initial.active, true); lan = initial.urls[0]
  assert.ok(!new URL(lan).hostname.startsWith('127.'))
  assert.equal((await fetch(lan)).status, 200)
  assert.deepEqual(await api(lan, '', '/api/share/info'), { active: true, service: 'hanshu-project-share', cookie: undefined })
  assert.equal((await fetch(lan + '/api/local/bootstrap')).status, 404)
  assert.equal((await fetch(lan + '/.hanshu/service/owner-key')).status, 404)
  assert.equal((await fetch(lan + '/api/share/firewall', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` } })).status, 403)
  const deniedOrigin = await fetch(lan + '/api/share/info', { headers: { Origin: 'https://untrusted.example' } }); assert.equal(deniedOrigin.status, 403)
  passed('自动选择真实LAN入口，完整网页可用，目录与凭证不外露，远程不能请求防火墙授权')

  const editorInvite = await h.api(owner.token, '/api/share/invitations', 'POST', { role: 'editor', ttlSeconds: 3600 })
  assert.equal(new URL(editorInvite.url).search, ''); assert.equal(invitation(editorInvite.url).length, 64)
  const a = await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(editorInvite.url), name: '编辑者甲' })
  const b = await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(editorInvite.url), name: '编辑者乙' })
  assert.deepEqual(Object.keys(a).sort(), ['cookie', 'token'])
  const sa = await api(lan, a.token, '/api/project'), sb = await api(lan, b.token, '/api/project')
  assert.notEqual(sa.session.subjectId, sb.session.subjectId); assert.equal(sa.role, 'editor')
  for (const path of ['/api/share/status', '/api/share/enable', '/api/share/invitations', '/api/share/firewall']) {
    await api(lan, a.token, path, path.endsWith('status') ? 'GET' : 'POST', path.endsWith('invitations') ? { role: 'editor', ttlSeconds: 60 } : undefined, 403)
  }
  await h.commit(a.token, [{ path: 'src/script/example.py', content: 'print("LAN editor")\n' }]); await h.release(a.token)
  assert.equal(await readFile(join(h.root, 'src/script/example.py'), 'utf8'), 'print("LAN editor")\n')
  assert.equal((await api(lan, b.token, '/api/files')).revision, (await h.files(owner.token)).revision)
  passed('邀请生成独立Subject，只返回短会话；LAN与本机复用同一Engine，编辑真实落盘且权限由S校验')

  const viewerInvite = await h.api(owner.token, '/api/share/invitations', 'POST', { role: 'viewer', ttlSeconds: 3600 })
  const viewer = await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(viewerInvite.url), name: '查看者' })
  await api(lan, viewer.token, '/api/files/leases', 'POST', { paths: ['src/script/example.py'] }, 403)
  await h.api(owner.token, `/api/subjects/${sa.session.subjectId}`, 'PATCH', { role: 'viewer', enabled: true })
  const resumed = await api(lan, '', '/api/share/resume', 'POST', undefined, 200, a.cookie)
  const resumedState = await api(lan, resumed.token, '/api/project')
  assert.equal(resumedState.session.subjectId, sa.session.subjectId); assert.equal(resumedState.role, 'viewer')
  await api(lan, resumed.token, '/api/files/leases', 'POST', { paths: ['src/script/example.py'] }, 403)
  passed('只读不能写，降权立即生效；Cookie恢复沿用原Subject且不提升权限')

  const expired = await h.api(owner.token, '/api/share/invitations', 'POST', { role: 'editor', ttlSeconds: 1 })
  await sleep(1150)
  await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(expired.url), name: '过期邀请' }, 403)
  await h.api(owner.token, `/api/share/invitations/${viewerInvite.id}`, 'DELETE')
  await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(viewerInvite.url), name: '撤销邀请' }, 403)
  assert.equal((await api(lan, viewer.token, '/api/project')).role, 'viewer')
  passed('邀请到期和撤销阻止新加入，已加入会话按独立权限继续工作')

  await api(lan, b.token, '/api/files/leases', 'POST', { paths: ['src/script/example.py'] })
  await h.api(owner.token, `/api/share/guests/${sb.session.subjectId}/remove`, 'POST')
  await h.api(b.token, '/api/project', 'GET', undefined, 401)
  await api(lan, '', '/api/share/resume', 'POST', undefined, 401, b.cookie)
  await api(lan, '', '/api/share/join', 'POST', { invitation: invitation(editorInvite.url), name: '被移除后重入' }, 403, b.cookie)
  assert.equal((await h.api(owner.token, '/api/project')).leases.length, 0)
  passed('移除立即注销加入者所有会话并释放租约，原Cookie不能恢复')

  let closed = false
  socket = new WebSocket(lan.replace('http:', 'ws:') + '/api/events')
  socket.addEventListener('close', () => { closed = true })
  await new Promise((resolve, reject) => { socket.addEventListener('open', () => socket.send(JSON.stringify({ token: viewer.token }))); socket.addEventListener('message', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await h.api(owner.token, '/api/share/disable', 'POST')
  await h.api(a.token, '/api/project', 'GET', undefined, 401)
  await h.api(resumed.token, '/api/project', 'GET', undefined, 401)
  await h.api(viewer.token, '/api/project', 'GET', undefined, 401)
  for (let i = 0; i < 30 && !closed; i++) await sleep(100)
  assert.equal(closed, true)
  await h.commit(owner.token, [{ path: 'src/script/example.py', content: 'print("local continues")\n' }]); await h.release(owner.token)
  const reopened = await h.api(owner.token, '/api/share/enable', 'POST')
  assert.equal(reopened.invitations.length, 0); assert.equal(reopened.guests.length, 0)
  await api(reopened.urls[0], '', '/api/share/join', 'POST', { invitation: invitation(editorInvite.url), name: '旧链接' }, 403)
  await api(reopened.urls[0], '', '/api/share/resume', 'POST', undefined, 401, a.cookie)
  passed('关闭共享断开LAN与全部加入会话，本机仍可写；重新开启不会复活旧邀请和身份')
  await h.api(owner.token, '/api/share/disable', 'POST')
  await writeFile(join(output, 'http-acceptance.json'), JSON.stringify({ checks: results.length, results, physicalHosts: 1, realLanAddress: new URL(lan).hostname, firewallChanged: false }, null, 2))
} finally { socket?.close(); await h.stop() }
