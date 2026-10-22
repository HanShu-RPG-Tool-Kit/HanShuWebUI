import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { harness, progress } from './collaboration-harness.mjs'

const h = await harness()
const source = 'src/progress/example.progress'
const language = 'assets/zh_cn/lang_progress/example.lang'
const results = []
const passed = name => { results.push(name); console.log(`通过：${name}`) }
const plan = (token, operations, status = 200) => h.api(token, '/api/files/plan', 'POST', { operations }, status)
const relations = (token, path, status = 200) => h.api(token, `/api/files/relations?path=${encodeURIComponent(path)}`, 'GET', undefined, status)
async function fixture(path, content) {
  await mkdir(join(h.root, path, '..'), { recursive: true })
  await writeFile(join(h.root, path), content)
}
async function preparedPlan(token, operationPlan, { operations = operationPlan.operations, contents = {} } = {}) {
  const leases = await h.api(token, '/api/files/leases', 'POST', { paths: operationPlan.leasePaths })
  return {
    transactionId: randomUUID(),
    changes: operations.map(operation => ({
      op: operation.op, path: operation.path, destination: operation.destination,
      version: operation.version, destinationVersion: operation.destinationVersion,
      content: contents[operation.path] === undefined ? null : Buffer.from(contents[operation.path]).toString('base64'),
      leaseId: leases.find(lease => lease.resourceId === `file:${operation.path}`).id,
    })),
  }
}
const submit = (token, batch) => h.api(token, '/api/files/commit', 'POST', batch)

try {
  assert.equal((await h.api('', '/health')).protocol, 10)
  const owner = await h.login(h.credential, '关系策略验收')
  const reader = await h.api(owner.token, '/api/subjects', 'POST', { name: '关系查看者', kind: 'agent', role: 'viewer' })
  const viewer = await h.login(reader.credential, '只读方案查看')
  const editorSubject = await h.api(owner.token, '/api/subjects', 'POST', { name: '独立编辑者', kind: 'account', role: 'editor' })
  const editor = await h.login(editorSubject.credential, '独立编辑')
  await h.api('', '/api/files/plan', 'POST', { operations: [{ op: 'remove', path: source }] }, 401)
  await relations('', source, 401)
  await h.api(owner.token, '/api/files/source-plan?path=src/progress/example.progress', 'GET', undefined, 404)

  const beforeTree = await h.files(owner.token)
  const beforeState = await h.api(owner.token, '/api/project')
  const sourceRelations = await relations(viewer.token, source)
  assert.deepEqual(Object.keys(sourceRelations).sort(), ['path', 'relations'])
  assert.ok(sourceRelations.relations.some(item => item.kind === 'ownership' && item.role === 'language' && item.from === source && item.to === language))
  const writePlan = await plan(viewer.token, [{ op: 'write', path: language }])
  assert.deepEqual(writePlan.operations.map(item => item.path), [language])
  assert.ok(writePlan.leasePaths.includes(source))
  assert.ok(writePlan.leasePaths.includes(language))
  assert.ok(writePlan.authorities.some(item => item.path === language && item.authorityPath === source && item.sourceKind === 'progress'))
  assert.deepEqual(await h.files(owner.token), beforeTree)
  assert.deepEqual((await h.api(owner.token, '/api/project')).leases, beforeState.leases)
  passed('只读主体可查询关系与计划；查询不获取租约、不修改文件')

  const rawLease = await h.api(editor.token, '/api/files/leases', 'POST', { paths: [language] })
  assert.equal(rawLease.length, 1)
  assert.equal(rawLease[0].resourceId, `file:${language}`)
  const rawRequest = {
    transactionId: randomUUID(),
    changes: [{ op: 'write', path: language, version: writePlan.operations[0].version, content: Buffer.from('{"name":"不能越过策略"}').toString('base64'), destination: null, destinationVersion: null, leaseId: rawLease[0].id }],
  }
  const rawReceipt = await submit(editor.token, rawRequest)
  assert.equal(rawReceipt.status, 'rejected')
  assert.equal(rawReceipt.error.code, 'locked')
  assert.equal(await readFile(join(h.root, language), 'utf8'), h.fixtures[language])
  await h.release(editor.token)
  const validWrite = await preparedPlan(editor.token, await plan(editor.token, [{ op: 'write', path: language }]), { contents: { [language]: '{"name":"按服务端策略提交"}' } })
  assert.equal((await submit(editor.token, validWrite)).status, 'committed')
  await h.release(editor.token)
  passed('租约机制只处理路径；修改策略单独要求源文件写权且提交端重验')

  const ownedVoice = 'assets/en_us/voice_progress/example/line.ogg'
  const sharedKit = 'src/gift/shared-reward.kit'
  await fixture(ownedVoice, 'voice-content')
  await fixture(sharedKit, '{"reward":"shared"}')
  await fixture(source, JSON.stringify({ ...progress, rewardKits: ['shared-reward'] }))
  const allRelations = await relations(owner.token, source)
  assert.ok(allRelations.relations.some(item => item.kind === 'reference' && item.role === 'rewardKit' && item.to === sharedKit))
  const movePlan = await plan(owner.token, [{ op: 'move', path: source, destination: 'src/progress/renamed.progress' }])
  assert.ok(movePlan.operations.some(item => item.path === language && item.destination === 'assets/zh_cn/lang_progress/renamed.lang'))
  assert.ok(movePlan.operations.some(item => item.path === 'assets/en_us/voice_progress/example' && item.destination === 'assets/en_us/voice_progress/renamed'))
  assert.ok(movePlan.operations.every(item => item.originPath === source))
  assert.ok(!movePlan.operations.some(item => item.path === sharedKit))
  assert.ok(!movePlan.leasePaths.includes(sharedKit))
  passed('归属资源参与改名；共享礼包引用不自动获取写权或级联修改')

  const partialRequest = await preparedPlan(owner.token, movePlan, { operations: movePlan.operations.filter(item => item.path === source) })
  const partialReceipt = await submit(owner.token, partialRequest)
  assert.equal(partialReceipt.status, 'rejected')
  assert.equal(partialReceipt.error.code, 'invalid')
  assert.equal(await readFile(join(h.root, ownedVoice), 'utf8'), 'voice-content')
  assert.ok((await h.files(owner.token)).entries.some(item => item.path === source))
  await h.release(owner.token)

  const stalePlan = await plan(owner.token, [{ op: 'remove', path: source }])
  const newLanguage = 'assets/fr_fr/lang_progress/example.lang'
  await h.commit(editor.token, [{ path: newLanguage, content: '{"name":"新增法文"}' }])
  await h.release(editor.token)
  const staleBatch = await preparedPlan(owner.token, stalePlan)
  const staleReceipt = await submit(owner.token, staleBatch)
  assert.equal(staleReceipt.status, 'rejected')
  assert.equal(staleReceipt.error.code, 'invalid')
  assert.equal(await readFile(join(h.root, newLanguage), 'utf8'), '{"name":"新增法文"}')
  await h.release(owner.token)
  passed('删减计划和计划后新增归属资源均无法绕过提交时的重新推导')

  const deletePlan = await plan(owner.token, [{ op: 'remove', path: source }])
  assert.ok(deletePlan.operations.some(item => item.path === newLanguage))
  const deleteRequest = await preparedPlan(owner.token, deletePlan)
  const deleteReceipt = await submit(owner.token, deleteRequest)
  assert.equal(deleteReceipt.status, 'committed')
  assert.equal(await readFile(join(h.root, sharedKit), 'utf8'), '{"reward":"shared"}')
  const deleted = await h.files(owner.token)
  for (const path of [source, language, newLanguage, ownedVoice]) assert.ok(!deleted.entries.some(item => item.path === path), path)
  assert.deepEqual(await submit(owner.token, deleteRequest), deleteReceipt)
  passed('完整计划原子删除正文、所有语言和配音；保留共享引用并可幂等重放')

  for (const [path, status] of [['../outside', 400], ['C:/outside', 400], ['assets/../secret', 400], ['.hanshu/service/owner-key', 403], ['src/' + 'a'.repeat(1025), 400]]) {
    await relations(viewer.token, path, status)
    await plan(viewer.token, [{ op: 'write', path }], status)
  }
  await plan(viewer.token, [{ op: 'move', path: 'meta/docs/notes.md', destination: '.hanshu/service/leak' }], 403)
  await plan(viewer.token, [], 400)
  await plan(viewer.token, Array.from({ length: 4097 }, () => ({ op: 'check', path: 'src/a' })), 400)
  await h.api(viewer.token, '/api/files/plan', 'POST', { operations: [], leasePaths: [] }, 422)
  await h.api(viewer.token, '/api/files/plan', 'POST', { operations: [{ op: 'write', path: `src/${'a'.repeat(256 * 1024)}` }] }, 413)
  passed('关系与计划端点拒绝越权路径、非法批次、伪造字段及超限请求')
  console.log(`资源关系与操作策略 HTTP 验收通过：${results.length} 组。`)
} finally {
  await h.stop()
}
