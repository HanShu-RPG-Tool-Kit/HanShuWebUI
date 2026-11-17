/**
 * Run 撤销日志验收（文档 §7 + 修正草案 D3：有序操作日志 / 预演 / 强制 / 语言回放）。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-undo.ts`
 *
 * 用内存假世界 + 真 RunUndoLog：不碰浏览器 API，但走的是生产同一套回放代码。
 */

import assert from 'node:assert/strict'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { contentVersion } from '../src/agent/runtime/version'
import type { AgentFileWorld, UndoEntry } from '../src/agent/contracts'

type WorldWrite = { path: string; content: string | null }

type FakeWorld = {
  world: AgentFileWorld
  sources: Map<string, string>
  langs: Map<string, string>
  dirty: Set<string>
  sourceWrites: WorldWrite[]
  langWrites: WorldWrite[]
}

function fakeWorld(options: { writeLang?: boolean } = {}): FakeWorld {
  const sources = new Map<string, string>()
  const langs = new Map<string, string>()
  const dirty = new Set<string>()
  const sourceWrites: WorldWrite[] = []
  const langWrites: WorldWrite[] = []
  const world: AgentFileWorld = {
    read: async (path) => {
      const content = sources.get(path) ?? langs.get(path)
      if (content === undefined) return null
      return { content, version: await contentVersion(content) }
    },
    isHumanDirty: (path) => dirty.has(path),
    write: async (path, content) => {
      sourceWrites.push({ path, content })
      if (content === null) sources.delete(path)
      else sources.set(path, content)
    },
    ...(options.writeLang === false
      ? {}
      : {
          writeLang: async (path: string, content: string | null) => {
            langWrites.push({ path, content })
            if (content === null) langs.delete(path)
            else langs.set(path, content)
          },
        }),
  }
  return { world, sources, langs, dirty, sourceWrites, langWrites }
}

/** 模拟「写前记快照 → 宿主写入 → 记写后版本」的完整一次写（与 arbiter 的调用顺序一致） */
async function writeSource(
  fake: FakeWorld,
  log: RunUndoLog,
  runId: string,
  path: string,
  content: string,
): Promise<void> {
  await log.recordBefore(runId, path, 'source')
  fake.sources.set(path, content)
  const file = await fake.world.read(path)
  assert.ok(file !== null, `写后应能读到 ${path}`)
  log.recordWrite(runId, path, 'source', file)
}

async function writeLang(
  fake: FakeWorld,
  log: RunUndoLog,
  runId: string,
  path: string,
  content: string,
): Promise<void> {
  await log.recordBefore(runId, path, 'lang')
  fake.langs.set(path, content)
  const file = await fake.world.read(path)
  assert.ok(file !== null, `写后应能读到 ${path}`)
  log.recordWrite(runId, path, 'lang', file)
}

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

/* ───────────────────────── 有序操作日志 ───────────────────────── */

await test('写前快照只记一次，after 取本 Run 最后一次写入的版本', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-1'

  await log.recordBefore(run, 'a.hs', 'source')
  await log.recordBefore(run, 'a.hs', 'source') // 重复记不应覆盖
  fake.sources.set('a.hs', 'A1')
  log.recordWrite(run, 'a.hs', 'source', { content: 'A1', version: await contentVersion('A1') })
  fake.sources.set('a.hs', 'A2')
  log.recordWrite(run, 'a.hs', 'source', { content: 'A2', version: await contentVersion('A2') })

  const entries = log.entriesOf(run)
  assert.equal(entries.length, 1, '同一路径只保留一条日志')
  assert.equal(entries[0].kind, 'write')
  assert.equal(entries[0].channel, 'source')
  assert.equal(entries[0].before.content, 'A0', '写前快照只记第一次')
  assert.equal(entries[0].before.version, await contentVersion('A0'))
  assert.equal(entries[0].after, await contentVersion('A2'), 'after 取最后一次写入')
})

await test('只记写前、没有真正写出 → 不产生日志条目，回滚为空', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  await log.recordBefore('run-pending', 'a.hs', 'source')
  assert.equal(log.has('run-pending'), false, '没写过的路径不该出现在撤销日志里')
  assert.deepEqual(log.entriesOf('run-pending'), [])
  assert.deepEqual(await log.rollback('run-pending'), [])
  assert.equal(fake.sources.get('a.hs'), 'A0', '没有写入时回滚不得改文件')
  assert.equal(fake.sourceWrites.length, 0)
})

await test('失败时按写入的逆序回放，恢复写前内容', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  fake.sources.set('b.hs', 'B0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-2'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  await writeSource(fake, log, run, 'b.hs', 'B1')

  const outcomes = await log.rollback(run)
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action, outcome.channel]),
    [
      ['b.hs', 'restored', 'source'],
      ['a.hs', 'restored', 'source'],
    ],
    '必须按写入逆序回放，并带上通道',
  )
  assert.equal(fake.sources.get('a.hs'), 'A0')
  assert.equal(fake.sources.get('b.hs'), 'B0')
})

await test('预演发现冲突 → 不安全，且一个文件都不动（all-or-nothing）', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  fake.sources.set('b.hs', 'B0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-3'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  await writeSource(fake, log, run, 'b.hs', 'B1')
  // 锁释放后人类改了 a.hs：a 不可安全恢复，b 本来可以 —— 但预演失败时两个都不能动
  fake.sources.set('a.hs', '人类手改')
  const writesBefore = fake.sourceWrites.length

  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: 'a.hs', channel: 'source', reason: 'version_stale' },
    ])
    assert.equal(preflight.entries.length, 2, '预演也要回传全部条目供失败卡片展示')
  }

  const outcomes = await log.rollback(run)
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action, outcome.reason]),
    [['a.hs', 'conflict', 'version_stale']],
  )
  assert.equal(fake.sourceWrites.length, writesBefore, '预演失败时不得写任何文件')
  assert.equal(fake.sources.get('a.hs'), '人类手改')
  assert.equal(fake.sources.get('b.hs'), 'B1', '本来可恢复的文件也不得被动')
})

await test('force 跳过版本守卫强制恢复每一条（逆序）', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  fake.sources.set('b.hs', 'B0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-4'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  await writeSource(fake, log, run, 'b.hs', 'B1')
  fake.sources.set('a.hs', '人类手改')

  const outcomes = await log.force(run)
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action]),
    [
      ['b.hs', 'restored'],
      ['a.hs', 'restored'],
    ],
  )
  assert.equal(fake.sources.get('a.hs'), 'A0', '强制回滚必须覆盖后来的改动')
  assert.equal(fake.sources.get('b.hs'), 'B0')
})

await test('写前文件不存在（create）→ 回放即删除', async () => {
  const fake = fakeWorld()
  const log = new RunUndoLog(fake.world)
  const run = 'run-create'
  await log.recordBefore(run, '新建.hs', 'source')
  fake.sources.set('新建.hs', '新内容')
  log.recordWrite(run, '新建.hs', 'source', {
    content: '新内容',
    version: await contentVersion('新内容'),
  })
  assert.equal(log.entriesOf(run)[0].kind, 'create')

  const outcomes = await log.rollback(run)
  assert.deepEqual(outcomes, [
    { path: '新建.hs', channel: 'source', action: 'deleted' },
  ])
  assert.equal(fake.sources.has('新建.hs'), false)
  assert.equal(fake.sourceWrites[fake.sourceWrites.length - 1].content, null, '删除要写 null')
})

/* ───────────────────────── 语言通道 ───────────────────────── */

await test('语言草稿走 writeLang 回放，不碰源文件通道', async () => {
  const fake = fakeWorld()
  const langPath = 'assets/zh_cn/lang_hs/序章.lang'
  fake.sources.set('序章.hs', '正文')
  fake.langs.set(langPath, '{"a":"旧"}')
  const log = new RunUndoLog(fake.world)
  const run = 'run-lang'
  await writeLang(fake, log, run, langPath, '{"a":"新"}')
  await writeSource(fake, log, run, '序章.hs', '正文改')

  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, true)
  const outcomes = await log.rollback(run)
  const langOutcome = outcomes.find(outcome => outcome.path === langPath)
  assert.equal(langOutcome?.channel, 'lang')
  assert.equal(langOutcome?.action, 'restored')
  assert.deepEqual(fake.langWrites, [{ path: langPath, content: '{"a":"旧"}' }], '语言必须走 writeLang')
  assert.equal(fake.langs.get(langPath), '{"a":"旧"}')
  assert.equal(fake.sources.get('序章.hs'), '正文', '源文件也要恢复，且走 world.write')
})

await test('语言通道不可用 → 预演报 unavailable，rollback 不动文件，force 跳过', async () => {
  const fake = fakeWorld({ writeLang: false })
  const langPath = 'assets/en_us/lang_hs/序章.lang'
  fake.langs.set(langPath, '{"a":"old"}')
  const log = new RunUndoLog(fake.world)
  const run = 'run-lang-unavailable'
  await log.recordBefore(run, langPath, 'lang')
  fake.langs.set(langPath, '{"a":"new"}')
  log.recordWrite(run, langPath, 'lang', {
    content: '{"a":"new"}',
    version: await contentVersion('{"a":"new"}'),
  })

  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: langPath, channel: 'lang', reason: 'unavailable' },
    ])
  }
  const outcomes = await log.rollback(run)
  assert.equal(outcomes[0].action, 'conflict')
  assert.equal(outcomes[0].reason, 'unavailable')
  assert.equal(fake.langs.get(langPath), '{"a":"new"}', '不可用通道不得改动内容')

  const forced = await log.force(run)
  assert.deepEqual(forced, [
    { path: langPath, channel: 'lang', action: 'skipped', reason: 'unavailable' },
  ])
  assert.equal(fake.langs.get(langPath), '{"a":"new"}')
})

/* ───────────────────────── 冲突判定 ───────────────────────── */

await test('没有写前快照 → no_before_image：预演冲突、force 跳过', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A1')
  const log = new RunUndoLog(fake.world)
  const run = 'run-missing'
  log.recordWrite(run, 'a.hs', 'source', {
    content: 'A1',
    version: await contentVersion('A1'),
  })
  const entries = log.entriesOf(run)
  assert.equal(entries.length, 1, '缺写前快照时也要补一条条目')
  assert.equal(entries[0].kind, 'write')
  assert.deepEqual(entries[0].before, { content: null, version: null })

  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: 'a.hs', channel: 'source', reason: 'no_before_image' },
    ])
  }
  assert.equal((await log.rollback(run))[0].reason, 'no_before_image')
  assert.equal(fake.sources.get('a.hs'), 'A1', '没有写前快照时绝不能删文件')

  assert.deepEqual(await log.force(run), [
    { path: 'a.hs', channel: 'source', action: 'skipped', reason: 'no_before_image' },
  ])
})

await test('人类正在编辑 → human_editing 冲突', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-dirty'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  // 版本既不等于写前也不等于写后（模拟人类缓冲已 flush 但仍有未提交草稿）
  fake.sources.set('a.hs', '人类输入中')
  fake.dirty.add('a.hs')

  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, false)
  if (!preflight.safe) assert.equal(preflight.conflicts[0].reason, 'human_editing')
})

/* ───────────────────────── 幂等与生命周期 ───────────────────────── */

await test('重复回放幂等：第二次全部 finished，不再写盘', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-repeat'
  await writeSource(fake, log, run, 'a.hs', 'A1')

  assert.deepEqual((await log.rollback(run)).map(outcome => outcome.action), ['restored'])
  const writesAfterFirst = fake.sourceWrites.length
  assert.deepEqual(await log.rollback(run), [
    { path: 'a.hs', channel: 'source', action: 'finished' },
  ])
  assert.equal(fake.sourceWrites.length, writesAfterFirst, 'finished 不应再写盘')

  assert.deepEqual(await log.force(run), [
    { path: 'a.hs', channel: 'source', action: 'finished' },
  ])
})

await test('entriesOf 返回副本；discard 后 has/entriesOf/rollback 都为空', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-lifecycle'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  assert.equal(log.has(run), true)

  const entries = log.entriesOf(run)
  entries[0].before.content = '被外部篡改'
  entries[0].path = '篡改.hs'
  assert.equal(log.entriesOf(run)[0].before.content, 'A0', 'entriesOf 必须返回副本')
  assert.equal(log.entriesOf(run)[0].path, 'a.hs')

  log.discard(run)
  assert.equal(log.has(run), false)
  assert.deepEqual(log.entriesOf(run), [])
  assert.deepEqual(await log.rollback(run), [])
  assert.equal(fake.sources.get('a.hs'), 'A1', '丢弃日志后不得再回放')
})

await test('空日志预演安全，回滚为空（不会误动文件）', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const preflight = await log.preflight('run-empty')
  assert.deepEqual(preflight, { safe: true, entries: [] })
  assert.deepEqual(await log.rollback('run-empty'), [])
  assert.equal(fake.sources.get('a.hs'), 'A0')
})

/* ───────────────────────── 刷新后恢复（D4 活跃段日志） ───────────────────────── */

await test('restore：刷新后 preflight / rollback 可执行，结果与刷新前一致', async () => {
  const langPath = 'assets/zh_cn/lang_hs/序章.lang'
  const before = fakeWorld()
  before.sources.set('a.hs', 'A0')
  before.langs.set(langPath, '{"a":"旧"}')
  const original = new RunUndoLog(before.world)
  const run = 'run-restore'
  await writeSource(before, original, run, 'a.hs', 'A1')
  await writeLang(before, original, run, langPath, '{"a":"新"}')

  // 序列化入口：必须是纯 JSON 数据（无 Map/Set），可直接塞进 IndexedDB
  const persisted = original.serialize(run)
  assert.deepEqual(JSON.parse(JSON.stringify(persisted)), persisted, '条目必须是纯 JSON 数据')
  assert.deepEqual(persisted, original.entriesOf(run), 'serialize 等价于 entriesOf')

  // 模拟刷新：新 world（磁盘内容还是 Run 写出的那一版）+ 新 RunUndoLog
  const after = fakeWorld()
  after.sources.set('a.hs', 'A1')
  after.langs.set(langPath, '{"a":"新"}')
  const restored = new RunUndoLog(after.world)
  restored.restore(run, JSON.parse(JSON.stringify(persisted)) as UndoEntry[])

  assert.deepEqual(restored.entriesOf(run), persisted, 'restore 后条目应与刷新前一致')
  const preflight = await restored.preflight(run)
  assert.equal(preflight.safe, true, '刷新后预演仍应通过')
  const outcomes = await restored.rollback(run)
  assert.deepEqual(
    outcomes.map(outcome => [outcome.path, outcome.action, outcome.channel]),
    [
      [langPath, 'restored', 'lang'],
      ['a.hs', 'restored', 'source'],
    ],
    '逆序回放与通道必须与刷新前一致',
  )
  assert.equal(after.sources.get('a.hs'), 'A0')
  assert.equal(after.langs.get(langPath), '{"a":"旧"}')
})

await test('restore：刷新前内容已被外部改动 → 预演判冲突，一个文件都不动', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const original = new RunUndoLog(fake.world)
  const run = 'run-restore-stale'
  await writeSource(fake, original, run, 'a.hs', 'A1')
  const persisted = JSON.parse(JSON.stringify(original.serialize(run))) as UndoEntry[]

  // 刷新后人类又改了同一文件
  const after = fakeWorld()
  after.sources.set('a.hs', '人类手改')
  const restored = new RunUndoLog(after.world)
  restored.restore(run, persisted)

  const preflight = await restored.preflight(run)
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: 'a.hs', channel: 'source', reason: 'version_stale' },
    ])
  }
  const writesBefore = after.sourceWrites.length
  const outcomes = await restored.rollback(run)
  assert.deepEqual(
    outcomes.map(outcome => [outcome.action, outcome.reason]),
    [['conflict', 'version_stale']],
  )
  assert.equal(after.sourceWrites.length, writesBefore, '刷新后的预演失败同样不得动文件')
  assert.equal(after.sources.get('a.hs'), '人类手改')
})

await test('restore：缺写前快照的条目重新识别为 no_before_image（force 跳过）', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A1')
  const persisted: UndoEntry[] = [
    // 旧实现留下的数据：kind=write 且 before 全 null
    {
      kind: 'write',
      channel: 'source',
      path: 'a.hs',
      before: { content: null, version: null },
      after: await contentVersion('A1'),
    },
  ]
  const restored = new RunUndoLog(fake.world)
  restored.restore('run-restore-missing', persisted)

  const preflight = await restored.preflight('run-restore-missing')
  assert.equal(preflight.safe, false)
  if (!preflight.safe) {
    assert.deepEqual(preflight.conflicts, [
      { path: 'a.hs', channel: 'source', reason: 'no_before_image' },
    ])
  }
  assert.deepEqual(await restored.force('run-restore-missing'), [
    { path: 'a.hs', channel: 'source', action: 'skipped', reason: 'no_before_image' },
  ])
  assert.equal(fake.sources.get('a.hs'), 'A1', '缺写前快照时绝不能误删文件')
})

await test('restore：覆盖旧日志、复位 replayed、非法条目被跳过', async () => {
  const fake = fakeWorld()
  fake.sources.set('a.hs', 'A0')
  const log = new RunUndoLog(fake.world)
  const run = 'run-restore-lifecycle'
  await writeSource(fake, log, run, 'a.hs', 'A1')
  const entries = log.entriesOf(run)
  await log.rollback(run)
  assert.deepEqual(
    await log.rollback(run),
    [{ path: 'a.hs', channel: 'source', action: 'finished' }],
    '回放过一次后重复回放是 finished',
  )

  // 刷新：把同一批条目装回去，replayed 必须复位（刷新后仍可回滚）
  log.restore(run, entries)
  assert.deepEqual(log.entriesOf(run), entries)
  const preflight = await log.preflight(run)
  assert.equal(preflight.safe, true)

  // 非法条目直接丢弃，不影响合法条目；重复 path 只保留第一条
  log.restore(run, [
    {
      kind: 'write',
      channel: '不存在的通道',
      path: '坏.hs',
      before: { content: null, version: null },
      after: 'x',
    },
    { kind: 'write', channel: 'source', path: 'a.hs', before: { content: 'A0', version: 'v0' }, after: 'v1' },
    { kind: 'write', channel: 'source', path: 'a.hs', before: { content: '重复', version: 'v9' }, after: 'v9' },
  ] as unknown as UndoEntry[])
  assert.deepEqual(
    log.entriesOf(run).map(entry => [entry.path, entry.before.content]),
    [['a.hs', 'A0']],
    '非法条目丢弃、重复 path 只留第一条',
  )

  log.restore(run, [])
  assert.equal(log.has(run), false, 'restore 空数组等于清空该 run 的日志')
  assert.deepEqual(log.entriesOf(run), [])
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
