import assert from 'node:assert/strict'
import { ProjectClient, type FileEdit } from '../src/project/serviceClient'
import { editMatchesResource, resourceDirty, resourceSaveState, resourceTransactions } from '../src/project/resourceStatus'
import type { Snapshot } from '../src/collab/protocol'
import type { EditTransactionState, TransactionInfo } from '../src/project/editTransactions'

let checks = 0
const test = async (name: string, action: () => void | Promise<void>) => { await action(); console.log(`通过：${name}`); checks++ }
const index = '.hanshu/skinmanager/library.json'
const scope = { path: index, entryId: 'a' }
const command = (value: object): FileEdit => ({ op: 'skin-library-command', path: index, data: JSON.stringify(value) })
const authority = (path: string) => path === 'assets/zh_cn/lang_hs/story.lang' ? 'src/hanshu/story.hs' : undefined
const record = (id: number, phase: TransactionInfo['phase']): TransactionInfo => ({ id, requestId: `tx-${id}`, label: 'operation', phase, paths: [index], message: '', code: '' })
const state = (records: TransactionInfo[]): EditTransactionState => ({ pendingPaths: [], preparing: 0, queued: 0, transactions: records, journalError: '' })

await test('单条、批量、导入事务精确归属皮肤，其他条目失败不会污染当前状态', () => {
  for (const edit of [
    { op: 'skin-entry-patch' as const, path: index, data: JSON.stringify({ entryId: 'a' }) },
    command({ command: 'import-entry', entry: { entryId: 'a' } }),
    command({ command: 'batch-patch', expectedEntries: [{ entryId: 'a' }] }),
    command({ command: 'delete-entries', expectedEntries: [{ entryId: 'a' }] }),
  ]) {
    assert.equal(editMatchesResource(edit, scope, authority), true)
    assert.equal(editMatchesResource(edit, { ...scope, entryId: 'b' }, authority), false)
  }
  assert.equal(editMatchesResource(command({ command: 'create-folder', folderId: 'a' }), scope, authority), false)
  assert.equal(editMatchesResource({ op: 'write', path: index, data: '{}' }, scope, authority), false)
})

await test('关联语言和源文件共用状态，移动的两个路径都显示同一次提交', () => {
  const source = { path: 'src/hanshu/story.hs' }
  assert.equal(editMatchesResource({ op: 'write', path: 'assets/zh_cn/lang_hs/story.lang' }, source, authority), true)
  assert.equal(editMatchesResource({ op: 'move', path: 'src/hanshu/story.hs', destination: 'src/hanshu/new.hs' }, { path: 'src/hanshu/new.hs' }, authority), true)
  assert.equal(resourceDirty({ editingAuthority: authority }, source, { ...state([]), pendingPaths: ['assets/zh_cn/lang_hs/story.lang'] }), true)
  assert.equal(resourceDirty({ editingAuthority: authority }, scope, { ...state([]), pendingPaths: [index] }), false)
})

await test('弹窗仅跟踪原事务；未知结果优先于后续未保存输入', () => {
  const records = [record(1, 'uncertain'), record(2, 'failed'), record(3, 'saved')]
  const client = { editingAuthority: authority, transactions: { submission: (id: number) => id === 3 ? [] : [command({ command: 'import-entry', entry: { entryId: id === 1 ? 'a' : 'b' } })] } } as unknown as ProjectClient
  assert.deepEqual(resourceTransactions(client, scope, state(records)).map(item => item.id), [1])
  assert.deepEqual(resourceTransactions(client, { path: index, transactionId: 2 }, state(records)).map(item => item.id), [2])
  assert.equal(resourceSaveState(records.filter(item => item.phase !== 'saved'), true).text, '结果待确认')
  assert.equal(resourceSaveState([], true).text, '未保存')
  assert.equal(resourceSaveState([], false).text, '已同步')
})

function fixture() {
  let version = 1
  const session: Snapshot['session'] = { id: 'session', subjectId: 'subject', clientName: 'browser', expiresAt: Date.now() + 60000, resourceId: null, activity: 'viewing', filePresence: null }
  const snapshot = (): Snapshot => ({ statusVersion: version++, serverTime: Date.now(), projectId: 'p', projectName: 'p', revision: 1, filesRevision: 1, session: structuredClone(session), sessions: [structuredClone(session)], role: 'editor', members: [], resources: [], leases: [] })
  const client = new ProjectClient({ url: 'http://presence.test', token: 'test' }, snapshot())
  const calls: Array<{ path: string | null; entryId: string | null; activity: 'viewing' | 'editing' }> = []
  const previous = globalThis.fetch
  let delay: (() => Promise<void>) | null = null
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/api/presence', 'Presence must never request a lease')
    const body = JSON.parse(String(init?.body)); calls.push(body)
    if (delay) await delay()
    session.filePresence = body.path ? { path: body.path, entryId: body.entryId, authorityId: `file:${body.path}`, activity: body.activity } : null
    return Response.json(snapshot())
  }
  return { client, calls, close: () => { globalThis.fetch = previous }, delay: (fn: (() => Promise<void>) | null) => { delay = fn } }
}
async function until(predicate: () => boolean) { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 1)); assert.ok(predicate()) }

await test('编辑意图与皮肤焦点只发送presence，旧工作区清理不清除新焦点', async () => {
  const f = fixture()
  try {
    const old = f.client.editing.claimFocus('src/hanshu/story.hs')
    const current = f.client.editing.claimFocus(index, { entryId: 'a' })
    f.client.editing.releaseFocus(old)
    f.client.editing.updateFocus(current, 'editing')
    await until(() => f.client.snapshot.session.filePresence?.activity === 'editing')
    assert.equal(f.client.snapshot.session.filePresence?.entryId, 'a')
    assert.deepEqual(f.calls, [{ path: index, entryId: 'a', activity: 'editing' }])
    assert.equal(f.client.leases.size, 0)
    f.client.editing.updateFocus(old, 'viewing')
    assert.equal(f.client.editing.focusActivity, 'editing')
    f.client.editing.releaseFocus(current)
    await until(() => f.client.snapshot.session.filePresence === null)
  } finally { f.close() }
})

await test('较早的慢presence响应不能回退当前资源，离线切换在重连后恢复最新焦点', async () => {
  const f = fixture()
  try {
    let unblock!: () => void
    f.delay(() => new Promise(resolve => { unblock = resolve }))
    const first = f.client.editing.claimFocus('src/hanshu/story.hs')
    await until(() => f.calls.length === 1)
    f.client.editing.claimFocus(index, { entryId: 'b', activity: 'editing' })
    f.client.editing.releaseFocus(first)
    f.delay(null); unblock()
    await until(() => f.client.snapshot.session.filePresence?.entryId === 'b')
    f.client.setStatus(false)
    f.client.editing.claimFocus(index, { entryId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(f.calls.length, 2)
    f.client.setStatus(true)
    await until(() => f.client.snapshot.session.filePresence?.entryId === 'c')
    assert.equal(f.client.snapshot.session.filePresence?.activity, 'viewing')
  } finally { f.close() }
})

console.log(`资源协作状态验证：${checks} 项通过`)
