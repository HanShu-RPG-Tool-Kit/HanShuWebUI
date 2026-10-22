import assert from 'node:assert/strict'
import { harness } from './collaboration-harness.mjs'

// Real HTTP integration for informational focus vs permission and lease authority.
const h = await harness()
const skin = '.hanshu/skinmanager/library.json'
const source = 'src/progress/example.progress'
const script = 'src/hanshu/story.hs'
let count = 0
const passed = name => { count++; console.log(`通过：${name}`) }
try {
  assert.equal((await h.api('', '/health')).protocol, 9)
  const owner = await h.login(h.credential, '管理员')
  const subject = await h.api(owner.token, '/api/subjects', 'POST', { name: '协作者', kind: 'agent', role: 'editor' })
  const a = await h.login(subject.credential, '窗口 A')
  const b = await h.login(subject.credential, '窗口 B')
  const state = token => h.api(token, '/api/project')
  const focus = (token, path, entryId, activity = 'viewing') => h.api(token, '/api/presence', 'POST', { path, entryId, activity })
  const before = await h.files(owner.token)
  await focus(a.token, skin, 'entry_A', 'editing')
  await focus(b.token, skin, 'entry_B', 'editing')
  const shared = await state(owner.token)
  const first = shared.sessions.find(item => item.id === a.session.id).filePresence
  const second = shared.sessions.find(item => item.id === b.session.id).filePresence
  assert.equal(first.entryId, 'entry_A')
  assert.equal(second.entryId, 'entry_B')
  assert.equal(first.authorityId, `file:${skin}`)
  assert.equal(second.authorityId, first.authorityId)
  assert.equal(first.activity, 'editing')
  assert.equal(second.activity, 'editing')
  assert.deepEqual(shared.leases, [])
  assert.deepEqual(await h.files(owner.token), before)
  passed('两个皮肤条目可独立公布编辑意图；不产生锁、不写文件，缺失条目可用于草稿恢复')

  await focus(a.token, script, null, 'editing')
  await focus(b.token, script, null)
  const [lease] = await h.api(b.token, '/api/files/leases', 'POST', { paths: [script] })
  assert.equal((await state(a.token)).session.filePresence.activity, 'editing')
  assert.equal((await state(b.token)).session.filePresence.activity, 'viewing')
  const heartbeat = await h.api(a.token, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] })
  assert.equal(heartbeat.session.filePresence.activity, 'editing')
  await h.api(b.token, '/api/files/leases', 'DELETE', { path: script, leaseId: lease.id })
  assert.equal((await state(a.token)).session.filePresence.activity, 'editing')
  passed('自由编辑器意图经心跳保留，与另一窗口的临时写权独立')

  await focus(a.token, source, null, 'editing')
  assert.equal((await state(a.token)).session.filePresence.activity, 'viewing')
  const [progressLease] = await h.api(a.token, '/api/files/leases', 'POST', { paths: [source] })
  assert.equal((await state(a.token)).session.filePresence.activity, 'editing')
  await h.api(a.token, '/api/files/leases', 'DELETE', { path: source, leaseId: progressLease.id })
  assert.equal((await state(a.token)).session.filePresence.activity, 'viewing')
  passed('受写权管理的进度表单仍由服务端实际写权决定编辑状态')

  await focus(a.token, skin, 'entry_keep', 'editing')
  for (const body of [
    { path: script, entryId: 'entry_keep' },
    { path: null, entryId: 'entry_keep' },
    { path: 'src/../../secret' },
    { path: skin, entryId: '' },
    { path: skin, entryId: 'x'.repeat(257) },
    { path: skin, entryId: 'entry\ninvalid' },
  ]) await h.api(a.token, '/api/presence', 'POST', body, 400)
  await h.api(a.token, '/api/presence', 'POST', { path: skin, activity: 'writing' }, 422)
  await h.api(a.token, '/api/presence', 'POST', { path: skin, unexpected: true }, 422)
  assert.equal((await state(a.token)).session.filePresence.entryId, 'entry_keep')
  passed('非法身份、跨文件条目、路径穿越及未知字段拒绝，保留此前有效焦点')

  await h.api(owner.token, `/api/subjects/${subject.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  assert.equal((await state(a.token)).session.filePresence.activity, 'viewing')
  await focus(a.token, skin, 'entry_keep', 'editing')
  assert.equal((await state(a.token)).session.filePresence.activity, 'viewing')
  await h.api(owner.token, `/api/subjects/${subject.subject.id}`, 'PATCH', { role: 'editor', enabled: true })
  assert.equal((await state(a.token)).session.filePresence.activity, 'viewing')
  await focus(a.token, skin, 'entry_keep', 'editing')
  assert.equal((await state(a.token)).session.filePresence.activity, 'editing')
  await focus(a.token, null, null)
  assert.equal((await state(a.token)).session.filePresence, null)
  assert.equal((await state(b.token)).session.filePresence.path, script)
  await h.api(owner.token, `/api/subjects/${subject.subject.id}`, 'PATCH', { role: 'viewer', enabled: false })
  assert.ok(!(await state(owner.token)).sessions.some(session => session.subjectId === subject.subject.id))
  passed('只读降权收回编辑意图；重新授权不复活旧意图，清理焦点及停用主体正确')
  console.log(`协作状态协议验收通过：${count} 组。`)
} finally { await h.stop() }
