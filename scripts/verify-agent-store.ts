/**
 * Agent 运行时支撑层验收（运行时 §7 撤销日志 · §8 三工具协议 · §9 会话段与归档段）。
 *
 * 运行：node scripts/run-verification.mjs scripts/verify-agent-store.ts
 *
 * 覆盖内容哈希、锁表（含多路径原子与「锁不等待」）、Run 撤销日志的版本守卫、
 * 归档段库的不可变与「保留被引用父归档段」、windowId 认领与库名清洗。
 */
import assert from 'node:assert/strict'
import type {
  AgentFileWorld,
  LockDenial,
  LockResult,
  SnapshotInfo,
  VersionedFile,
} from '../src/agent/contracts'
import { contentVersion } from '../src/agent/runtime/version'
import { LockTable } from '../src/agent/runtime/lockTable'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { archiveDbName, segmentDbName } from '../src/agent/store/dbNames'
import { MemorySnapshotBackend, SnapshotStore } from '../src/agent/store/snapshotStore'
import { claimWindowId } from '../src/agent/store/windowId'
import { descendantSnapshotIds, forkEntryDrafts } from '../src/agent/store/archiveGraph'

let checks = 0
const failures: string[] = []

async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

/* ───────────────────────── 假世界 / 假浏览器 API ───────────────────────── */

type FakeWorld = {
  world: AgentFileWorld
  files: Map<string, string>
  /** 直接改盘：模拟人类手改、另一个 Run 写入、崩溃镜像恢复（不走 world.write） */
  set: (path: string, content: string) => void
  unset: (path: string) => void
  dirty: Set<string>
  writeLog: Array<{ path: string; content: string | null }>
}

function fakeWorld(initial: Record<string, string> = {}): FakeWorld {
  const files = new Map<string, string>(Object.entries(initial))
  const dirty = new Set<string>()
  const writeLog: Array<{ path: string; content: string | null }> = []
  const world: AgentFileWorld = {
    async read(path) {
      const content = files.get(path)
      return content === undefined ? null : { content, version: await contentVersion(content) }
    },
    isHumanDirty(path) {
      return dirty.has(path)
    },
    async write(path, content) {
      writeLog.push({ path, content })
      if (content === null) files.delete(path)
      else files.set(path, content)
    },
  }
  return {
    world,
    files,
    dirty,
    writeLog,
    set(path, content) {
      files.set(path, content)
    },
    unset(path) {
      files.delete(path)
    },
  }
}

async function readFile(world: AgentFileWorld, path: string): Promise<VersionedFile> {
  const file = await world.read(path)
  assert.ok(file !== null, `应能读到 ${path}`)
  return file
}

function denialOf(result: LockResult): LockDenial {
  if (result.locked) assert.fail('期望加锁被拒绝，实际授予了锁')
  return result
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise(resolve => {
    setTimeout(() => resolve('timeout'), ms)
  })
}

/* ───────────────────────── 1. 内容哈希 ───────────────────────── */

await test('内容哈希：同内容同版本、不同内容不同版本', async () => {
  const first = await contentVersion('序章：雨夜\n')
  const second = await contentVersion('序章：雨夜\n')
  const other = await contentVersion('序章：雨夜')
  assert.equal(first, second, '同内容必须得到同一个版本')
  assert.notEqual(first, other, '不同内容必须得到不同版本')
  assert.equal(first.length, 64, 'SHA-256 十六进制应为 64 个字符')
  assert.match(first, /^[0-9a-f]{64}$/, '版本必须是纯小写十六进制')
})

await test('内容哈希：改了又改回来，版本回到原值（不算冲突）', async () => {
  const fw = fakeWorld({ 'a.hs': '旧正文' })
  const original = await readFile(fw.world, 'a.hs')
  fw.set('a.hs', '临时改动')
  const changed = await readFile(fw.world, 'a.hs')
  fw.set('a.hs', '旧正文')
  const again = await readFile(fw.world, 'a.hs')
  assert.notEqual(changed.version, original.version, '中间改动必须改变版本')
  assert.equal(again.version, original.version, '改回同一内容后版本必须回到原值')
})

/* ───────────────────────── 2. 锁表 ───────────────────────── */

await test('lock：本 Run 没读过 → not_read，且回传当前内容', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  const result = denialOf(await table.acquire('run-a', ['a.hs']))
  assert.equal(result.reason, 'not_read')
  assert.equal(result.currentContent, '正文', '失败必须回传当前内容，模型才能一次往返自愈')
  assert.equal(result.currentVersion, await contentVersion('正文'))
  assert.ok(result.hint.length > 0, '失败必须给出 hint')
  assert.equal(table.isLocked('a.hs'), false, 'not_read 时不得登记锁')
})

await test('lock：读过但版本已变 → version_stale，且回传最新内容', async () => {
  const fw = fakeWorld({ 'a.hs': 'v1' })
  const table = new LockTable(fw.world)
  const first = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', first.version)
  fw.set('a.hs', 'v2')
  const result = denialOf(await table.acquire('run-a', ['a.hs']))
  assert.equal(result.reason, 'version_stale')
  assert.equal(result.currentContent, 'v2', '版本过期时回传最新正文')
  assert.equal(result.currentVersion, await contentVersion('v2'))
  assert.equal(table.isLocked('a.hs'), false)
})

await test('lock：人类有未保存编辑但版本未变 → 允许加锁（D8）', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  // world.read 会 flush 编辑器缓冲：读到的就是人类正在编辑的当前内容
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  fw.dirty.add('a.hs')
  const result = await table.acquire('run-a', ['a.hs'])
  assert.equal(result.locked, true, 'D8：锁只看版本，human-dirty 不再拒绝')
  assert.equal(table.isLocked('a.hs'), true)

  // 人类继续输入 → 内容真的变了 → version_stale（README/§9 D8）
  fw.set('a.hs', '人类继续输入的内容')
  const stale = denialOf(await table.acquire('run-a', ['a.hs']))
  assert.equal(stale.reason, 'version_stale')
  assert.equal(stale.currentContent, '人类继续输入的内容')
})

await test('lock：文件不存在且非 creating → not_found', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  fw.unset('a.hs')
  const result = denialOf(await table.acquire('run-a', ['a.hs']))
  assert.equal(result.reason, 'not_found')
  assert.equal(result.currentContent, undefined, '文件不存在时没有可回传的内容')
})

await test('lock：create 语义——名字不存在则授予，已存在则失败并提示改用 write', async () => {
  const fw = fakeWorld({ 'a.hs': '已有' })
  const table = new LockTable(fw.world)
  const granted = await table.acquire('run-a', ['新流程.hs'], { creating: true })
  assert.equal(granted.locked, true, 'create 应能占住不存在的名字')
  assert.equal(table.ownerOf('新流程.hs'), 'run-a')
  assert.equal(table.lockedVersion('新流程.hs'), '', 'create 锁没有内容版本')
  const result = denialOf(await table.acquire('run-a', ['a.hs'], { creating: true }))
  assert.equal(result.reason, 'already_exists', 'create 命中已存在必须给 already_exists（D6）')
  assert.match(result.hint, /write/, 'hint 必须指向 write')
  assert.equal(result.currentContent, '已有')
})

await test('lock：多路径原子——一个失败则其余全不持有', async () => {
  const fw = fakeWorld({ 'a.hs': 'A', 'b.hs': 'B' })
  const table = new LockTable(fw.world)
  const a = await readFile(fw.world, 'a.hs')
  const b = await readFile(fw.world, 'b.hs')
  table.noteRead('run-a', 'a.hs', a.version)
  table.noteRead('run-a', 'b.hs', b.version)
  table.noteRead('run-b', 'b.hs', b.version)
  assert.equal((await table.acquire('run-b', ['b.hs'])).locked, true, 'run-b 应先占住 b')
  const result = denialOf(await table.acquire('run-a', ['a.hs', 'b.hs']))
  assert.equal(result.reason, 'held')
  assert.equal(table.isLocked('a.hs'), false, '多路径失败时不得登记任何锁')
  assert.equal(table.ownerOf('a.hs'), null)
  assert.equal(table.ownerOf('b.hs'), 'run-b', '原有持有者不受影响')
})

await test('lock：写后锁仍在——refreshLocked 刷新版本但不释放（D2）', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  assert.equal((await table.acquire('run-a', ['a.hs'])).locked, true)
  assert.equal(table.lockedVersion('a.hs'), file.version)
  // 模拟宿主写完：内容变了，仲裁层用 refreshLocked 把锁的锚定版本刷成写后版本
  fw.set('a.hs', '改后')
  const written = await readFile(fw.world, 'a.hs')
  assert.equal(table.refreshLocked('run-a', 'a.hs', written), true)
  assert.equal(table.isLocked('a.hs'), true, '写成功不得释放锁')
  assert.equal(table.lockedVersion('a.hs'), written.version, '锁版本必须刷新成写后版本')
  assert.equal(table.lockInfo('a.hs')?.creating, false, 'create 锁写成功后转为普通锁')
  assert.equal(table.refreshLocked('run-b', 'a.hs', written), false, '别人的锁不能刷新')
})

await test('lock：release 只释放本 Run 的锁（幂等，不放别人的）', async () => {
  const fw = fakeWorld({ 'a.hs': 'A', 'b.hs': 'B' })
  const table = new LockTable(fw.world)
  const a = await readFile(fw.world, 'a.hs')
  const b = await readFile(fw.world, 'b.hs')
  table.noteRead('run-a', 'a.hs', a.version)
  table.noteRead('run-b', 'b.hs', b.version)
  assert.equal((await table.acquire('run-a', ['a.hs'])).locked, true)
  assert.equal((await table.acquire('run-b', ['b.hs'])).locked, true)
  assert.deepEqual(table.release('run-b', ['a.hs']), [], '不得释放别的 Run 的锁')
  assert.equal(table.ownerOf('a.hs'), 'run-a')
  assert.deepEqual(table.release('run-a', ['a.hs', 'a.hs']), ['a.hs'], '同一路径重复传入只释放一次')
  assert.deepEqual(table.release('run-a', ['a.hs']), [], '重复释放幂等')
  assert.equal(table.isLocked('b.hs'), true, '别人的锁不受影响')
})

await test('lock：releaseRound 兼容入口释放本 Run 全部锁，读记录保留', async () => {
  const fw = fakeWorld({ 'a.hs': 'A', 'b.hs': 'B' })
  const table = new LockTable(fw.world)
  const a = await readFile(fw.world, 'a.hs')
  const b = await readFile(fw.world, 'b.hs')
  table.noteRead('run-a', 'a.hs', a.version)
  table.noteRead('run-a', 'b.hs', b.version)
  assert.equal((await table.acquire('run-a', ['a.hs', 'b.hs'])).locked, true)
  const released = table.releaseRound('run-a')
  assert.deepEqual(released.slice().sort(), ['a.hs', 'b.hs'], 'releaseRound 释放本 Run 全部锁')
  assert.equal(table.isLocked('a.hs'), false)
  assert.equal(table.isLocked('b.hs'), false)
  assert.equal(table.readVersion('run-a', 'a.hs'), a.version, '读记录必须保留')
  assert.equal((await table.acquire('run-a', ['b.hs'])).locked, true, '读记录还在，可直接再锁')
})

await test('lock：releaseRun 释放全部锁并丢掉读记录（生命周期 ③）', async () => {
  const fw = fakeWorld({ 'a.hs': 'A' })
  const table = new LockTable(fw.world)
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  assert.equal((await table.acquire('run-a', ['a.hs'])).locked, true)
  assert.deepEqual(table.releaseRun('run-a'), ['a.hs'])
  assert.equal(table.isLocked('a.hs'), false)
  const again = denialOf(await table.acquire('run-a', ['a.hs']))
  assert.equal(again.reason, 'not_read', 'Run 结束后读记录必须清空')
})

await test('lock：lockInfo / lockedPaths 给仲裁层与 UI 用', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  assert.equal(table.lockInfo('a.hs'), null, '未持锁时 lockInfo 返回 null')
  assert.equal((await table.acquire('run-a', ['a.hs'])).locked, true)
  const info = table.lockInfo('a.hs')
  assert.ok(info !== null)
  assert.equal(info.runId, 'run-a')
  assert.equal(info.version, file.version)
  assert.equal(info.creating, false)
  assert.deepEqual(table.lockedPaths(), ['a.hs'])
  assert.equal(table.ownerOf('a.hs'), 'run-a')
})

await test('lock：锁不等待——另一个 Run 持锁时立即失败，不挂起', async () => {
  const fw = fakeWorld({ 'a.hs': '正文' })
  const table = new LockTable(fw.world)
  const file = await readFile(fw.world, 'a.hs')
  table.noteRead('run-a', 'a.hs', file.version)
  table.noteRead('run-b', 'a.hs', file.version)
  assert.equal((await table.acquire('run-b', ['a.hs'])).locked, true)
  const outcome = await Promise.race([table.acquire('run-a', ['a.hs']), delay(50)])
  assert.notEqual(outcome, 'timeout', 'acquire 不得等待锁释放（§11 第 11 条：锁不等待）')
  assert.equal((outcome as LockResult).locked, false)
})

/* ───────────────────────── 3. Run 撤销日志 ───────────────────────── */

await test('runUndo：Run 成功 discard 后回滚为空', async () => {
  const fw = fakeWorld({ 'a.hs': '旧' })
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-1', 'a.hs', 'source')
  await fw.world.write('a.hs', '新')
  log.recordWrite('run-1', 'a.hs', 'source', { content: '新', version: await contentVersion('新') })
  assert.equal(log.has('run-1'), true, '真正写过的文件应有可回放条目')
  log.discard('run-1')
  assert.equal(log.has('run-1'), false)
  assert.deepEqual(await log.rollback('run-1'), [], '成功 Run 丢弃日志后不应回放')
  assert.equal(fw.files.get('a.hs'), '新', '成功 Run 的写入必须保留')
})

await test('runUndo：失败时逆序回放，恢复旧内容', async () => {
  const fw = fakeWorld({ 'a.hs': 'A0', 'b.hs': 'B0' })
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-2', 'a.hs', 'source')
  await fw.world.write('a.hs', 'A1')
  log.recordWrite('run-2', 'a.hs', 'source', { content: 'A1', version: await contentVersion('A1') })
  await log.recordBefore('run-2', 'b.hs', 'source')
  await fw.world.write('b.hs', 'B1')
  log.recordWrite('run-2', 'b.hs', 'source', { content: 'B1', version: await contentVersion('B1') })
  const outcomes = await log.rollback('run-2')
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action]),
    [['b.hs', 'restored'], ['a.hs', 'restored']],
    '必须按写入的逆序回放',
  )
  assert.equal(fw.files.get('a.hs'), 'A0')
  assert.equal(fw.files.get('b.hs'), 'B0')
})

await test('runUndo：预演发现版本冲突 → 不安全，且一个文件都不动（D3）', async () => {
  const fw = fakeWorld({ 'a.hs': 'A0' })
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-3', 'a.hs', 'source')
  await fw.world.write('a.hs', 'A1')
  log.recordWrite('run-3', 'a.hs', 'source', { content: 'A1', version: await contentVersion('A1') })
  // 锁已释放，人类随后改了同一文件
  fw.set('a.hs', '人类手改')
  const writesBefore = fw.writeLog.length

  const preflight = await log.preflight('run-3')
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: 'a.hs', channel: 'source', reason: 'version_stale' },
    ])
  }
  const outcomes = await log.rollback('run-3')
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action, outcome.reason]),
    [['a.hs', 'conflict', 'version_stale']],
  )
  assert.equal(fw.writeLog.length, writesBefore, '预演失败时不得动任何文件')
  assert.equal(fw.files.get('a.hs'), '人类手改', '被覆盖的文件绝不能自动回退')
})

await test('runUndo：force 强制恢复被后续改动覆盖的写前内容', async () => {
  const fw = fakeWorld({ 'a.hs': 'A0' })
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-force', 'a.hs', 'source')
  await fw.world.write('a.hs', 'A1')
  log.recordWrite('run-force', 'a.hs', 'source', {
    content: 'A1',
    version: await contentVersion('A1'),
  })
  fw.set('a.hs', '人类手改')
  const outcomes = await log.force('run-force')
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action]),
    [['a.hs', 'restored']],
  )
  assert.equal(fw.files.get('a.hs'), 'A0', '强制回滚必须覆盖后来的改动')
})

await test('runUndo：写前文件不存在 → 回放即删除（deleted）', async () => {
  const fw = fakeWorld({})
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-4', '新建.hs', 'source')
  await fw.world.write('新建.hs', '新内容')
  log.recordWrite('run-4', '新建.hs', 'source', {
    content: '新内容',
    version: await contentVersion('新内容'),
  })
  const outcomes = await log.rollback('run-4')
  assert.deepEqual(outcomes, [{ path: '新建.hs', channel: 'source', action: 'deleted' }])
  assert.equal(fw.files.has('新建.hs'), false, '新建的文件必须被删除')
  assert.equal(fw.writeLog[fw.writeLog.length - 1].content, null, '回放删除应写 null')
})

await test('runUndo：重复回放 → finished，不重复写盘', async () => {
  const fw = fakeWorld({ 'a.hs': 'A0' })
  const log = new RunUndoLog(fw.world)
  await log.recordBefore('run-5', 'a.hs', 'source')
  await fw.world.write('a.hs', 'A1')
  log.recordWrite('run-5', 'a.hs', 'source', { content: 'A1', version: await contentVersion('A1') })
  assert.deepEqual((await log.rollback('run-5')).map(outcome => outcome.action), ['restored'])
  const writesAfterFirst = fw.writeLog.length
  const outcomes = await log.rollback('run-5')
  assert.deepEqual(outcomes, [{ path: 'a.hs', channel: 'source', action: 'finished' }])
  assert.equal(fw.writeLog.length, writesAfterFirst, 'finished 不应再写盘')
})

/* ───────────────────────── 4. 归档段库 ───────────────────────── */

function snapshotInfo(id: string, createdAt: number, extra: Partial<SnapshotInfo> = {}): SnapshotInfo {
  return {
    id,
    scope: 'project-1',
    segmentId: 'seg-1',
    title: id,
    createdAt,
    entryCount: 1,
    ...extra,
  }
}

await test('snapshot：append 后 list 按时间升序、readEntries 一致、usage > 0', async () => {
  const store = new SnapshotStore(new MemorySnapshotBackend(), { scope: 'project-1' })
  await store.append(snapshotInfo('s2', 200), [{ kind: 'note', text: '二' }])
  await store.append(snapshotInfo('s1', 100), [{ kind: 'note', text: '一' }])
  assert.deepEqual((await store.list()).map(record => record.id), ['s1', 's2'], 'list 必须按 createdAt 升序')
  assert.deepEqual(await store.readEntries('s1'), [{ kind: 'note', text: '一' }])
  assert.ok((await store.usage()) > 0, '占用必须大于 0')
})

await test('snapshot：同 id 重复写抛错（不可变）', async () => {
  const store = new SnapshotStore(new MemorySnapshotBackend(), { scope: 'project-1' })
  await store.append(snapshotInfo('s1', 100), [])
  await assert.rejects(store.append(snapshotInfo('s1', 900), []), /不可修改|已存在/, '同 id 必须被拒绝')
  const kept = (await store.list()).find(record => record.id === 's1')
  assert.equal(kept?.createdAt, 100, '原记录不得被覆盖')
})

await test('snapshot：删除被引用的父归档段被拒，叶子可删', async () => {
  const store = new SnapshotStore(new MemorySnapshotBackend(), { scope: 'project-1' })
  await store.append(snapshotInfo('parent', 100), [{ kind: 'note', text: '根' }])
  await store.append(snapshotInfo('child', 200, { parentSnapshotId: 'parent' }), [])
  assert.deepEqual(await store.remove('parent'), { removed: false, reason: 'referenced' })
  assert.deepEqual(await store.remove('child'), { removed: true })
  assert.deepEqual(await store.remove('parent'), { removed: true })
  assert.equal((await store.list()).length, 0)
})

/* ───────────────────────── 5. windowId 与库名 ───────────────────────── */

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage = {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
  return { storage: storage as unknown as Storage, values }
}

function fakeLocks(held: Record<string, string> = {}) {
  const owners = new Map(Object.entries(held))
  const manager = {
    request(
      name: string,
      _options: { ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<unknown>,
    ) {
      if (owners.has(name)) return Promise.resolve(callback(null))
      owners.set(name, 'client-self')
      // 回调返回的 promise 不 settle = 本 document 一直持有该锁（与真实 Web Locks 同构）
      return Promise.resolve(callback({ name, mode: 'exclusive' }))
    },
    async query() {
      return {
        held: [...owners].map(([name, clientId]) => ({ name, clientId, mode: 'exclusive' })),
        pending: [],
      }
    },
  }
  return { locks: manager as unknown as Navigator['locks'], owners }
}

await test('windowId：sessionStorage 有值且抢到锁 → 沿用同一 id', async () => {
  const { storage } = fakeStorage({ 'hanshu.agent.windowId': 'window-a' })
  const { locks, owners } = fakeLocks()
  const id = await claimWindowId({ storage, locks })
  assert.equal(id, 'window-a', '抢到锁时必须沿用 sessionStorage 里的 windowId')
  assert.equal(storage.getItem('hanshu.agent.windowId'), 'window-a')
  assert.ok(owners.has('agent-window:window-a'), '必须真正持有 agent-window:<id> 锁')
  const again = await claimWindowId({ storage, locks })
  assert.equal(again, 'window-a', '同一 document 重复认领必须复用，不能把自己当复制标签页')
})

await test('windowId：抢不到锁（复制标签页）→ 新 UUID 并写回 storage', async () => {
  const { storage, values } = fakeStorage({ 'hanshu.agent.windowId': 'window-b' })
  const { locks } = fakeLocks({ 'agent-window:window-b': 'another-tab' })
  const id = await claimWindowId({ storage, locks })
  assert.notEqual(id, 'window-b', '抢不到锁必须换新 id')
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    '新 id 必须是 UUID',
  )
  assert.equal(values.get('hanshu.agent.windowId'), id, '新 id 必须写回 sessionStorage')
})

await test('dbNames：活跃段库/归档段库命名与非法字符清洗', async () => {
  assert.equal(segmentDbName('win-1', 'project:1/x'), 'hanshu.agent.session.win-1.project_1_x')
  assert.equal(archiveDbName('a b'), 'hanshu.agent.archive.a_b')
  assert.equal(segmentDbName('', ''), 'hanshu.agent.session.unknown.unknown')
  assert.equal(archiveDbName(''), 'hanshu.agent.archive.unknown')
})

/* ───────────────────────── 汇总 ───────────────────────── */

/* 归档段谱系：删归档段要连带删除所有直接/间接继承它的段 */
await test('归档段谱系：闭包包含自身与全部后代，不相干的归档不受影响', async () => {
  const snapshots = [
    { id: 'root', scope: 's', segmentId: 'seg1', title: '根', createdAt: 1, entryCount: 1 },
    { id: 'child', scope: 's', segmentId: 'seg2', parentSnapshotId: 'root', title: '子', createdAt: 2, entryCount: 1 },
    { id: 'grand', scope: 's', segmentId: 'seg3', parentSnapshotId: 'child', title: '孙', createdAt: 3, entryCount: 1 },
    { id: 'other', scope: 's', segmentId: 'seg4', title: '无关', createdAt: 4, entryCount: 1 },
  ]
  assert.deepEqual([...descendantSnapshotIds(snapshots, 'root')].sort(), ['child', 'grand', 'root'])
  assert.deepEqual([...descendantSnapshotIds(snapshots, 'child')].sort(), ['child', 'grand'])
  assert.deepEqual([...descendantSnapshotIds(snapshots, 'other')], ['other'])
  // 自引用/环也不会把闭包算错或死循环
  const cyclic = [
    { id: 'x', scope: 's', segmentId: 'seg5', parentSnapshotId: 'x', title: '环', createdAt: 5, entryCount: 1 },
  ]
  assert.deepEqual([...descendantSnapshotIds(cyclic, 'x')], ['x'])
})

await test('继承对话：只复制对话类条目，compaction/reset 跳过，且丢掉旧 id', async () => {
  const drafts = forkEntryDrafts([
    { id: 11, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: '问' }] },
    { id: 12, conversationId: 1, kind: 'pi.compaction', model: [{ role: 'user', content: '摘要' }] },
    { id: 13, conversationId: 1, kind: 'pi.assistant', model: [{ role: 'assistant' }] },
    { id: 14, conversationId: 1, kind: 'pi.tool-result', model: [{ role: 'toolResult' }] },
    { id: 15, conversationId: 1, kind: 'pi.reset' },
    { id: 16, conversationId: 1, kind: 'app.note', data: { x: 1 } },
  ])
  assert.deepEqual(drafts.map((d) => d.kind), ['pi.user', 'pi.assistant', 'pi.tool-result'])
  assert.ok(drafts.every((d) => !('id' in d) && !('conversationId' in d)), '新段自己分配 id')
})

if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join(' / ')}`)
  process.exitCode = 1
}
console.log(`通过 ${checks} 项`)
