/**
 * 活跃段撤销日志持久化验收（修正草案 D3/D4：刷新后待处理回滚仍可执行）。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-undo-journal.ts`
 *
 * 用 MemoryUndoJournalBackend 走与 IndexedDB 完全同构的序列化 / 体积保护路径；
 * 另验证 IndexedDB 后端在 Node 下可以 import 与构造，只有真正读写才要求浏览器环境。
 */

import assert from 'node:assert/strict'
import {
  IndexedDbUndoJournalBackend,
  MemoryUndoJournalBackend,
  UNDO_JOURNAL_LIMIT_BYTES,
  deserializeUndoJournal,
  serializeUndoJournal,
  undoJournalKey,
  type UndoJournalRecord,
} from '../src/agent/store/undoJournal'
import { undoJournalDbName } from '../src/agent/store/dbNames'
import type { UndoEntry } from '../src/agent/contracts'

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

/** 一条包含中文正文、语言通道、以及 before.content=null（新建）的日志 */
function sampleRecord(overrides: Partial<UndoJournalRecord> = {}): UndoJournalRecord {
  const entries: UndoEntry[] = [
    {
      kind: 'write',
      channel: 'source',
      path: '序章.hs',
      before: { content: '序章：雨夜\nnarrator:开场白', version: 'hash-before-1' },
      after: 'hash-after-1',
    },
    {
      kind: 'write',
      channel: 'lang',
      path: 'assets/zh_cn/lang_hs/序章.lang',
      before: { content: '{"d6e15f31":"开场白"}', version: 'hash-before-2' },
      after: 'hash-after-2',
    },
    {
      kind: 'create',
      channel: 'source',
      path: '新建草稿.hs',
      before: { content: null, version: null },
      after: 'hash-after-3',
    },
  ]
  return {
    scope: 'project-1',
    windowId: 'window-1',
    segmentId: 'segment-1',
    runKey: 'run-1',
    createdAt: 1_760_000_000_000,
    entries,
    ...overrides,
  }
}

await test('roundtrip：中文正文 / 语言通道 / before.content=null 都能原样读回', async () => {
  const backend = new MemoryUndoJournalBackend()
  const record = sampleRecord()
  const key = undoJournalKey(record.scope, record.windowId, record.segmentId)
  await backend.save(record)
  const loaded = await backend.load(key)
  assert.deepEqual(loaded, record, '持久化后应逐字段原样读回')
  assert.equal(loaded?.entries[2].before.content, null, 'before.content=null（新建）必须保持 null')
  assert.equal(loaded?.entries[1].channel, 'lang', '语言通道必须保留')
})

await test('未知 key → null；clear 后 → null', async () => {
  const backend = new MemoryUndoJournalBackend()
  assert.equal(await backend.load('不存在的 key'), null)

  const record = sampleRecord()
  const key = undoJournalKey(record.scope, record.windowId, record.segmentId)
  await backend.save(record)
  await backend.clear(key)
  assert.equal(await backend.load(key), null, 'clear 之后必须读不到')
  await backend.clear(key) // 幂等
})

await test('同一段重复保存 → 覆盖为最新一条（不累积）', async () => {
  const backend = new MemoryUndoJournalBackend()
  const first = sampleRecord({ runKey: 'run-1', createdAt: 1000 })
  await backend.save(first)
  const second = sampleRecord({ runKey: 'run-2', createdAt: 2000, entries: [first.entries[0]] })
  await backend.save(second)
  const loaded = await backend.load(undoJournalKey('project-1', 'window-1', 'segment-1'))
  assert.equal(loaded?.runKey, 'run-2')
  assert.equal(loaded?.createdAt, 2000)
  assert.equal(loaded?.entries.length, 1, '覆盖而不是追加')
})

await test('体积保护：序列化后 > 4 MB 抛错，且不破坏已有日志', async () => {
  const backend = new MemoryUndoJournalBackend()
  const small = sampleRecord()
  const key = undoJournalKey(small.scope, small.windowId, small.segmentId)
  await backend.save(small)

  const huge = sampleRecord({
    runKey: 'run-huge',
    entries: [
      {
        kind: 'write',
        channel: 'source',
        path: '大文件.hs',
        before: { content: 'x'.repeat(UNDO_JOURNAL_LIMIT_BYTES + 1024), version: 'hash-before' },
        after: 'hash-after',
      },
    ],
  })
  await assert.rejects(backend.save(huge), /过大|不持久化/, '超过 4 MB 必须拒绝持久化')
  const loaded = await backend.load(key)
  assert.equal(loaded?.runKey, 'run-1', '保存失败不得破坏上一次成功的日志')

  assert.ok(serializeUndoJournal(sampleRecord()).length > 0, '限制内必须能序列化')
  assert.equal(JSON.parse(serializeUndoJournal(sampleRecord())).runKey, 'run-1')
})

await test('key 稳定且不碰撞：同参数同 key，特殊字符 / 中文各自区分', async () => {
  assert.equal(
    undoJournalKey('project-1', 'window-1', 'segment-1'),
    undoJournalKey('project-1', 'window-1', 'segment-1'),
    '同参数必须得到同一个 key（刷新后才能找回）',
  )
  assert.notEqual(undoJournalKey('project-1', 'w', 's'), undoJournalKey('project-2', 'w', 's'))
  assert.notEqual(undoJournalKey('project-1', 'w', 's'), undoJournalKey('project-1', 'w2', 's'))
  assert.notEqual(undoJournalKey('project-1', 'w', 's'), undoJournalKey('project-1', 'w', 's2'))
  assert.notEqual(
    undoJournalKey('a:b', 'w', 's'),
    undoJournalKey('a_b', 'w', 's'),
    'key 用 URL 编码而不是 _ 清洗，避免 a:b 与 a_b 碰撞',
  )
  assert.match(undoJournalKey('序章工程', '窗口一', '段一'), /^%E5%BA%8F/)
  assert.equal(undoJournalKey('', '', ''), undoJournalKey('', '', ''))
})

await test('库名：按 scope 分区并清洗非法字符', async () => {
  assert.equal(undoJournalDbName('project:1/x'), 'hanshu.agent.undo.project_1_x')
  assert.equal(undoJournalDbName(''), 'hanshu.agent.undo.unknown')
})

await test('反序列化容错：坏数据当没有日志，混入的坏条目被过滤', async () => {
  assert.equal(deserializeUndoJournal('不是 JSON'), null)
  assert.equal(deserializeUndoJournal('{}'), null)
  assert.equal(deserializeUndoJournal('null'), null)
  const withGarbage = JSON.stringify({
    ...sampleRecord(),
    entries: [
      { kind: 'write', channel: 'source', path: '好.hs', before: { content: '旧', version: 'v1' }, after: 'v2' },
      { kind: 'write', channel: '???', path: '坏通道.hs', before: { content: null, version: null }, after: 'x' },
      { kind: 'write', path: '', before: { content: null, version: null }, after: 'x' },
      null,
    ],
  })
  const parsed = deserializeUndoJournal(withGarbage)
  assert.equal(parsed?.entries.length, 1, '坏条目应被过滤，只留合法条目')
  assert.equal(parsed?.entries[0].path, '好.hs')
})

await test('内存后端返回副本：改 load 结果不影响下一次 load', async () => {
  const backend = new MemoryUndoJournalBackend()
  const record = sampleRecord()
  await backend.save(record)
  const key = undoJournalKey(record.scope, record.windowId, record.segmentId)
  const first = await backend.load(key)
  assert.ok(first !== null)
  first.entries[0].before.content = '被外部篡改'
  first.entries[0].path = '篡改.hs'
  const second = await backend.load(key)
  assert.equal(second?.entries[0].before.content, '序章：雨夜\nnarrator:开场白')
  assert.equal(second?.entries[0].path, '序章.hs')
})

await test('IndexedDB 后端：Node 下可构造，只有真正读写才报 unavailable', async () => {
  const backend = new IndexedDbUndoJournalBackend({ scope: 'project-1' })
  await assert.rejects(backend.load('k'), /indexedDB/, 'Node 下没有 indexedDB，读写应明确报错')
  await assert.rejects(backend.save(sampleRecord()), /indexedDB/)
  await assert.rejects(backend.clear('k'), /indexedDB/)
  // 记录 scope 与库 scope 不一致时，序列化前就拒绝（不依赖浏览器环境）
  const scoped = new IndexedDbUndoJournalBackend({ scope: 'other-project' })
  await assert.rejects(scoped.save(sampleRecord()), /scope 不一致/)
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
