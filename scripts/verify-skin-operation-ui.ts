import assert from 'node:assert/strict'
import { captureFolderScope, folderSnapshot } from '../src/skin/local/operationSnapshot'
import { conflictEdits, inspectConflict, type ConflictInspection } from '../src/project/editConflicts'
import { ProjectDirectory, type FileEdit, type ProjectClient } from '../src/project/serviceClient'
import type { SkinApi } from '../src/skin/api/SkinApi'
import type { FolderWithStats, LibraryEntry } from '../src/skin/contracts/types'
import { SkinLibrarySession } from '../src/skin/local/SkinLibrary'
import { emptyLibrary } from '../src/skin/local/library'

let checks = 0
async function test(name: string, run: () => Promise<void> | void) { await run(); checks++; console.log(`通过：${name}`) }
const folder = (folderId: string, parentId: string | null = null): FolderWithStats => ({ folderId, parentId, name: folderId, sortOrder: 0, path: [folderId], directCount: 1, subtreeCount: 2 })
const entry = (entryId: string, folderId: string, revision: number) => ({ entryId, folderId, revision }) as LibraryEntry

await test('清空确认保存完整子树快照，排除其他文件夹并保留读取版本', async () => {
  const parent = folder('parent'), child = folder('child', 'parent'), outside = folder('outside')
  const seen: number[] = []
  const api = {
    async listFolders() { return { revision: 7, folders: [child, outside, parent] } },
    async listEntries(query: { page: number }) {
      seen.push(query.page)
      return { revision: 7, page: query.page, pageSize: 2, total: 3, entries: query.page === 1 ? [entry('a', 'parent', 4), entry('unrelated', 'outside', 2)] : [entry('b', 'child', 5)] }
    },
  } as SkinApi
  const captured = await captureFolderScope(api, 'parent')
  assert.deepEqual(seen, [1, 2])
  assert.deepEqual(captured.folders, [folderSnapshot(child), folderSnapshot(parent)])
  assert.deepEqual(captured.entries, [{ entryId: 'a', revision: 4 }, { entryId: 'b', revision: 5 }])
  parent.name = 'changed after confirmation'
  assert.equal(captured.folders[1].name, 'parent')
  assert.equal('subtreeCount' in captured.folders[0], false)
})

await test('分页期间远端库变化时拒绝形成混合范围，不进入删除确认', async () => {
  const api = {
    async listFolders() { return { revision: 7, folders: [folder('a')] } },
    async listEntries() { return { revision: 8, page: 1, pageSize: 200, total: 1, entries: [entry('new', 'a', 1)] } },
  } as unknown as SkinApi
  await assert.rejects(captureFolderScope(api, 'a'), /读取操作范围时皮肤库发生了变化/)
})

await test('文件夹已删除或分页不完整时拒绝清空范围', async () => {
  const api = {
    async listFolders() { return { revision: 7, folders: [folder('a')] } },
    async listEntries() { return { revision: 7, page: 1, pageSize: 200, total: 201, entries: [] } },
  } as unknown as SkinApi
  await assert.rejects(captureFolderScope(api, 'missing'), /文件夹已不存在/)
  await assert.rejects(captureFolderScope(api, 'a', { ...folder('a'), name: 'old name' }), /文件夹已被移动或修改/)
  await assert.rejects(captureFolderScope(api, 'a'), /未能完整读取/)
})

await test('语义皮肤操作无法进入文件全文冲突处理或绑定最新版本', async () => {
  for (const op of ['skin-entry-patch', 'skin-library-command'] as const) {
    const edit = { op, path: '.hanshu/skinmanager/library.json', data: JSON.stringify({ command: 'delete-entries' }) } as FileEdit
    const client = { transactions: { submission: () => [edit] } } as unknown as ProjectClient
    await assert.rejects(inspectConflict(client, 1), /不能将操作请求作为整个索引文件覆盖/)
    const forged = { rows: [{ edit }] } as unknown as ConflictInspection
    assert.throws(() => conflictEdits(forged), /不能将操作请求作为整个索引文件覆盖/)
  }
})

await test('慢初始化会话被远端刷新销毁时，不清空前一个窗口导入准备结果', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  let delayed = false
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const client = {
    connection: { url: 'http://jobs.test' },
    snapshot: { projectId: 'project-a', session: { subjectId: 'subject-a' } },
    async readSnapshot() {
      if (delayed) { enter(); await gate }
      return { file: new Blob([JSON.stringify(emptyLibrary())]), version: 'library-version' }
    },
  } as unknown as ProjectClient
  const key = `hanshu.skinImportJobs.v1:${JSON.stringify(['http://jobs.test', 'project-a', 'subject-a', '.hanshu/skinmanager'])}`
  storage.setItem(key, JSON.stringify({ seq: 1, jobs: [{ jobId: 'ready-job', seq: 1, state: 'ready', result: { skinCode: 'recoverable-code' } }], sources: [['ready-job', { kind: 'png-file', fileName: 'original.png' }]] }))
  const root = new ProjectDirectory(client, '')
  const first = new SkinLibrarySession(root), slow = new SkinLibrarySession(root), latest = new SkinLibrarySession(root)
  try {
    await first.init(); first.dispose()
    delayed = true
    const initializing = slow.init()
    await entered
    slow.dispose()
    delayed = false
    await latest.init()
    assert.equal(latest.getImport('ready-job').result?.skinCode, 'recoverable-code')
    release(); await initializing; slow.dispose()
    latest.dispose()
    const final = new SkinLibrarySession(root)
    await final.init()
    assert.equal(final.getImport('ready-job').result?.skinCode, 'recoverable-code')
    final.dispose()
  } finally {
    release(); first.dispose(); slow.dispose(); latest.dispose()
    if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
})

console.log(`皮肤操作 UI 边界：${checks} 项通过`)
