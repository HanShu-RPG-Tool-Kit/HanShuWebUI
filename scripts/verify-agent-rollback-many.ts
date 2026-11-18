/**
 * 多轮手动回滚验收（阶段 17：`RunUndoLog.rollbackMany`，消息左侧「回滚到此处」/ 输入框旁「回滚全部」）。
 *
 * 为什么单独一个脚本：`rollbackMany` 的核心难点不在单文件回放，而在**跨轮虚拟预演**——
 * 几轮 Run 改过同一个文件时，当前磁盘内容只等于最新一轮写出的版本；必须从新到旧把
 * "回滚后的内容"在内存里模拟出来，才能判断更早一轮是否还能安全回滚（文档 §7 + D4）。
 * 另外它必须是 all-or-nothing：任一文件冲突就一个文件都不动。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-rollback-many.ts`
 */
import assert from 'node:assert/strict'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { contentVersion } from '../src/agent/runtime/version'
import type { AgentFileWorld, UndoEntry } from '../src/agent/contracts'

let checks = 0
const failures: string[] = []

async function test(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

type FakeWorld = {
  world: AgentFileWorld
  sources: Map<string, string>
  langs: Map<string, string>
  dirty: Set<string>
  /** 经过 world.write / writeLang 的真实写盘次数：验证「已就位不重复写」只能靠它 */
  writes: number
}

/**
 * 假世界：源文件与语言草稿分开存（和真宿主一样，`.lang` 走 writeLang 而不是 write）。
 * `writeLang: false` 用来模拟宿主不支持语言回放（D3 的 unavailable 冲突）。
 */
function fakeWorld(options: { writeLang?: boolean } = {}): FakeWorld {
  const sources = new Map<string, string>()
  const langs = new Map<string, string>()
  const dirty = new Set<string>()
  const counters = { writes: 0 }
  const world: AgentFileWorld = {
    read: async (path) => {
      const content = sources.get(path) ?? langs.get(path)
      if (content === undefined) return null
      return { content, version: await contentVersion(content) }
    },
    isHumanDirty: (path) => dirty.has(path),
    write: async (path, content) => {
      counters.writes += 1
      if (content === null) sources.delete(path)
      else sources.set(path, content)
    },
    ...(options.writeLang === false
      ? {}
      : {
          writeLang: async (path: string, content: string | null) => {
            counters.writes += 1
            if (content === null) langs.delete(path)
            else langs.set(path, content)
          },
        }),
  }
  return {
    world,
    sources,
    langs,
    dirty,
    get writes() {
      return counters.writes
    },
  }
}

/** 与 arbiter 同序的一次写：先读（进日志）→ 宿主写入 → 记写后版本 */
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

/** 造两轮都改同一文件的场景：A → B（run-1）→ C（run-2），返回可直接喂给 rollbackMany 的日志 */
async function twoRuns(fake: FakeWorld): Promise<{ log: RunUndoLog; runs: Array<{ runId: string; entries: UndoEntry[] }> }> {
  const path = '序章.hs'
  fake.sources.set(path, 'A')
  const log = new RunUndoLog(fake.world)
  await writeSource(fake, log, 'run-1', path, 'B')
  await writeSource(fake, log, 'run-2', path, 'C')
  return {
    log,
    runs: [
      { runId: 'run-1', entries: log.entriesOf('run-1') },
      { runId: 'run-2', entries: log.entriesOf('run-2') },
    ],
  }
}

await test('两轮改同一文件：跨轮回滚最终落回最早一次写前内容', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  const result = await log.rollbackMany(runs)
  assert.equal(result.ok, true, `两轮都安全时应成功：${JSON.stringify(result.conflicts)}`)
  assert.deepEqual(result.conflicts, [])
  assert.equal(fake.sources.get('序章.hs'), 'A', '跨轮回滚后必须是最早一轮的写前内容，而不是中间的 B')
  assert.equal(result.outcomes.length, 2, '两轮各写了一次，应有两条回放结论')
  for (const outcome of result.outcomes) {
    assert.equal(outcome.path, '序章.hs')
    assert.equal(outcome.action, 'restored')
  }
})

await test('只回滚较新一轮：文件停在中间版本，说明虚拟预演按轮取快照', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  const result = await log.rollbackMany([runs[1]])
  assert.equal(result.ok, true)
  assert.equal(fake.sources.get('序章.hs'), 'B', '只回滚第二轮应停在第一轮的写后内容')
  assert.equal(result.outcomes.length, 1)
})

await test('中间版本也能再滚回最早：先回滚新轮，再回滚旧轮', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  assert.equal((await log.rollbackMany([runs[1]])).ok, true)
  assert.equal(fake.sources.get('序章.hs'), 'B')
  const back = await log.rollbackMany([runs[0]])
  assert.equal(back.ok, true)
  assert.equal(fake.sources.get('序章.hs'), 'A', '第二轮已回滚后，第一轮仍应能回滚到 A')
})

await test('冲突 version_stale：文件被外部改过时整批失败，一个文件都不动', async () => {
  const fake = fakeWorld()
  const { runs } = await twoRuns(fake)
  const log = new RunUndoLog(fake.world)
  fake.sources.set('序章.hs', '外部改动')
  const result = await log.rollbackMany(runs)
  assert.equal(result.ok, false)
  assert.equal(result.conflicts.length > 0, true)
  assert.equal(result.conflicts[0].reason, 'version_stale')
  assert.equal(fake.sources.get('序章.hs'), '外部改动', '冲突时不能动文件')
  assert.ok(result.outcomes.every((outcome) => outcome.action === 'conflict'))
})

await test('冲突 human_editing：版本对不上且人类有未保存编辑时优先报 human_editing', async () => {
  const fake = fakeWorld()
  const { runs } = await twoRuns(fake)
  const log = new RunUndoLog(fake.world)
  fake.sources.set('序章.hs', '外部改动')
  fake.dirty.add('序章.hs')
  const result = await log.rollbackMany(runs)
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].reason, 'human_editing')
  assert.equal(fake.sources.get('序章.hs'), '外部改动')
})

await test('冲突 unavailable：宿主不支持语言草稿回放时，语言路径整批失败', async () => {
  const fake = fakeWorld({ writeLang: false })
  const path = 'assets/序章.lang'
  fake.langs.set(path, '新语言正文')
  const entries: UndoEntry[] = [
    {
      kind: 'write',
      channel: 'lang',
      path,
      before: { content: '旧语言正文', version: await contentVersion('旧语言正文') },
      after: await contentVersion('新语言正文'),
    },
  ]
  const log = new RunUndoLog(fake.world)
  const result = await log.rollbackMany([{ runId: 'run-lang', entries }])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].reason, 'unavailable')
  assert.equal(result.conflicts[0].channel, 'lang')
  assert.equal(fake.langs.get(path), '新语言正文', '不可用通道不能误写源文件')
  assert.equal(fake.sources.has(path), false)
})

await test('冲突 no_before_image：旧日志没有写前快照时拒绝回滚（绝不误删）', async () => {
  const fake = fakeWorld()
  fake.sources.set('序章.hs', '当前正文')
  const entries: UndoEntry[] = [
    {
      kind: 'write',
      channel: 'source',
      path: '序章.hs',
      before: { content: null, version: null },
      after: await contentVersion('当前正文'),
    },
  ]
  const log = new RunUndoLog(fake.world)
  const result = await log.rollbackMany([{ runId: 'run-legacy', entries }])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].reason, 'no_before_image')
  assert.equal(fake.sources.get('序章.hs'), '当前正文')
})

await test('all-or-nothing：一个文件冲突时，另一个本可回滚的文件也保持不动', async () => {
  const fake = fakeWorld()
  const good = '可回滚.hs'
  const bad = '被改过.hs'
  fake.sources.set(good, 'good-A')
  fake.sources.set(bad, 'bad-A')
  const log = new RunUndoLog(fake.world)
  await writeSource(fake, log, 'run-1', good, 'good-B')
  await writeSource(fake, log, 'run-1', bad, 'bad-B')
  // 只改坏其中一个文件：整批回滚必须放弃
  fake.sources.set(bad, 'bad-外部改动')

  const result = await log.rollbackMany([
    { runId: 'run-1', entries: log.entriesOf('run-1') },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].path, bad)
  assert.equal(fake.sources.get(good), 'good-B', '冲突时不能只回滚一半（all-or-nothing）')
  assert.equal(fake.sources.get(bad), 'bad-外部改动')
})

await test('已等于写前内容：同一轮重复回滚是幂等空操作，不产生写盘与结论', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  // 单轮回滚两次：第一次 C→B，第二次目标内容已就位（B）→ 无需再写
  const first = await log.rollbackMany([runs[1]])
  assert.equal(first.ok, true)
  assert.equal(first.outcomes.length, 1)
  const second = await log.rollbackMany([runs[1]])
  assert.equal(second.ok, true)
  assert.deepEqual(second.outcomes, [], '目标内容已就位时不该再写一次')
  assert.equal(fake.sources.get('序章.hs'), 'B')
})

/* ───────────────────────── forceMany：手动回滚失败后的「强制回滚」 ───────────────────────── */

await test('forceMany：两轮改同一文件时从新到旧写回，最终落回最早一次写前内容', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  const result = await log.forceMany(runs)
  assert.equal(fake.sources.get('序章.hs'), 'A', '强制回滚同样应落回最早一轮的写前内容')
  assert.equal(result.outcomes.length, 2, '两条写前快照都应各回放一次')
  for (const outcome of result.outcomes) {
    assert.equal(outcome.path, '序章.hs')
    assert.equal(outcome.action, 'restored')
  }
})

await test('forceMany：文件被外部改过（rollbackMany 会 version_stale）时仍按写前快照覆盖', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  fake.sources.set('序章.hs', '外部改动')
  const guarded = await log.rollbackMany(runs)
  assert.equal(guarded.ok, false, '前置：普通回滚应因版本不符被拒')
  const result = await log.forceMany(runs)
  assert.equal(fake.sources.get('序章.hs'), 'A', '强制回滚要丢弃 Agent 之后的编辑，写回最早写前内容')
  assert.equal(result.outcomes.length, 2)
})

await test('forceMany：人类有未保存编辑时照样覆盖（调用方已二次确认）', async () => {
  const fake = fakeWorld()
  const { log, runs } = await twoRuns(fake)
  fake.sources.set('序章.hs', '人类正在编辑的内容')
  fake.dirty.add('序章.hs')
  const guarded = await log.rollbackMany(runs)
  assert.equal(guarded.ok, false, '前置：普通回滚应因人类编辑被拒')
  await log.forceMany(runs)
  assert.equal(fake.sources.get('序章.hs'), 'A', '强制回滚不看 human-dirty')
})

await test('forceMany：无写前快照 / 语言通道不可用返回 skipped，其它条目照常恢复', async () => {
  const fake = fakeWorld({ writeLang: false })
  const path = '序章.hs'
  const legacy = '遗留.hs'
  const langPath = 'assets/序章.lang'
  fake.sources.set(path, '写后正文')
  fake.sources.set(legacy, '遗留正文')
  fake.langs.set(langPath, '新语言正文')
  const entries: UndoEntry[] = [
    {
      kind: 'write',
      channel: 'source',
      path: legacy,
      before: { content: null, version: null },
      after: await contentVersion('遗留正文'),
    },
    {
      kind: 'write',
      channel: 'source',
      path,
      before: { content: '写前正文', version: await contentVersion('写前正文') },
      after: await contentVersion('写后正文'),
    },
    {
      kind: 'write',
      channel: 'lang',
      path: langPath,
      before: { content: '旧语言正文', version: await contentVersion('旧语言正文') },
      after: await contentVersion('新语言正文'),
    },
  ]
  const log = new RunUndoLog(fake.world)
  const result = await log.forceMany([{ runId: 'run-mixed', entries }])

  assert.equal(result.outcomes.length, 3)
  const skipped = result.outcomes.filter((outcome) => outcome.action === 'skipped')
  assert.equal(skipped.length, 2, '无写前快照与语言通道不可用都必须显式报 skipped，不能静默成功')
  assert.deepEqual(
    skipped.map((outcome) => outcome.reason).sort(),
    ['no_before_image', 'unavailable'],
  )
  assert.equal(fake.sources.get(path), '写前正文', '能恢复的源文件仍要恢复')
  assert.equal(result.outcomes.find((outcome) => outcome.path === path)?.action, 'restored')
  assert.equal(fake.sources.get(legacy), '遗留正文', '没有写前快照时绝不能删/改文件')
  assert.equal(fake.langs.get(langPath), '新语言正文', '语言通道不可用时不能误写源文件')
  assert.equal(fake.sources.has(langPath), false)
})

await test('forceMany：当前内容已等于写前内容时报 finished，不重复写盘', async () => {
  const fake = fakeWorld()
  fake.sources.set('序章.hs', 'A')
  const log = new RunUndoLog(fake.world)
  await writeSource(fake, log, 'run-1', '序章.hs', 'B')
  // 已经是写前内容（例如人工改回）：强制回滚不应再写一次
  fake.sources.set('序章.hs', 'A')
  const writesBefore = fake.writes
  const result = await log.forceMany([
    { runId: 'run-1', entries: log.entriesOf('run-1') },
  ])
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.action),
    ['finished'],
  )
  assert.equal(fake.writes, writesBefore, '目标内容已就位时不得再写盘')
  assert.equal(fake.sources.get('序章.hs'), 'A')
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
