/**
 * 语言资产的「锁覆盖 + 写前版本守卫」验收（对应线上故障三）。
 *
 * 回放的问题：agent 锁了 `.hs`、写译文成功；外部（另一个窗口/程序）随后回写了
 * `.lang`，源文件版本没变 —— 锁没拦住，也没有任何版本信号，agent 下一个 Run
 * 会心安理得地覆盖别人的译文。
 *
 * 现在的约定：
 * - 锁住源文件时，**已存在的派生语言资产**一起进锁表；
 * - `write_lang` / `delete_lang_keys` / `parse_hs` 写前逐个校验语言资产的版本；
 * - 外部改过 → 拒绝，提示重新 lock + list_lang_keys，**不触达宿主**。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-lang-lock.ts`
 */

import assert from 'node:assert/strict'
import { createFileWorld, RuntimeArbiter } from '../src/agent/pi/arbiter'
import { LockTable } from '../src/agent/runtime/lockTable'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { executeAgentTool, type AgentToolTarget } from '../src/agent/tools'
import { collectMissingTranslationWarnings } from '../src/agent/agentOps'
import type { AgentHost } from '../src/agent/contracts'

const SOURCE = '阿拉丁神灯.hs'
const LANG = 'assets/zh_cn/lang_hs/阿拉丁神灯.lang'
const RUN = 'run-lang'

function makeScene() {
  const sources = new Map<string, string>([
    [SOURCE, '第一幕：开场\nnarrator:d6e15f31//\n'],
  ])
  const assets = new Map<string, string>([[LANG, 'd6e15f31 # 旧译文\n']])
  let hostCalls = 0

  const host = {
    readFullSource: (source: string) => {
      const content = sources.get(source)
      return content === undefined
        ? { ok: false, error: `未找到文件：${source}` }
        : { ok: true, content }
    },
    readSource: (source: string) => host.readFullSource(source),
    isHumanDirty: () => false,
    derivedLangPaths: (source: string) =>
      sources.has(source) ? [LANG] : [],
    readAssetText: async (path: string) => assets.get(path) ?? null,
    readLangKeys: undefined,
    writeLang: async (_source: string, translations: Record<string, Array<{ key: string; text: string }>>) => {
      hostCalls += 1
      const entries = translations.zh_cn ?? []
      const next = { ...(assets.get(LANG) ?? {}) }
      // 简化：把文本串成 lang 格式
      let text = ''
      for (const entry of entries) next[entry.key] = entry.text
      for (const [key, value] of Object.entries(next)) text += `${key} # ${value}\r\n`
      assets.set(LANG, text)
      return { ok: true, writtenPaths: [LANG], saved: true }
    },
    writeSource: () => ({ ok: true }),
    deleteSource: async () => ({ ok: true }),
    createSource: () => ({ ok: true }),
    editSource: () => ({ ok: true }),
    renameSource: async () => ({ ok: true }),
    listSources: () => ({ ok: true, sources: [] }),
    validateSource: () => ({ ok: true }),
    getActiveFilePath: () => ({ ok: true }),
    listLocales: () => ({ ok: true, locales: [] }),
    listLangKeys: async () => ({ ok: true, entries: [] }),
    listVoiceStatus: async () => ({ ok: true, entries: [] }),
    deleteLangKeys: async () => ({ ok: true, writtenPaths: [LANG] }),
    parseHs: async () => ({ ok: true, writtenPaths: [LANG] }),
    unparseHs: async () => ({ ok: true }),
    checkExport: async () => ({ ok: true }),
  } as unknown as AgentHost

  const world = createFileWorld(host)
  const locks = new LockTable(world)
  const undo = new RunUndoLog(world)
  const arbiter = new RuntimeArbiter({ host, locks, undo, world, runKey: () => RUN })
  const target: AgentToolTarget = { host, arbiter }
  return {
    host,
    world,
    locks,
    arbiter,
    target,
    assets,
    sources,
    calls: () => hostCalls,
  }
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

const call = (name: string, args: Record<string, unknown>) =>
  executeAgentTool(
    // 每个用例自己的 target
    (call as unknown as { target?: AgentToolTarget }).target!,
    { function: { name, arguments: JSON.stringify(args) } },
  )

/** 全新场景里跑一段，保证用例互不干扰 */
async function withScene(body: (scene: ReturnType<typeof makeScene>) => Promise<void>) {
  const scene = makeScene()
  ;(call as unknown as { target?: AgentToolTarget }).target = scene.target
  try {
    await body(scene)
  } finally {
    await scene.arbiter.endRound()
  }
}

await test('锁源文件时，已存在的派生语言资产一起进锁表（外部改 .lang 有版本信号）', async () => {
  await withScene(async (scene) => {
    await scene.arbiter.read(SOURCE)
    const locked = await scene.arbiter.lock([SOURCE])
    assert.equal(locked.locked, true)
    assert.ok(
      scene.locks.lockedPaths().includes(LANG),
      `锁表应包含派生语言资产，实际：${scene.locks.lockedPaths().join(', ')}`,
    )
  })
})

await test('未持锁的 write_lang 被拒绝，且不触达宿主', async () => {
  await withScene(async (scene) => {
    const output = JSON.parse(await call('write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '新译文' }] },
    }))
    assert.equal(output.ok, false)
    assert.equal(scene.calls(), 0)
    assert.ok(String(output.hint).includes('lock_source'), output.hint)
  })
})

await test('持锁且语言文件没被别人改：写入成功，并更新 agent 持有的版本', async () => {
  await withScene(async (scene) => {
    await scene.arbiter.read(SOURCE)
    await scene.arbiter.lock([SOURCE])
    const output = JSON.parse(await call('write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '新译文' }] },
    }))
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(scene.calls(), 1)
    assert.deepEqual(output.writtenPaths, [LANG])
    assert.ok((scene.assets.get(LANG) ?? '').includes('新译文'))

    // 写后哈希自更新：同一 Run 里不再读也能重新拿到源文件与语言文件的锁
    const relocked = await scene.arbiter.lock([SOURCE])
    assert.equal(relocked.locked, true)
  })
})

await test('外部回写语言文件后：write_lang 以版本冲突被拒绝，宿主不被调用', async () => {
  await withScene(async (scene) => {
    await scene.arbiter.read(SOURCE)
    await scene.arbiter.lock([SOURCE])

    // 模拟另一个窗口/外部程序改了 .lang，源文件没动
    scene.assets.set(LANG, 'd6e15f31 # 别人的译文\n')

    const output = JSON.parse(await call('write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '我会覆盖别人的' }] },
    }))
    assert.equal(output.ok, false, JSON.stringify(output))
    assert.equal(scene.calls(), 0, '版本冲突时绝不能调用宿主写入')
    assert.ok(String(output.error).includes('外部修改'), output.error)
    assert.ok(String(output.hint).includes('lock_source'), output.hint)
    assert.equal(scene.assets.get(LANG), 'd6e15f31 # 别人的译文\n', '别人的译文必须原样保留')
  })
})

await test('导出预检会把「正文有键、语言文件没文本」列成警告（对应线上故障四）', async () => {
  const sources = [
    { name: SOURCE, content: 'narrator:d6e15f31//\nnarrator:4c81c0ad//\n' },
  ]
  const review = await collectMissingTranslationWarnings(
    sources,
    ['zh_cn', 'ja_jp'],
    async (_sourceName, locale) => (locale === 'zh_cn' ? { d6e15f31: '有译文' } : {}),
  )
  const zh = review.summaries.find((item) => item.locale === 'zh_cn')
  const ja = review.summaries.find((item) => item.locale === 'ja_jp')
  assert.equal(zh?.missing, 1, 'zh_cn 缺 1 个键')
  assert.equal(ja?.missing, 2, 'ja_jp 两句都缺')
  assert.equal(review.warnings.length, 2)
  assert.ok(review.warnings[0].includes('没有译文'), review.warnings[0])
  assert.ok(review.warnings[0].includes('1 个键'), review.warnings[0])
})

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
