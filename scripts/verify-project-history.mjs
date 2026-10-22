import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { harness, progress } from './collaboration-harness.mjs'
import { progressPath, progressLangPath, scriptPath, skinIndexPath, skinFixture, restoreCommit, replyLossProxy } from './history-test-helpers.mjs'

// Real Rust S and public v9 HTTP. Each assertion concerns persisted state or a
// public reply, rather than substituting a mock for the history implementation.
const output = resolve('../output/project-history')
const results = [], proxy = await replyLossProxy()
const h = await harness({ origins: [proxy.base] }); proxy.setUpstream(h.base)
let owner, a, b, viewer, tokens = []
const heartbeat = setInterval(() => { for (const token of tokens) void h.api(token, '/api/heartbeat', 'POST', { resourceId: null, fileLeases: [] }).catch(() => undefined) }, 8000)
const passed = name => { results.push({ name, status: 'passed' }); console.log(`通过：${name}`) }
const list = (token = owner.token, query = '') => h.api(token, `/api/history${query}`)
const stats = () => h.api(owner.token, '/api/history/stats')
const content = (sequence, path, token = owner.token, status = 200) => h.api(token, `/api/history/${sequence}/content?path=${encodeURIComponent(path)}`, 'GET', undefined, status)
const selection = (sequence, paths = null, includeRelated = false, skinEntryId = null) => ({ sequence, paths, includeRelated, skinEntryId })
const plan = (token, input, status = 200) => h.api(token, '/api/history/restore-plan', 'POST', input, status)
const committed = value => { assert.equal(value.status, 'committed', JSON.stringify(value.error)); return value }
const rejected = (value, code) => { assert.equal(value.status, 'rejected', JSON.stringify(value)); assert.equal(value.error.code, code) }
const disk = path => readFile(join(h.root, path))
const diskIndex = async () => JSON.parse(await disk(skinIndexPath))
const entry = async id => (await diskIndex()).entries.find(value => value.entryId === id)
async function commit(token, edits) {
  const request = await h.prepare(token, edits)
  try { return { request, receipt: committed(await h.api(token, '/api/files/commit', 'POST', request)) } }
  finally { await h.release(token) }
}
async function patch(token, entryId, changes) {
  return commit(token, [{ op: 'skin-entry-patch', path: skinIndexPath, content: JSON.stringify({ entryId, expectedRevision: (await entry(entryId)).revision, changes }) }])
}
async function restore(token, selection) {
  const preview = await plan(token, selection)
  const request = restoreCommit(preview)
  const receipt = committed(await h.api(token, '/api/files/commit', 'POST', request))
  return { preview, request, receipt }
}
async function proxiedSubmit(token, request) {
  const response = await fetch(`${proxy.base}/api/files/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request), signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200)
  return response.json()
}
try {
  await mkdir(output, { recursive: true })
  assert.equal((await h.api('', '/health')).protocol, 10)
  owner = await h.login(h.credential, '历史管理员')
  const author = await h.api(owner.token, '/api/subjects', 'POST', { name: '历史作者 A', kind: 'account', role: 'editor' })
  const collaborator = await h.api(owner.token, '/api/subjects', 'POST', { name: '历史作者 B', kind: 'agent', role: 'editor' })
  const observer = await h.api(owner.token, '/api/subjects', 'POST', { name: '历史审阅者', kind: 'account', role: 'viewer' })
  a = await h.login(author.credential, '创作窗口 A'); b = await h.login(collaborator.credential, '创作窗口 B'); viewer = await h.login(observer.credential, '审阅窗口')
  tokens = [owner.token, a.token, b.token, viewer.token]
  const initial = await list()
  assert.equal(initial.entries.length, 1); assert.equal(initial.entries[0].kind, 'baseline')
  const baseline = initial.entries[0].sequence
  assert.ok(initial.projectId); assert.equal(initial.entries[0].projectId, initial.projectId)
  assert.equal((await stats()).revisions, 1)
  assert.equal(Buffer.from((await content(baseline, scriptPath, viewer.token)).content, 'base64').toString(), h.fixtures[scriptPath])
  const initialTree = await h.api(viewer.token, `/api/history/${baseline}/tree`)
  assert.ok(initialTree.entries.some(value => value.path === progressPath))
  assert.ok(!JSON.stringify(initialTree).includes('owner-key'))
  await h.api('', '/api/history', 'GET', undefined, 401)
  await content(baseline, '.hanshu/service/owner-key', viewer.token, 403)
  await content(baseline, '../../secret', viewer.token, 400)
  passed('初始工程形成共享基线，审阅者可读正文与清单，服务凭证和越界路径不可读')

  const binaryPath = 'assets/history/voice.ogg', binary = Buffer.from([0, 255, 13, 10, 128, 42, 0])
  const firstText = '标题：历史里的第一版\n'
  const firstLang = JSON.stringify({ name: '历史进度标题', description: '正文和语言同事务' })
  const progressOne = JSON.stringify({ ...progress, tags: ['历史第一版'] })
  const moreResources = [
    { path: 'src/story/history.hflow', content: JSON.stringify({ format: 'hanshu.progress-tree', version: 1, id: 'history-flow', entry: { id: 'entry', target: null }, nodes: {}, layout: { positions: {} } }) },
    { path: 'src/items/history.item', content: JSON.stringify({ id: 'history-item' }) },
    { path: 'src/gift/history.kit', content: JSON.stringify({ id: 'history-kit' }) },
    { path: 'assets/history/preview.png', content: Buffer.from('89504e470d0a1a0a', 'hex') },
  ]
  const first = await commit(a.token, [{ path: scriptPath, content: firstText }, { path: progressPath, content: progressOne }, { path: progressLangPath, content: firstLang }, { path: binaryPath, content: binary }, ...moreResources])
  const afterFirst = await list(), firstRevision = afterFirst.entries[0]
  assert.equal(firstRevision.transactionId, first.request.transactionId)
  assert.equal(firstRevision.actor.subjectId, author.subject.id); assert.equal(firstRevision.actor.clientName, '创作窗口 A')
  assert.equal((await stats()).revisions, 2)
  for (const path of [scriptPath, progressPath, progressLangPath, binaryPath]) assert.ok(firstRevision.changes.some(value => value.path === path))
  for (const resource of moreResources) assert.deepEqual(Buffer.from((await content(firstRevision.sequence, resource.path)).content, 'base64'), Buffer.from(resource.content))
  assert.deepEqual(Buffer.from((await content(firstRevision.sequence, binaryPath)).content, 'base64'), binary)
  assert.equal(Buffer.from((await content(firstRevision.sequence, progressLangPath)).content, 'base64').toString(), firstLang)
  passed('文本、进度、语言与二进制一次有效事务只生成一个完整版本，记录主体和客户端来源')

  const beforeNoop = await stats()
  await commit(a.token, [{ path: scriptPath, content: firstText }])
  assert.equal((await stats()).head, beforeNoop.head)
  assert.deepEqual(await h.api(a.token, '/api/files/commit', 'POST', first.request), first.receipt)
  assert.equal((await stats()).revisions, beforeNoop.revisions)
  const bad = await h.prepare(a.token, [{ path: scriptPath, version: 'stale-version', content: '不应进入历史' }])
  rejected(await h.api(a.token, '/api/files/commit', 'POST', bad), 'conflict'); await h.release(a.token)
  assert.equal((await stats()).head, beforeNoop.head)
  await h.api(a.token, '/api/presence', 'POST', { path: scriptPath, activity: 'editing' })
  assert.equal((await stats()).head, beforeNoop.head)
  passed('相同内容、失败提交、原事务重试和在线状态均不产生多余历史')

  const [ca, cb] = await Promise.all([
    commit(a.token, [{ path: 'meta/docs/author-a.md', content: '作者 A 独立文件' }]),
    commit(b.token, [{ path: 'src/script/author-b.py', content: 'print("author B")\n' }]),
  ])
  const concurrent = (await list()).entries.filter(value => [ca.request.transactionId, cb.request.transactionId].includes(value.transactionId))
  assert.equal(concurrent.length, 2)
  assert.deepEqual(new Set(concurrent.map(value => value.actor.subjectId)), new Set([author.subject.id, collaborator.subject.id]))
  assert.equal(concurrent[0].groupId, concurrent[1].groupId)
  assert.equal(concurrent[0].groupId, firstRevision.groupId)
  assert.equal(new Set((await list()).entries.map(value => value.sequence)).size, (await list()).entries.length)
  passed('两个独立主体并发提交形成有序且完整的版本，连续编辑按同一时段聚合展示')

  await h.api(a.token, `/api/history/${firstRevision.sequence}/label`, 'POST', { label: '里程碑：完成进度与配音' })
  await h.api(viewer.token, `/api/history/${firstRevision.sequence}/label`, 'POST', { label: '不应写入' }, 403)
  const languageOnly = await commit(b.token, [{ path: progressLangPath, content: JSON.stringify({ name: '后续远端标题', description: '后续修改' }) }])
  const progressHistory = await list(owner.token, `?path=${encodeURIComponent(progressPath)}`)
  assert.ok(progressHistory.entries.some(value => value.transactionId === languageOnly.request.transactionId), 'Progress title edits in its owned language are absent from resource history')
  const resourceTree = await h.api(owner.token, `/api/history/${progressHistory.entries[0].sequence}/tree?path=${encodeURIComponent(progressPath)}`)
  assert.equal(resourceTree.scopePath, progressPath)
  assert.ok(resourceTree.entries.some(value => value.path === progressPath))
  assert.ok(resourceTree.entries.some(value => value.path === progressLangPath))
  assert.ok(!resourceTree.entries.some(value => value.path === scriptPath || value.path.endsWith('.kit')), 'Resource comparison leaked unrelated project files')
  const named = (await list(viewer.token)).entries.find(value => value.sequence === firstRevision.sequence)
  assert.equal(named.label, '里程碑：完成进度与配音')
  assert.equal(Buffer.from((await content(named.sequence, progressLangPath)).content, 'base64').toString(), firstLang)
  assert.equal((await stats()).namedVersions, 1)
  const pageOne = await list(owner.token, '?limit=2')
  assert.equal(pageOne.entries.length, 2); assert.ok(pageOne.nextBefore)
  const pageTwo = await list(owner.token, `?limit=2&before=${pageOne.nextBefore}`)
  assert.ok(pageTwo.entries.every(value => !pageOne.entries.some(old => old.sequence === value.sequence)))
  passed('命名版本固定指向原工程状态，可跨主体查询；只读无法命名，分页没有重复版本')

  await writeFile(join(h.root, scriptPath), '外部编辑器修改正文\n')
  await writeFile(join(h.root, binaryPath), Buffer.from([1, 2, 3, 4]))
  const afterExternalCommit = await commit(a.token, [{ path: 'meta/docs/after-external.md', content: '外部变更之后的正常提交' }])
  const externalHistory = (await list()).entries
  const normalIndex = externalHistory.findIndex(value => value.transactionId === afterExternalCommit.request.transactionId)
  const external = externalHistory[normalIndex + 1]
  assert.equal(external.kind, 'external'); assert.equal(external.actor, null); assert.equal(external.transactionId, null)
  assert.ok(external.changes.some(value => value.path === scriptPath)); assert.ok(external.changes.some(value => value.path === binaryPath))
  assert.notEqual(external.groupId, externalHistory[normalIndex].groupId)
  assert.equal(Buffer.from((await content(external.sequence, scriptPath)).content, 'base64').toString(), '外部编辑器修改正文\n')
  passed('外部改盘先单独收录为外部修改，再记录后续提交，不冒记为最近编辑主体')

  const sourcePreview = await plan(a.token, selection(firstRevision.sequence, [progressPath], true))
  assert.ok(sourcePreview.changes.some(value => value.path === progressLangPath), 'Related language is missing from the restore plan')
  assert.ok(sourcePreview.request.expectedHead)
  const beforeRestore = await stats()
  const sourceRestore = committed(await h.api(a.token, '/api/files/commit', 'POST', restoreCommit(sourcePreview)))
  assert.ok(sourceRestore.tree)
  assert.equal((await disk(progressPath)).toString(), progressOne)
  assert.equal((await disk(progressLangPath)).toString(), firstLang)
  const restoreRevision = (await list()).entries[0]
  assert.equal(restoreRevision.kind, 'restore'); assert.equal((await stats()).revisions, beforeRestore.revisions + 1)
  assert.notEqual(restoreRevision.groupId, (await list()).entries[1].groupId)
  const stableCount = (await stats()).revisions
  await restore(a.token, selection(firstRevision.sequence, [progressPath], true))
  assert.equal((await stats()).revisions, stableCount)
  passed('进度与所属语言按明确计划一起恢复，恢复是新版本；内容已一致的恢复不制造空版本')

  const stalePlan = await plan(a.token, selection(baseline, [scriptPath]))
  await commit(b.token, [{ path: scriptPath, content: '计划预览后协作者更新\n' }])
  rejected(await h.api(a.token, '/api/files/commit', 'POST', restoreCommit(stalePlan)), 'conflict')
  assert.equal((await disk(scriptPath)).toString(), '计划预览后协作者更新\n')
  const lockedPlan = await plan(a.token, selection(baseline, [scriptPath]))
  await h.api(b.token, '/api/files/leases', 'POST', { paths: [scriptPath] })
  rejected(await h.api(a.token, '/api/files/commit', 'POST', restoreCommit(lockedPlan)), 'locked')
  await h.release(b.token)
  const prohibited = restoreCommit(await plan(owner.token, selection(baseline, [scriptPath])))
  rejected(await h.api(viewer.token, '/api/files/commit', 'POST', prohibited), 'forbidden')
  await plan(a.token, selection(baseline), 403)
  passed('恢复受当前版本、写权和角色约束；过期计划不会覆盖协作者更新，整工程恢复仅管理者可用')

  const lossPlan = await plan(a.token, selection(baseline, [scriptPath]))
  const lossRequest = restoreCommit(lossPlan), countBeforeLoss = (await stats()).revisions
  proxy.dropNextRestore()
  await assert.rejects(proxiedSubmit(a.token, lossRequest))
  const recovered = committed(await h.api(a.token, `/api/files/transactions/${lossRequest.transactionId}`))
  assert.equal((await disk(scriptPath)).toString(), h.fixtures[scriptPath])
  assert.deepEqual(await h.api(a.token, '/api/files/commit', 'POST', lossRequest), recovered)
  assert.equal((await stats()).revisions, countBeforeLoss + 1)
  passed('恢复成功回复丢失可查询原回执，重试原事务不会再次写入或追加历史')

  const skinA = skinFixture(60), skinB = skinFixture(180)
  for (const [skin, id, name] of [[skinA, 'history-skin-a', '历史皮肤 A'], [skinB, 'history-skin-b', '历史皮肤 B']]) {
    await commit(a.token, [{ op: 'skin-library-command', path: skinIndexPath, content: JSON.stringify({ command: 'import-entry', entry: skin.entry(id, name) }) }, { path: skin.objectPath, content: skin.object }])
  }
  const skinBase = (await stats()).head
  await patch(a.token, 'history-skin-a', { name: '历史皮肤 A 修改后', tags: ['后来增加'] })
  await patch(b.token, 'history-skin-b', { name: '历史皮肤 B 应当保留', note: '另一协作者的修改' })
  const beforeSkinA = await entry('history-skin-a'), beforeSkinB = await entry('history-skin-b')
  const skinResult = await restore(a.token, selection(skinBase, [skinIndexPath], false, 'history-skin-a'))
  assert.equal((await entry('history-skin-a')).name, '历史皮肤 A'); assert.deepEqual((await entry('history-skin-a')).tags, [])
  assert.ok((await entry('history-skin-a')).revision > beforeSkinA.revision)
  assert.deepEqual(await entry('history-skin-b'), beforeSkinB)
  assert.ok(skinResult.preview.changes.some(value => value.path === skinIndexPath))
  assert.deepEqual(await disk(skinA.objectPath), skinA.object); assert.deepEqual(await disk(skinB.objectPath), skinB.object)
  passed('单皮肤恢复仅恢复选定条目，条目版本前进且保留其他协作者对另一条目的修改')

  const skinRestoredCount = (await stats()).revisions
  await restore(a.token, selection(skinBase, [skinIndexPath], false, 'history-skin-a'))
  assert.equal((await stats()).revisions, skinRestoredCount)
  const highRevisionLibrary = await diskIndex()
  highRevisionLibrary.entries.find(value => value.entryId === 'history-skin-a').revision = 500
  highRevisionLibrary.revision++
  await commit(a.token, [{ path: skinIndexPath, content: JSON.stringify(highRevisionLibrary) }])
  const skinARevision = 500
  await commit(a.token, [{ op: 'skin-library-command', path: skinIndexPath, content: JSON.stringify({ command: 'delete-entries', expectedEntries: [{ entryId: 'history-skin-a', revision: skinARevision }] }) }])
  await commit(a.token, [{ op: 'remove', path: skinA.objectPath }])
  assert.ok(!(await h.files(owner.token)).entries.some(value => value.path === skinA.objectPath))
  await restore(a.token, selection(skinBase, [skinIndexPath], false, 'history-skin-a'))
  assert.equal((await entry('history-skin-a')).name, '历史皮肤 A')
  assert.ok((await entry('history-skin-a')).revision > skinARevision)
  assert.deepEqual(await disk(skinA.objectPath), skinA.object)
  assert.deepEqual(await entry('history-skin-b'), beforeSkinB)
  const staleSkinPatch = await h.prepare(a.token, [{ op: 'skin-entry-patch', path: skinIndexPath, content: JSON.stringify({ entryId: 'history-skin-a', expectedRevision: skinARevision, changes: { name: '旧实例不应覆盖新恢复' } }) }])
  rejected(await h.api(a.token, '/api/files/commit', 'POST', staleSkinPatch), 'conflict'); await h.release(a.token)
  assert.equal((await entry('history-skin-a')).name, '历史皮肤 A')
  passed('已一致皮肤恢复不增版本；删后恢复补齐对象，跨历史修订号高水位使旧实例修改仍被拒绝')

  const nestedPath = 'meta/docs/parent-restore/nested/file.md'
  await commit(a.token, [{ path: nestedPath, content: '恢复时父目录也应出现在预览' }])
  const nestedVersion = (await stats()).head
  await commit(a.token, [{ op: 'remove', path: 'meta/docs/parent-restore' }])
  const nestedPlan = await plan(a.token, selection(nestedVersion, [nestedPath]))
  for (const parent of ['meta/docs/parent-restore', 'meta/docs/parent-restore/nested']) {
    assert.ok(nestedPlan.changes.some(value => value.path === parent && value.action === 'mkdir'), `Missing parent creation in restore plan: ${parent}`)
  }
  committed(await h.api(a.token, '/api/files/commit', 'POST', restoreCommit(nestedPlan)))
  assert.equal((await disk(nestedPath)).toString(), '恢复时父目录也应出现在预览')
  passed('恢复父目录已删除的单文件时，预览明确列出必要目录并原子重建')

  const move = await commit(a.token, [{ op: 'move', path: 'meta/docs/author-a.md', destination: 'meta/docs/author-a-renamed.md' }])
  const movedRevision = (await list()).entries.find(value => value.transactionId === move.request.transactionId)
  assert.ok(movedRevision.changes.some(value => value.path === 'meta/docs/author-a.md' && value.after === null))
  assert.ok(movedRevision.changes.some(value => value.path === 'meta/docs/author-a-renamed.md' && value.before === null))
  assert.ok(movedRevision.moves.some(value => value.from === 'meta/docs/author-a.md' && value.to === 'meta/docs/author-a-renamed.md'))
  const renamedHistory = await list(owner.token, `?path=${encodeURIComponent('meta/docs/author-a-renamed.md')}`)
  assert.ok(renamedHistory.entries.some(value => value.transactionId === ca.request.transactionId), 'Renamed resource history lost its earlier name')
  const deletion = await commit(a.token, [{ op: 'remove', path: 'meta/docs/author-a-renamed.md' }])
  const deletedRevision = (await list()).entries.find(value => value.transactionId === deletion.request.transactionId)
  assert.notEqual(deletedRevision.groupId, movedRevision.groupId)
  const whole = await restore(owner.token, selection(firstRevision.sequence))
  assert.ok(whole.preview.changes.some(value => value.action === 'remove'))
  assert.equal((await disk(scriptPath)).toString(), firstText)
  assert.deepEqual(await disk(binaryPath), binary)
  assert.ok(!(await h.files(owner.token)).entries.some(value => value.path === 'meta/docs/after-external.md'))
  assert.equal((await disk(progressLangPath)).toString(), firstLang)
  passed('改名与删除保留变化前后状态，删除单独显示；管理员可按计划恢复整个工程及二进制资源')

  const beforeRestart = await stats(), historyBeforeRestart = await list()
  await h.stop(); await h.start(); proxy.setUpstream(h.base)
  owner = await h.login(h.credential, '重启后管理员'); a = await h.login(author.credential, '重启后作者 A'); tokens = [owner.token, a.token]
  assert.deepEqual(await stats(), beforeRestart)
  assert.deepEqual(await list(), historyBeforeRestart)
  assert.deepEqual(await h.api(a.token, `/api/files/transactions/${lossRequest.transactionId}`), recovered)
  assert.deepEqual(await h.api(a.token, '/api/files/commit', 'POST', lossRequest), recovered)
  assert.equal((await stats()).head, beforeRestart.head)
  assert.equal((await disk(scriptPath)).toString(), firstText, 'Replaying an old restore changed the current project after restart')
  assert.ok((await stats()).storedBytes > 0); assert.ok((await stats()).objects > 0)
  passed('服务重启后历史、命名和统计完整保留；旧恢复回执重试不会回退较新的工程状态')

  const otherProject = await harness()
  try {
    const otherOwner = await otherProject.login(otherProject.credential, '另一工程管理员')
    const otherHistory = await otherProject.api(otherOwner.token, '/api/history')
    assert.notEqual(otherHistory.projectId, initial.projectId)
    assert.equal(otherHistory.entries.length, 1)
    assert.equal(otherHistory.entries[0].label, null)
    const otherText = await otherProject.api(otherOwner.token, `/api/history/${otherHistory.head}/content?path=${encodeURIComponent(scriptPath)}`)
    assert.equal(Buffer.from(otherText.content, 'base64').toString(), h.fixtures[scriptPath])
    assert.notEqual(Buffer.from(otherText.content, 'base64').toString(), firstText)
    passed('不同工程即使有同名文件和相同清单标识，服务历史身份及命名版本仍相互隔离')
  } finally { await otherProject.stop() }

  await writeFile(join(output, 'http-acceptance.json'), JSON.stringify({ protocol: 10, transport: 'real HTTP with one fault-injecting proxy on a single host', tests: results, stats: await stats() }, null, 2))
  console.log(`工程历史 HTTP 验收通过：${results.length} 组。`)
} finally { clearInterval(heartbeat); await h.stop(); await proxy.close() }
