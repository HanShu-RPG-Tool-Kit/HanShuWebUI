import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness } from './collaboration-harness.mjs'
import { diskJson, fixtureProgress, languagePath, progressPath, seedProgress } from './progress-collaboration-helpers.mjs'

// Real HTTP clients against the authoritative Rust process. Every assertion
// checks persisted content/receipt/history, never an in-memory UI substitute.
const h = await harness(), results = [], tokens = []
const output = resolve('../output/progress-collaboration')
const heartbeat = setInterval(() => { for (const token of tokens) void h.api(token, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined) }, 8000)
const passed = name => { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
const present = value => ({ present: true, value })
const absent = () => ({ present: false, value: null })
const effect = (target, expected, value) => ({ target, expected, value })
const field = (name, before, after) => effect({ kind: 'field', field: name }, present(before), present(after))
const config = (key, before, after, goalKind = 'acceptance:counter') => effect({ kind: 'goal-config', goalId: 'goal-counter', goalKind, key }, before, after)
const locale = (key, before, after, language = 'zh_cn') => effect({ kind: 'locale', locale: language, key }, before, after)
const apply = changes => ({ command: 'apply', documentId: fixtureProgress().id, changes })
const request = command => ({ transactionId: randomUUID(), changes: [{ op: 'progress-command', path: progressPath, version: null, leaseId: '', destination: null, destinationVersion: null, content: Buffer.from(JSON.stringify(command)).toString('base64') }] })
async function send(token, command, status = 'committed', code) {
  const input = request(command), receipt = await h.api(token, '/api/files/commit', 'POST', input)
  assert.equal(receipt.status, status, JSON.stringify(receipt.error))
  if (code) assert.equal(receipt.error?.code, code)
  return { input, receipt }
}
const source = () => diskJson(h, progressPath)
const language = () => diskJson(h, languagePath)
const history = token => h.api(token, '/api/history/stats')
async function noLeases(token) { assert.equal((await h.api(token, '/api/project')).leases.length, 0, 'A semantic command retained a file lease') }
try {
  assert.equal((await h.api('', '/health')).protocol, 11)
  const owner = await h.login(h.credential, 'progress setup')
  const editorA = await h.api(owner.token, '/api/subjects', 'POST', { name: '进度作者 A', kind: 'account', role: 'editor' })
  const editorB = await h.api(owner.token, '/api/subjects', 'POST', { name: '进度作者 B', kind: 'account', role: 'editor' })
  const reader = await h.api(owner.token, '/api/subjects', 'POST', { name: '进度只读主体', kind: 'agent', role: 'viewer' })
  const a = await h.login(editorA.credential, 'API A'), b = await h.login(editorB.credential, 'API B'), v = await h.login(reader.credential, 'API viewer')
  tokens.push(owner.token, a.token, b.token, v.token)
  await seedProgress(h, owner.token)

  const [first, second] = await Promise.all([
    send(a.token, apply([config('target', present(10), present(20))])),
    send(b.token, apply([config('bonus', present(3), present(7))])),
  ])
  assert.deepEqual((await source()).goals[0].config, { target: 20, bonus: 7 })
  assert.equal(first.receipt.progressResult.path, progressPath)
  assert.equal(first.receipt.progressResult.documentId, fixtureProgress().id)
  assert.equal(first.receipt.progressResult.effects.length, 1)
  assert.equal(JSON.parse(second.receipt.progressResult.source).goals[0].config.bonus, 7)
  await noLeases(owner.token)
  passed('同一源文件两个旧基准客户端并行修改不同目标参数均成功，精确回执完整且提交后不占写权')

  const beforeRejected = await history(owner.token)
  await send(a.token, apply([config('target', present(10), present(99))]), 'rejected', 'conflict')
  await send(a.token, apply([config('bonus', present(7), present(8), 'wrong:kind')]), 'rejected', 'conflict')
  assert.deepEqual((await source()).goals[0].config, { target: 20, bonus: 7 })
  assert.equal((await history(owner.token)).revisions, beforeRejected.revisions)
  await noLeases(owner.token)
  passed('同参数旧值及已更换目标类型的旧命令拒绝，不覆盖新内容也不制造历史版本')

  const beforeAtomic = await history(owner.token)
  const atomic = await send(a.token, apply([
    field('completion', 'all', 'any'),
    locale('name', present('共同进度'), present('原子更新后的名称')),
  ]))
  assert.equal((await source()).completion, 'any')
  assert.equal((await language()).name, '原子更新后的名称')
  assert.deepEqual(atomic.receipt.progressResult.languages.map(value => value.path), [languagePath])
  assert.equal((await history(owner.token)).revisions, beforeAtomic.revisions + 1)
  const atomicHistory = (await h.api(owner.token, '/api/history')).entries.find(entry => entry.transactionId === atomic.input.transactionId)
  assert.deepEqual(atomicHistory.changes.map(value => value.path).sort(), [languagePath, progressPath].sort())
  await send(b.token, apply([
    field('completion', 'any', 'all'),
    locale('name', present('共同进度'), present('不得部分提交')),
  ]), 'rejected', 'conflict')
  assert.equal((await source()).completion, 'any')
  assert.equal((await language()).name, '原子更新后的名称')
  await noLeases(owner.token)
  passed('标题语言和源字段共用一笔原子事务及一个历史版本，任何字段冲突时整批保留原状')

  const beforeReplay = await history(owner.token)
  const receiptAgain = await h.api(a.token, '/api/files/commit', 'POST', atomic.input)
  const receiptQuery = await h.api(a.token, `/api/files/transactions/${atomic.input.transactionId}`)
  assert.deepEqual(receiptAgain, atomic.receipt)
  assert.deepEqual(receiptQuery, atomic.receipt)
  assert.equal((await history(owner.token)).revisions, beforeReplay.revisions)
  passed('同事务重发和查询返回原始精确回执，不重复应用或增加历史')

  const undoOwn = await send(a.token, { command: 'revert', transactionId: first.input.transactionId })
  assert.deepEqual((await source()).goals[0].config, { target: 10, bonus: 7 })
  const redoOwn = await send(a.token, { command: 'revert', transactionId: undoOwn.input.transactionId })
  assert.deepEqual((await source()).goals[0].config, { target: 20, bonus: 7 })
  assert.equal(redoOwn.receipt.progressResult.effects.length, 1)
  await send(b.token, { command: 'revert', transactionId: first.input.transactionId }, 'rejected', 'forbidden')
  await noLeases(owner.token)
  passed('撤销及重做只反转本主体已提交的字段，保留另一作者的不同参数并拒绝撤销他人事务')

  await send(b.token, apply([config('target', present(20), present(25))]))
  const beforeUndoConflict = await history(owner.token)
  await send(a.token, { command: 'revert', transactionId: redoOwn.input.transactionId }, 'rejected', 'conflict')
  assert.deepEqual((await source()).goals[0].config, { target: 25, bonus: 7 })
  assert.equal((await history(owner.token)).revisions, beforeUndoConflict.revisions)
  passed('他人修改同一字段后旧撤销被拒绝，既不回退他人内容也不新增历史')

  const beforeNoop = await history(owner.token)
  const noop = await send(a.token, apply([field('completion', 'any', 'any')]))
  assert.equal(noop.receipt.progressResult.effects.length, 0)
  assert.equal((await history(owner.token)).revisions, beforeNoop.revisions)
  await send(a.token, apply([config('target', present(25), absent())]))
  assert.ok(!Object.hasOwn((await source()).goals[0].config, 'target'))
  await send(b.token, apply([config('target', absent(), present(10))]))
  assert.equal((await source()).goals[0].config.target, 10)
  passed('无效变化不制造历史；恢复默认删除参数覆盖，显式填写默认值仍作为覆盖保存')

  const addGoal = { id: 'goal-added', kind: 'acceptance:counter', config: {} }
  const inserted = await send(a.token, apply([
    effect({ kind: 'goal', goalId: addGoal.id }, absent(), present(addGoal)),
    effect({ kind: 'goal-order' }, present(['goal-counter']), present(['goal-added', 'goal-counter'])),
  ]))
  assert.deepEqual((await source()).goals.map(goal => goal.id), ['goal-added', 'goal-counter'])
  await send(b.token, apply([config('bonus', present(7), present(8))]))
  await send(a.token, { command: 'revert', transactionId: inserted.input.transactionId })
  assert.deepEqual((await source()).goals.map(goal => goal.id), ['goal-counter'])
  assert.equal((await source()).goals[0].config.bonus, 8)
  passed('目标插入和顺序作为结构事务提交，撤销结构修改仍保留其他目标的参数更新')

  await h.api(owner.token, '/api/files/leases', 'POST', { paths: [languagePath] })
  await send(a.token, apply([field('completion', 'any', 'all'), locale('description', present('由同一工程服务管理'), present('不可部分修改'))]), 'rejected', 'locked')
  assert.equal((await source()).completion, 'any')
  assert.equal((await language()).description, '由同一工程服务管理')
  assert.equal((await h.api(owner.token, '/api/project')).leases.length, 1, 'Rejected acquisition leaked a source lease')
  await h.release(owner.token)
  await send(a.token, apply([field('completion', 'any', 'all')]))
  await noLeases(owner.token)
  passed('关联语言被其他编辑器锁定时命令整批拒绝且无残留租约，释放后可重新提交')

  const beforeInvalid = await history(owner.token)
  await send(a.token, { ...apply([field('completion', 'all', 'any')]), documentId: 'replaced-document' }, 'rejected', 'conflict')
  await send(a.token, apply([field('id', fixtureProgress().id, 'replaced-document')]), 'rejected', 'invalid')
  await send(a.token, apply([field('completion', 'all', 'any'), field('completion', 'all', 'any')]), 'rejected', 'invalid')
  await send(a.token, apply([field('completion', 'all', 'any'), locale('name', absent(), present('escaped'), '../outside')]), 'rejected', 'invalid')
  const mixed = request(apply([field('completion', 'all', 'any')]))
  mixed.changes.push({ op: 'write', path: 'meta/docs/notes.md', version: null, content: Buffer.from('must not write').toString('base64'), leaseId: '' })
  const mixedReceipt = await h.api(a.token, '/api/files/commit', 'POST', mixed)
  assert.equal(mixedReceipt.status, 'rejected'); assert.equal(mixedReceipt.error.code, 'invalid')
  assert.equal((await source()).completion, 'all')
  assert.equal((await history(owner.token)).revisions, beforeInvalid.revisions)
  await noLeases(owner.token)
  passed('文档身份替换、重复目标、任意字段和越界语言路径均拒绝，语义命令不能夹带普通文件写入')

  const beforePermission = await history(owner.token)
  await send(v.token, apply([field('completion', 'all', 'any')]), 'rejected', 'forbidden')
  await h.api(owner.token, `/api/subjects/${editorA.subject.id}`, 'PATCH', { role: 'viewer', enabled: true })
  await send(a.token, apply([field('completion', 'all', 'any')]), 'rejected', 'forbidden')
  assert.equal((await source()).completion, 'all')
  assert.equal((await history(owner.token)).revisions, beforePermission.revisions)
  await h.api(owner.token, `/api/subjects/${editorA.subject.id}`, 'PATCH', { role: 'editor', enabled: true })
  await noLeases(owner.token)
  passed('只读主体和会话中被降权主体不能发送语义修改，权限在 S 提交时重新校验')

  const beforeRestart = await history(owner.token)
  const persisted = await send(a.token, apply([field('authorNotes', '', '重启后仍可确认和撤销')]))
  await h.stop(); await h.start()
  const resumed = await h.login(editorA.credential, 'API A restarted'), resumedOwner = await h.login(h.credential, 'owner restarted')
  tokens.splice(0, tokens.length, resumed.token, resumedOwner.token)
  assert.deepEqual(await h.api(resumed.token, `/api/files/transactions/${persisted.input.transactionId}`), persisted.receipt)
  assert.deepEqual(await h.api(resumed.token, '/api/files/commit', 'POST', persisted.input), persisted.receipt)
  assert.equal((await history(resumedOwner.token)).revisions, beforeRestart.revisions + 1)
  await send(resumed.token, { command: 'revert', transactionId: persisted.input.transactionId })
  assert.equal((await source()).authorNotes, '')
  await noLeases(resumedOwner.token)
  passed('S 重启保留语义结果及撤销依据，同主体新会话确认原事务且不会重复执行')

  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'http-acceptance.json'), JSON.stringify({ protocol: 11, physicalHosts: 1, tests: results }, null, 2))
  console.log(`进度操作 HTTP 验收通过：${results.length} 组。`)
} finally { clearInterval(heartbeat); await h.stop() }
