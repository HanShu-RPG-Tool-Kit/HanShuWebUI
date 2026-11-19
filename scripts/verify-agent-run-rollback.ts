/**
 * 活跃段「历史 Run 回滚记录」持久化验收（阶段 17：消息左侧回滚图标 / 输入框旁回滚按钮）。
 *
 * 覆盖 `src/agent/store/runRollbackStore.ts`：
 * - Memory 后端 roundtrip：多轮记录、rolledBack 标注、坏数据逐条过滤（不可信数据不能把回滚入口弄坏）；
 * - 裁剪保护：单段最多 80 轮、序列化超过 8 MB 从最旧丢、只剩一轮仍超限则抛错（调用方降级不持久化）；
 * - 键稳定性：与 `undoJournalKey` 同一套编码，scope/window/segment 任一段变化都必须落到不同 key。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-run-rollback.ts`
 */
import assert from 'node:assert/strict'
import {
  IndexedDbRunRollbackBackend,
  MemoryRunRollbackBackend,
  RUN_ROLLBACK_LIMIT_BYTES,
  RUN_ROLLBACK_MAX_RUNS,
  deserializeRunRollback,
  runRollbackKey,
  serializeRunRollback,
  type RunRollbackRecord,
  type RunRollbackSegmentRecord,
} from '../src/plugins/agent/core/store/runRollbackStore'
import { undoJournalKey } from '../src/plugins/agent/core/store/undoJournal'
import type { UndoEntry } from '../src/plugins/agent/core/contracts'

let checks = 0
const failures: string[] = []

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

/** 一条与生产同构的写操作日志（版本只需是字符串，序列化层不校验哈希格式） */
function makeEntry(overrides: Partial<UndoEntry> = {}): UndoEntry {
  return {
    kind: 'write',
    channel: 'source',
    path: '序章.hs',
    before: { content: '旧正文', version: 'version-before' },
    after: 'version-after',
    ...overrides,
  }
}

function makeRun(
  runKey: string,
  createdAt: number,
  entries: UndoEntry[] = [makeEntry()],
  rolledBack?: boolean,
): RunRollbackRecord {
  return { runKey, userEntryId: `entry-${runKey}`, createdAt, entries, ...(rolledBack === true ? { rolledBack: true } : {}) }
}

function makeSegment(
  runs: RunRollbackRecord[],
  overrides: Partial<RunRollbackSegmentRecord> = {},
): RunRollbackSegmentRecord {
  return { scope: 'demo-scope', windowId: 'window-1', segmentId: 'segment-1', runs, ...overrides }
}

await test('runRollbackKey：与待处理回滚同一套编码，参数任一段变化都落到不同 key', () => {
  assert.equal(runRollbackKey('scope', 'window', 'segment'), runRollbackKey('scope', 'window', 'segment'))
  assert.equal(
    runRollbackKey('scope', 'window', 'segment'),
    undoJournalKey('scope', 'window', 'segment'),
    '回滚记录键必须与撤销日志键同构，存档/恢复才能一一对应',
  )
  assert.notEqual(runRollbackKey('scope-a', 'window', 'segment'), runRollbackKey('scope-b', 'window', 'segment'))
  assert.notEqual(runRollbackKey('scope', 'window-a', 'segment'), runRollbackKey('scope', 'window-b', 'segment'))
  assert.notEqual(runRollbackKey('scope', 'window', 'segment-a'), runRollbackKey('scope', 'window', 'segment-b'))
  // 段 id 里可能带冒号；编码后 `a:b` 与 `a_b` 不能撞到同一个 key
  assert.notEqual(runRollbackKey('scope', 'window', 'a:b'), runRollbackKey('scope', 'window', 'a_b'))
  // 空段回退 unknown，避免出现 `::` 结尾的残缺 key
  assert.equal(runRollbackKey('scope', 'window', '   '), runRollbackKey('scope', 'window', ''))
  assert.ok(runRollbackKey('', '', '').endsWith('unknown::unknown::unknown'))
})

await test('Memory 后端 roundtrip：多轮记录与 rolledBack 标注原样读回', async () => {
  const backend = new MemoryRunRollbackBackend()
  const record = makeSegment([
    makeRun('run-1', 1_000, [makeEntry(), makeEntry({ path: '章节/第二章.hs' })]),
    makeRun('run-2', 2_000, [makeEntry({ before: { content: null, version: null }, kind: 'create' })], true),
  ])
  await backend.save(record)

  const loaded = await backend.load(runRollbackKey(record.scope, record.windowId, record.segmentId))
  assert.ok(loaded, '刚写入的记录应能读回')
  assert.equal(loaded.runs.length, 2)
  assert.equal(loaded.runs[0].runKey, 'run-1')
  assert.equal(loaded.runs[0].entries.length, 2, '同一轮多文件改动都要保留')
  assert.equal(loaded.runs[0].entries[1].path, '章节/第二章.hs')
  assert.deepEqual(loaded.runs[1].entries[0].before, { content: null, version: null }, 'create 的写前影像是 null')
  assert.equal(loaded.runs[1].rolledBack, true, 'rolledBack 必须持久化（按钮置灰靠它）')
  assert.equal(loaded.runs[0].rolledBack, undefined, '未回滚的轮次不能凭空带上 rolledBack')

  // 副本语义：外部改读回的对象不能污染库里的记录
  loaded.runs[0].entries[0].before.content = '被篡改'
  const again = await backend.load(runRollbackKey(record.scope, record.windowId, record.segmentId))
  assert.equal(again?.runs[0].entries[0].before.content, '旧正文', 'load 必须返回副本')

  // 不同段互不覆盖
  const other = makeSegment([makeRun('run-x', 9_000)], { segmentId: 'segment-2' })
  await backend.save(other)
  assert.equal(
    (await backend.load(runRollbackKey('demo-scope', 'window-1', 'segment-1')))?.runs.length,
    2,
    '存另一段的记录不能覆盖本段',
  )
  assert.equal(
    (await backend.load(runRollbackKey('demo-scope', 'window-1', 'segment-2')))?.runs[0].runKey,
    'run-x',
  )

  await backend.clear(runRollbackKey('demo-scope', 'window-1', 'segment-1'))
  assert.equal(await backend.load(runRollbackKey('demo-scope', 'window-1', 'segment-1')), null)
  assert.ok(await backend.load(runRollbackKey('demo-scope', 'window-1', 'segment-2')), 'clear 只清指定段')
})

await test('反序列化：坏 JSON / 结构缺失返回 null，坏轮次与坏条目逐条过滤', () => {
  assert.equal(deserializeRunRollback('not json'), null)
  assert.equal(deserializeRunRollback('null'), null)
  assert.equal(deserializeRunRollback('[]'), null)
  assert.equal(deserializeRunRollback(JSON.stringify({ scope: 's', windowId: 'w' })), null, '缺 segmentId 视为坏记录')
  assert.equal(
    deserializeRunRollback(JSON.stringify({ scope: 's', windowId: 'w', segmentId: 'g', runs: {} })),
    null,
    'runs 不是数组视为坏记录',
  )

  const mixed = deserializeRunRollback(
    JSON.stringify({
      scope: 's',
      windowId: 'w',
      segmentId: 'g',
      runs: [
        {
          runKey: 'ok-run',
          userEntryId: 'entry-1',
          createdAt: 1,
          // 只有完整条目能留下：坏 kind / 缺 path / before 不是对象都被丢掉
          entries: [
            makeEntry(),
            { kind: 'nope', channel: 'source', path: 'x', before: { content: 'a', version: 'b' }, after: 'c' },
            { kind: 'write', channel: 'source', before: {}, after: 'c' },
            { kind: 'write', channel: 'source', path: 'y', before: null, after: 'c' },
          ],
        },
        { runKey: '', userEntryId: 'entry-2', createdAt: 2, entries: [] },
        { runKey: 'no-created-at', userEntryId: 'entry-3', entries: [] },
        { runKey: 'bad-entries', userEntryId: 'entry-4', createdAt: 3, entries: 'nope' },
        null,
      ],
    }),
  )
  assert.ok(mixed, '记录本身合法时不能整条丢弃')
  assert.equal(mixed.runs.length, 1, '坏轮次应被过滤')
  assert.equal(mixed.runs[0].runKey, 'ok-run')
  assert.equal(mixed.runs[0].entries.length, 1, '坏条目应被过滤')
  assert.equal(mixed.runs[0].rolledBack, undefined)
})

await test('裁剪：单段最多保留最新 80 轮，按 createdAt 升序落库', async () => {
  const backend = new MemoryRunRollbackBackend()
  const runs = Array.from({ length: RUN_ROLLBACK_MAX_RUNS + 1 }, (_, index) =>
    makeRun(`run-${index}`, index + 1),
  )
  await backend.save(makeSegment(runs))
  const loaded = await backend.load(runRollbackKey('demo-scope', 'window-1', 'segment-1'))
  assert.ok(loaded)
  assert.equal(loaded.runs.length, RUN_ROLLBACK_MAX_RUNS, '81 轮必须裁到 80 轮')
  assert.equal(loaded.runs[0].runKey, 'run-1', '应丢最旧的一轮（createdAt=1）')
  assert.equal(loaded.runs.at(-1)?.runKey, 'run-80', '最新一轮必须保留')
  for (let index = 1; index < loaded.runs.length; index++) {
    assert.ok(
      loaded.runs[index - 1].createdAt <= loaded.runs[index].createdAt,
      '持久化后必须按 createdAt 升序（回放从旧到新读）',
    )
  }
})

await test('体积保护：超过 8 MB 从最旧丢，保留的仍是最近几轮且不超上限', () => {
  const runs = Array.from({ length: 12 }, (_, index) =>
    makeRun(`run-${index}`, index + 1, [
      makeEntry({ before: { content: 'x'.repeat(900_000), version: 'version-before' } }),
    ]),
  )
  const text = serializeRunRollback(makeSegment(runs))
  assert.ok(
    new TextEncoder().encode(text).length <= RUN_ROLLBACK_LIMIT_BYTES,
    '序列化结果必须落在 8 MB 以内',
  )
  const parsed = deserializeRunRollback(text)
  assert.ok(parsed)
  assert.ok(parsed.runs.length < runs.length, '超限时应从最旧开始丢')
  assert.ok(parsed.runs.length > 0, '至少要保留最新一轮')
  assert.equal(parsed.runs.at(-1)?.runKey, 'run-11', '最新一轮永远保留')
  assert.equal(
    parsed.runs[0].runKey,
    `run-${runs.length - parsed.runs.length}`,
    '丢弃必须从最旧连续丢，不能挖空中间',
  )
})

await test('体积保护：只剩一轮仍超 8 MB 时抛错（调用方降级为不持久化）', () => {
  const huge = makeSegment([
    makeRun('run-huge', 1, [
      makeEntry({ before: { content: 'x'.repeat(RUN_ROLLBACK_LIMIT_BYTES + 1024), version: 'version-before' } }),
    ]),
  ])
  assert.throws(
    () => serializeRunRollback(huge),
    /回滚记录过大/,
    '单轮超限必须抛错，不能写半截记录',
  )
  assert.throws(() => serializeRunRollback(huge), /本轮不持久化/)
})

await test('IndexedDB 后端：scope 不一致时拒绝写入（防止串到别的工程分区）', async () => {
  const backend = new IndexedDbRunRollbackBackend({ scope: 'only-scope' })
  await assert.rejects(
    backend.save(makeSegment([], { scope: 'other-scope' })),
    /回滚记录 scope 不一致/,
    '记录 scope 与库 scope 不一致时必须拒绝',
  )
})

await test('IndexedDB 后端：Node 无 indexedDB 时读写明确报错，提示用内存后端', async () => {
  const backend = new IndexedDbRunRollbackBackend({ scope: 'demo-scope' })
  const key = runRollbackKey('demo-scope', 'window-1', 'segment-1')
  await assert.rejects(backend.load(key), /没有 indexedDB/)
  await assert.rejects(backend.save(makeSegment([])), /没有 indexedDB/)
  await assert.rejects(backend.clear(key), /没有 indexedDB/)
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
