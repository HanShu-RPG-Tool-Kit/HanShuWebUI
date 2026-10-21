import assert from 'node:assert/strict'
import { SkinLibrarySession } from '../src/skin/local/SkinLibrary'
import { emptyLibrary } from '../src/skin/local/library'
import { encodeShareCode } from '../src/skin/local/codec'
import { ProjectDirectory, ProjectClient, setProjectClient, type FileEdit } from '../src/project/serviceClient'
import { createVoiceDiskSink } from '../src/project/voiceDiskSink'
import { createVoiceOps } from '../src/i18n/voiceOps'
import { createScript, sourcePathOf, type Workspace } from '../src/workspace'
import { ServiceError } from '../src/collab/protocol'
import { attachReconciliation, captureWorkspaceEdit, reconcileSourceEdits } from '../src/project/reconcileEdits'
import { getProjectSession, setProjectSession } from '../src/project/projectSession'
import { sha256Hex } from '../src/project/crypto'

const indexPath = '.hanshu/skinmanager/library.json'
const bytes = async (data: FileEdit['data']) => typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data ?? new Uint8Array()
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { resolve, promise } }
function fixture() {
  const files = new Map<string, Uint8Array>([[indexPath, new TextEncoder().encode(JSON.stringify(emptyLibrary()))]])
  const batches: FileEdit[][] = []
  let beforeCommit = async () => {}
  const client = {
    writable: true,
    entry(path: string) {
      if (files.has(path)) return { path, kind: 'file', version: 'test-version' }
      if ([...files.keys()].some(file => file.startsWith(path + '/'))) return { path, kind: 'directory', version: 'dir-version' }
      return undefined
    },
    get tree() {
      const paths = new Set<string>()
      for (const path of files.keys()) { const parts = path.split('/'); for (let n = 1; n <= parts.length; n++) paths.add(parts.slice(0, n).join('/')) }
      return { revision: 1, entries: [...paths].map(path => this.entry(path)) }
    },
    async read(path: string) { const data = files.get(path); if (!data) throw new ServiceError('not_found', `Missing test file ${path}`); return new File([data as BlobPart], path.split('/').at(-1)!) },
    async apply(edits: FileEdit[]) {
      batches.push(edits.map(edit => ({ ...edit })))
      await beforeCommit()
      for (const edit of edits) {
        if (edit.op === 'write') files.set(edit.path, await bytes(edit.data))
        if (edit.op === 'remove') files.delete(edit.path)
      }
    },
  }
  return { files, batches, root: new ProjectDirectory(client as unknown as ProjectClient, ''), setBeforeCommit: (fn: () => Promise<void>) => { beforeCommit = fn } }
}

let checks = 0
async function test(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`通过：${name}`) }

await test('皮肤索引提交期间隐藏未确认修改，失败恢复原索引', async () => {
  const f = fixture(); const session = new SkinLibrarySession(f.root); await session.init()
  const gate = deferred(); f.setBeforeCommit(() => gate.promise)
  const creating = session.createFolder({ name: 'pending' }); await Promise.resolve(); await Promise.resolve()
  assert.equal(session.listFolders().folders.length, 0)
  gate.resolve(); const folder = await creating
  assert.equal(session.listFolders().folders.length, 1)
  f.setBeforeCommit(async () => { throw new Error('locked') })
  await assert.rejects(session.deleteFolder(folder.folderId), /locked/)
  assert.equal(session.listFolders().folders[0].name, 'pending')
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(indexPath))).folders.length, 1)
  session.dispose()
})

await test('并行皮肤变更串行化，不覆盖上一笔已确认索引', async () => {
  const f = fixture(); const session = new SkinLibrarySession(f.root); await session.init()
  await Promise.all([session.createFolder({ name: 'one' }), session.createFolder({ name: 'two' })])
  assert.deepEqual(session.listFolders().folders.map(folder => folder.name).sort(), ['one', 'two'])
  assert.equal(f.batches.length, 2)
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(indexPath))).folders.length, 2)
  session.dispose()
})

await test('皮肤导入校验只留草稿，保存对象和索引为同一事务，失败可保留原导入重试', async () => {
  const f = fixture(); const session = new SkinLibrarySession(f.root); await session.init()
  const { skinCode } = await encodeShareCode('classic', { flags: 0, width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4).fill(255) })
  const { jobId } = await session.startImportSkinCode(skinCode)
  assert.equal(session.getImport(jobId).state, 'ready')
  assert.equal([...f.files.keys()].some(path => path.endsWith('.skin')), false)
  f.setBeforeCommit(async () => { throw new Error('disk failure') })
  await assert.rejects(session.saveEntry({ jobId, name: 'test' }), /disk failure/)
  assert.equal(JSON.parse(new TextDecoder().decode(f.files.get(indexPath))).entries.length, 0)
  f.setBeforeCommit(async () => {})
  const entry = await session.saveEntry({ jobId, name: 'test' })
  const submitted = f.batches.at(-1)!
  assert.equal(submitted.length, 2)
  assert.ok(submitted.some(edit => edit.path.endsWith(`/${entry.skinId}.skin`)))
  assert.ok(submitted.some(edit => edit.path === indexPath))
  session.dispose()
})

await test('皮肤清理将索引版本校验和所有对象删除组成一笔事务', async () => {
  const f = fixture(); const session = new SkinLibrarySession(f.root); await session.init()
  f.files.set('.hanshu/skinmanager/objects/aa/aabb.skin', new Uint8Array([1]))
  f.files.set('.hanshu/skinmanager/cache/png/aabb.png', new Uint8Array([2]))
  const result = await session.gcOrphans()
  assert.equal(result.removedObjects, 1)
  assert.equal(f.batches.length, 1)
  assert.ok(f.batches[0].some(edit => edit.path === indexPath && edit.op === 'write'))
  assert.ok(f.batches[0].some(edit => edit.path.endsWith('aabb.skin') && edit.op === 'remove'))
  session.dispose()
})

await test('音频替换将 ogg 写入与 ref 删除放在同一批次', async () => {
  const f = fixture(); const stem = 'assets/zh_cn/voice_hs/a/line'
  f.files.set(`${stem}.ref`, new TextEncoder().encode('assets/shared.ogg'))
  await createVoiceDiskSink(f.root).replace(`${stem}.ogg`, new Uint8Array([1, 2]), 'audio/ogg', [`${stem}.ref`])
  assert.equal(f.batches.length, 1)
  assert.deepEqual(f.batches[0].map(edit => [edit.op, edit.path]), [['remove', `${stem}.ref`], ['write', `${stem}.ogg`]])
})

await test('配音删除被 S 拒绝时不删除界面元数据或缓存', async () => {
  const f = fixture(); const path = 'assets/zh_cn/voice_hs/a/line.ogg'
  f.files.set(path, new Uint8Array([1])); f.setBeforeCommit(async () => { throw new Error('locked') })
  let commits = 0
  const workspace = { packages: [{ id: 'pkg', assets: [{ id: 'voice', path }] }] } as Workspace
  const ops = createVoiceOps({
    getWorkspace: () => workspace, commit: () => { commits++ },
    activePackage: () => workspace.packages[0], projectHandle: () => f.root,
    library: () => null, refresh: () => {}, notify: () => {},
  })
  await assert.rejects(ops.removeAssetEverywhere('pkg', [path]), /locked/)
  assert.equal(commits, 0)
  assert.ok(f.files.has(path))
})

const sourceWorkspace = (): Workspace => ({ packages: [{ id: 'pkg', name: 'project', collapsed: false, assetsCollapsed: false, scripts: [createScript('a.hs', 'old draft'), createScript('b.hs', 'other')], assets: [], assetFolders: [] }], activeScriptId: null, activeAssetId: null })

await test('重试移动源文件及正文后更新同一视图，不覆盖等待期间另一个文件的编辑', async () => {
  const before = sourceWorkspace()
  const edits: FileEdit[] = [
    captureWorkspaceEdit(before, { op: 'move', path: 'src/hanshu/a.hs', destination: 'src/hanshu/renamed.hs' }),
    captureWorkspaceEdit(before, { op: 'write', path: 'src/hanshu/renamed.hs', data: 'saved properties' }),
  ]
  const live = structuredClone(before); live.packages[0].scripts[1].content = 'newer unrelated draft'
  const next = reconcileSourceEdits(live, edits)
  assert.equal(next.packages[0].scripts.find(file => file.name === 'renamed.hs')?.content, 'saved properties')
  assert.equal(next.packages[0].scripts.find(file => file.name === 'b.hs')?.content, 'newer unrelated draft')
  assert.equal(next.packages[0].scripts.some(file => file.name === 'a.hs'), false)
})

await test('重试删除或保存时保留提交后继续输入的草稿', async () => {
  const before = sourceWorkspace()
  const removing = captureWorkspaceEdit(before, { op: 'remove', path: 'src/hanshu/a.hs' })
  const writing = captureWorkspaceEdit(before, { op: 'write', path: 'src/hanshu/a.hs', data: 'old draft' })
  const live = structuredClone(before); live.packages[0].scripts[0].content = 'newer draft'
  for (const edit of [removing, writing]) {
    const next = reconcileSourceEdits(live, [edit])
    assert.equal(next.packages[0].scripts.find(file => sourcePathOf(file) === edit.path)?.content, 'newer draft')
  }
})

await test('多文件冲突处理采用服务器或合并正文，只投影确认时捕获的本地版本', async () => {
  const before = sourceWorkspace()
  const edits = [
    captureWorkspaceEdit(before, { op: 'write', path: 'src/hanshu/a.hs', data: 'server inspected', adopt: true }),
    captureWorkspaceEdit(before, { op: 'write', path: 'src/hanshu/b.hs', data: 'manual merged' }),
  ]
  const next = reconcileSourceEdits(before, edits)
  assert.deepEqual(next.packages[0].scripts.map(file => file.content), ['server inspected', 'manual merged'])
  const capturedAgain = captureWorkspaceEdit(next, edits[0])
  assert.equal(capturedAgain.localContents?.['src/hanshu/a.hs'], 'old draft')
})

await test('源文件改名在查询关联计划前冻结本地版本，网络等待不吞后续输入', async () => {
  let workspace = sourceWorkspace()
  const client = new ProjectClient({ url: 'http://test.invalid', token: '' }, { role: 'editor', projectId: 'test', session: { subjectId: 'subject' } } as never)
  client.baseline.set('src/hanshu/a.hs', 'read-before-plan')
  client.onCapture = edit => captureWorkspaceEdit(workspace, edit)
  let edits: FileEdit[] = []
  client.apply = async batch => { edits = batch }
  const oldFetch = globalThis.fetch
  const gate = deferred()
  globalThis.fetch = async () => { await gate.promise; return new Response(JSON.stringify([{ path: 'src/hanshu/a.hs', destination: 'src/hanshu/renamed.hs' }])) }
  try {
    const saving = client.sourceCommand('src/hanshu/a.hs', 'src/hanshu/renamed.hs', 'old draft')
    workspace = structuredClone(workspace); workspace.packages[0].scripts[0].content = 'typed during plan'
    client.baseline.set('src/hanshu/a.hs', 'peer-version-during-plan')
    gate.resolve(); await saving
    assert.equal(edits[0].localContents?.['src/hanshu/a.hs'], 'old draft')
    assert.equal(edits[0].version, 'read-before-plan', 'A peer refresh must not rebase an already chosen rename payload')
    assert.equal(edits.at(-1)?.version, null)
    const projected = reconcileSourceEdits(workspace, edits)
    assert.equal(projected.packages[0].scripts.find(file => file.name === 'a.hs')?.content, 'typed during plan')
    assert.equal(projected.packages[0].scripts.find(file => file.name === 'renamed.hs')?.content, 'old draft')
  } finally { globalThis.fetch = oldFetch }
})

await test('重载已读到较新服务器正文时，旧回执不能把它误标为本地草稿', async () => {
  const before = sourceWorkspace()
  const edit = captureWorkspaceEdit(before, { op: 'write', path: 'src/hanshu/a.hs', data: 'old draft' })
  const serverContent = 'newer server version'
  const version = await sha256Hex(new TextEncoder().encode(serverContent))
  const client = new ProjectClient({ url: 'http://test.invalid', token: '' }, { role: 'editor', projectId: 'test', session: { subjectId: 'subject' } } as never)
  client.tree = { revision: 9, entries: [{ path: edit.path, kind: 'file', version, size: serverContent.length }] }
  const live = structuredClone(before); live.packages[0].scripts[0].content = serverContent
  client.texts.set(edit.path, 'old draft'); client.baseline.set(edit.path, 'old-receipt-version')
  const previous = getProjectSession()
  setProjectClient(client)
  setProjectSession({ workspace: live, binding: { handle: client.root(), folderName: 'project', manifest: { version: 1, id: 'pkg', name: 'project' } } as never })
  attachReconciliation(client)
  try {
    await client.onCommitted!([edit], true)
    assert.equal(client.texts.get(edit.path), serverContent)
    assert.equal(client.baseline.get(edit.path), version)
    assert.equal(client.transactions.getSnapshot().pendingPaths.includes(edit.path), false)
    const changed = structuredClone(getProjectSession().workspace); changed.packages[0].scripts[0].content = 'new local draft'
    setProjectSession({ workspace: changed }); client.texts.set(edit.path, 'old draft'); client.baseline.set(edit.path, 'old-receipt-version')
    await client.onCommitted!([edit], true)
    assert.equal(getProjectSession().workspace.packages[0].scripts[0].content, 'new local draft')
    assert.equal(client.baseline.get(edit.path), 'old-receipt-version')
  } finally { setProjectClient(null); setProjectSession(previous) }
})

console.log(`编辑器事务边界：${checks} 项通过`)
