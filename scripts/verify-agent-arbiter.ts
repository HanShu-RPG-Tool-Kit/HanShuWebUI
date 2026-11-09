/**
 * 工具仲裁层验收（文档 §8 严格模式 + 修正草案 D2「两把锁」/ D6 校验顺序）。
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-arbiter.ts`
 *
 * 用内存假宿主 + 真 LockTable / RunUndoLog / RuntimeArbiter：
 * 不碰浏览器 API，但走的是生产同一套锁与撤销代码。
 */

import assert from 'node:assert/strict'
import { RuntimeArbiter } from '../src/agent/pi/arbiter'
import { LockTable } from '../src/agent/runtime/lockTable'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { contentVersion } from '../src/agent/runtime/version'
import type { AgentFileWorld, AgentHost } from '../src/agent/contracts'

/** 源文件（逻辑名 → 正文）与派生语言资产（工程相对路径 → 正文）分开存 */
const sources = new Map<string, string>()
const langAssets = new Map<string, string>()
const dirty = new Set<string>()

function langPath(locale: string, source: string): string {
  return `assets/${locale}/lang_hs/${source.replace(/\.hs$/, '')}.lang`
}

function seedSource(source: string, content: string): void {
  sources.set(source, content)
}

function seedLang(source: string, locale: string, content: string): void {
  langAssets.set(langPath(locale, source), content)
}

const readFullSource = (source: string) => {
  const content = sources.get(source)
  return content === undefined ? { ok: false, error: `not found: ${source}` } : { ok: true, content }
}

const host = {
  readFullSource,
  readSource: readFullSource,
  readAssetText: async (path: string) => langAssets.get(path) ?? null,
  derivedLangTargets: (source: string, locales?: string[]) =>
    (locales ?? ['zh_cn', 'en_us']).map(locale => ({ locale, path: langPath(locale, source) })),
  writeSource: (source: string, content: string) => {
    sources.set(source, content)
    return { ok: true, source }
  },
  createSource: (source: string, content: string) => {
    sources.set(source, content)
    return { ok: true, source, created: true }
  },
  isHumanDirty: (path: string) => dirty.has(path),
} as unknown as AgentHost

/** 与 facade 传给锁表/撤销日志的 `createFileWorld` 同构：源文件优先，其次派生语言资产 */
const world: AgentFileWorld = {
  read: async (path) => {
    const content = sources.get(path) ?? langAssets.get(path)
    if (content === undefined) return null
    return { content, version: await contentVersion(content) }
  },
  isHumanDirty: (path) => dirty.has(path),
  write: async (path, content) => {
    if (content === null) {
      sources.delete(path)
      langAssets.delete(path)
    } else {
      sources.set(path, content)
    }
  },
}

let currentRun = 'run-1'
const locks = new LockTable(world)
const undo = new RunUndoLog(world)
const arbiter = new RuntimeArbiter({ host, locks, undo, world, runKey: () => currentRun })

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
  } finally {
    // 用例之间彻底隔离：任何 Run 的锁/版本记录都不带进下一项
    arbiter.endRound()
    locks.releaseAll()
    dirty.clear()
  }
}

/**
 * 工具输出 JSON 内的文本一律英文（D5/B5）：不允许出现 CJK 字符。
 * 项目里的文件逻辑名本身可能是中文（`角色.hs`），所以断言前先剔除已知路径，
 * 只检查「文案」部分。
 */
function assertEnglish(label: string, value: string | undefined, paths: string[] = []): void {
  assert.equal(typeof value, 'string', `${label} 必须存在`)
  let text = value as string
  for (const path of paths) text = text.split(path).join('')
  assert.doesNotMatch(text, /[\u4e00-\u9fff]/, `${label} 不得含中文：${value}`)
}

/* ───────────────────────── 基础：read → lock → write ───────────────────────── */

await test('read 返回内容哈希，并让同一 Run 可以按这一版加锁', async () => {
  seedSource('序章.hs', '第一行\\n')
  const read = await arbiter.read('序章.hs')
  assert.equal(read.ok, true)
  assert.equal(read.version, await contentVersion('第一行\\n'))
  const locked = await arbiter.lock(['序章.hs'])
  assert.equal(locked.locked, true)
  const writable = await arbiter.assertWritable('序章.hs')
  assert.equal(writable.ok, true)
})

await test('未持锁的写被拒绝：英文 + reason not_held（P5）', async () => {
  seedSource('角色.hs', '旧卡\\n')
  const denied = await arbiter.assertWritable('角色.hs')
  assert.equal(denied.ok, false)
  if (!denied.ok) {
    assert.equal(denied.reason, 'not_held', 'P5：「自己没持锁」用 not_held，held 只留给被他人占用')
    assert.equal(denied.error, 'write without holding the lock')
    assert.ok(denied.hint?.includes('lock_source'), denied.hint)
    assertEnglish('未持锁写 hint', denied.hint, ['角色.hs'])
  }
})

await test('creating 已存在（占名期间被别人建出）→ already_exists + 只给 write_source 提示（B5）', async () => {
  // 先占住一个不存在的名字，模拟 create_source 的前置
  const locked = await arbiter.lock(['占名.hs'], { creating: true })
  assert.equal(locked.locked, true)
  // 占名期间另一个来源建了同名文件（人类 / 别的窗口）
  sources.set('占名.hs', '别人建的同名文件')
  const denied = await arbiter.assertWritable('占名.hs', { creating: true })
  assert.equal(denied.ok, false)
  if (!denied.ok) {
    assert.equal(denied.reason, 'already_exists')
    assert.equal(denied.error, 'path already exists: 占名.hs')
    assert.equal(denied.hint, 'Use write_source to overwrite the existing file.')
    assert.doesNotMatch(denied.hint ?? '', /lock_source/, 'B5：already_exists 不得再拼 lock 提示')
    assertEnglish('creating already_exists hint', denied.hint)
  }
})

await test('持锁期间版本变化 → version_stale（C4：只会来自外部改动）', async () => {
  seedSource('锁后改.hs', 'v1')
  await arbiter.read('锁后改.hs')
  assert.equal((await arbiter.lock(['锁后改.hs'])).locked, true)
  sources.set('锁后改.hs', 'v2 外部改动') // 人类 / 别的 Run 在只读生效前改了
  const denied = await arbiter.assertWritable('锁后改.hs')
  assert.equal(denied.ok, false)
  if (!denied.ok) {
    assert.equal(denied.reason, 'version_stale')
    assert.equal(denied.error, 'file changed after it was locked')
    assertEnglish('version_stale hint', denied.hint)
  }
})

await test('read 失败：英文 + reason not_found', async () => {
  const read = await arbiter.read('不存在.hs')
  assert.equal(read.ok, false)
  assertEnglish('read error', typeof read.error === 'string' ? read.error : undefined, ['不存在.hs'])
  assert.equal(read.reason, 'not_found')
})

await test('lock 拒绝顺序按 D6：不存在→not_found、存在未读→not_read、版本变化→version_stale', async () => {
  const missing = await arbiter.lock(['不存在.hs'])
  assert.equal(missing.locked, false)
  if (!missing.locked) {
    assert.equal(missing.reason, 'not_found')
    assertEnglish('lock not_found hint', missing.hint, ['不存在.hs'])
  }

  seedSource('未读.hs', '正文\\n')
  const unread = await arbiter.lock(['未读.hs'])
  assert.equal(unread.locked, false)
  if (!unread.locked) assert.equal(unread.reason, 'not_read')

  seedSource('版本.hs', 'v1\\n')
  await arbiter.read('版本.hs')
  sources.set('版本.hs', 'v2\\n') // 外部改动（人类/其它 Run）
  const stale = await arbiter.lock(['版本.hs'])
  assert.equal(stale.locked, false)
  if (!stale.locked) {
    assert.equal(stale.reason, 'version_stale')
    assert.equal(stale.contentOmitted, undefined, 'B10 只省略 already_exists')
    assert.equal(stale.currentContent, 'v2\\n')
  }
})

await test('creating 命中已存在 → already_exists，提示改用 write（D6）', async () => {
  seedSource('已存在.hs', '正文\\n')
  const denied = await arbiter.lock(['已存在.hs'], { creating: true })
  assert.equal(denied.locked, false)
  if (!denied.locked) {
    assert.equal(denied.reason, 'already_exists')
    assert.match(denied.hint, /write/i)
    // B10：already_exists 不回整篇正文，只留版本 + 标记（长文件 payload 不膨胀）
    assert.equal(denied.currentContent, undefined, 'already_exists 不得回传 currentContent')
    assert.equal(denied.contentOmitted, true)
    assert.equal(typeof denied.currentVersion, 'string', '仍要回 currentVersion')
    assert.equal((denied.currentVersion as string).length, 64)
  }
})

await test('lock：held 仍回传 currentContent（B10 只对 already_exists 省略）', async () => {
  seedSource('被占.hs', '被占内容')
  currentRun = 'run-other'
  await arbiter.read('被占.hs')
  assert.equal((await arbiter.lock(['被占.hs'])).locked, true)

  currentRun = 'run-1'
  await arbiter.read('被占.hs')
  const denied = await arbiter.lock(['被占.hs'])
  assert.equal(denied.locked, false)
  if (!denied.locked) {
    assert.equal(denied.reason, 'held')
    assert.equal(denied.currentContent, '被占内容', 'held 必须回传内容，模型才能自愈')
    assert.equal(denied.contentOmitted, undefined)
  }
})

/* ───────────────────────── D8：锁只看版本 ───────────────────────── */

await test('lock：人类有未保存编辑但版本未变 → 允许加锁（D8）', async () => {
  seedSource('人类编辑.hs', '人类刚打的字')
  // read 会 flush 编辑器缓冲：读到的就是人类正在编辑的当前内容
  await arbiter.read('人类编辑.hs')
  dirty.add('人类编辑.hs') // 编辑器缓冲里仍有「未保存」标记，但内容版本没变
  const locked = await arbiter.lock(['人类编辑.hs'])
  assert.equal(locked.locked, true, 'D8：锁只看版本，human-dirty 不再拒绝加锁')
  assert.equal(arbiter.isLocked('人类编辑.hs'), true)
  assert.equal((await arbiter.assertWritable('人类编辑.hs')).ok, true, '加锁后照常可写')
})

await test('lock：人类继续输入导致版本变 → version_stale（D8）', async () => {
  seedSource('人类续写.hs', '第一版')
  await arbiter.read('人类续写.hs')
  dirty.add('人类续写.hs')
  sources.set('人类续写.hs', '第一版第二版') // 人类继续输入，内容真的变了
  const denied = await arbiter.lock(['人类续写.hs'])
  assert.equal(denied.locked, false)
  if (!denied.locked) {
    assert.equal(denied.reason, 'version_stale', 'D8：内容变了才拒绝，理由只有 version_stale')
    assert.equal(denied.currentContent, '第一版第二版')
  }
})

/* ───────────────────────── 写不释放锁（D2） ───────────────────────── */

await test('写成功后锁仍在：同一 Run 可连续写，无需反复 lock', async () => {
  seedSource('连写.hs', '旧内容\\n')
  await arbiter.read('连写.hs')
  assert.equal((await arbiter.lock(['连写.hs'])).locked, true)
  assert.equal(arbiter.isLocked('连写.hs'), true)

  assert.equal((await arbiter.assertWritable('连写.hs')).ok, true)
  sources.set('连写.hs', '第一次写\\n') // 模拟宿主落盘
  const firstVersion = await arbiter.noteWritten('连写.hs')
  assert.equal(firstVersion, await contentVersion('第一次写\\n'), 'noteWritten 必须返回写后版本')
  assert.equal(arbiter.isLocked('连写.hs'), true, '写成功不得释放锁（D2）')

  // 第二次写：锁还在，版本守卫应接受刚写的版本，不必重新 read/lock
  assert.equal((await arbiter.assertWritable('连写.hs')).ok, true)
  sources.set('连写.hs', '第二次写\\n')
  const secondVersion = await arbiter.noteWritten('连写.hs')
  assert.equal(secondVersion, await contentVersion('第二次写\\n'))
  assert.equal(arbiter.isLocked('连写.hs'), true)
})

await test('写后版本自更新：不重新 read 也能再 lock，且内容是最新版', async () => {
  seedSource('自更新.hs', '旧\\n')
  await arbiter.read('自更新.hs')
  await arbiter.lock(['自更新.hs'])
  await arbiter.assertWritable('自更新.hs')
  sources.set('自更新.hs', '新\\n')
  await arbiter.noteWritten('自更新.hs')

  const relocked = await arbiter.lock(['自更新.hs'])
  assert.equal(relocked.locked, true, '写后版本应已登记，不该判 version_stale / not_read')
  if (relocked.locked) {
    assert.equal(relocked.content, '新\\n')
    assert.equal(relocked.version, await contentVersion('新\\n'))
  }
})

await test('新建：先占名（creating）再写；写完锁保留，noteWritten 返回写后版本', async () => {
  const locked = await arbiter.lock(['新建.hs'], { creating: true })
  assert.equal(locked.locked, true)
  if (locked.locked) {
    // P8：creating 是「占住一个还不存在的名字」，没有版本/内容，用 null 而不是空串
    assert.equal(locked.version, null, 'creating grant 的 version 必须是 null')
    assert.equal(locked.content, null, 'creating grant 的 content 必须是 null')
  }
  assert.equal(arbiter.isLocked('新建.hs'), true, 'create 锁占名后应持有')
  assert.equal((await arbiter.assertWritable('新建.hs', { creating: true })).ok, true)
  sources.set('新建.hs', '内容\\n')
  const written = await arbiter.noteWritten('新建.hs')
  assert.equal(written, await contentVersion('内容\\n'), 'create 不再返回空串版本（D6）')
  assert.equal(arbiter.isLocked('新建.hs'), true)

  const relocked = await arbiter.lock(['新建.hs'])
  assert.equal(relocked.locked, true)
  if (relocked.locked) assert.equal(relocked.content, '内容\\n')
})

/* ───────────────────────── 两把锁分开（D2） ───────────────────────── */

await test('lock_source 不再展开派生语言资产', async () => {
  seedSource('双锁.hs', '正文\\n')
  seedLang('双锁.hs', 'zh_cn', '{"a":"1"}')
  seedLang('双锁.hs', 'en_us', '{"a":"one"}')
  await arbiter.read('双锁.hs')
  const locked = await arbiter.lock(['双锁.hs'])
  assert.equal(locked.locked, true)
  assert.equal(arbiter.isLocked('双锁.hs'), true)
  assert.equal(arbiter.isLocked(langPath('zh_cn', '双锁.hs')), false, '源文件锁不得展开到 .lang')
  assert.equal(arbiter.isLocked(langPath('en_us', '双锁.hs')), false)
  assert.equal(locks.ownerOf(langPath('zh_cn', '双锁.hs')), null)
})

await test('lockLang：已存在的 .lang 隐式读 + 版本校验后锁住', async () => {
  seedSource('译文.hs', '正文\\n')
  seedLang('译文.hs', 'zh_cn', '{"a":"一"}')
  const result = await arbiter.lockLang('译文.hs', ['zh_cn'])
  assert.equal(result.locked, true)
  if (!result.locked) return
  const grant = result.langs[0]
  assert.equal(grant.locale, 'zh_cn')
  assert.equal(grant.path, langPath('zh_cn', '译文.hs'))
  assert.equal(grant.existed, true)
  assert.equal(grant.version, await contentVersion('{"a":"一"}'))
  assert.equal(arbiter.isLocked(grant.path), true)
})

await test('lockLang：不存在的 .lang 按 creating 占名（existed:false / version:null）', async () => {
  seedSource('缺译文.hs', '正文\\n')
  const result = await arbiter.lockLang('缺译文.hs', ['en_us'])
  assert.equal(result.locked, true)
  if (!result.locked) return
  assert.equal(result.langs[0].existed, false)
  assert.equal(result.langs[0].version, null)
  assert.equal(arbiter.isLocked(langPath('en_us', '缺译文.hs')), true)
})

await test('lockLang：多语言整批原子，一个失败则一个都不持有', async () => {
  seedSource('原子.hs', '正文\\n')
  seedLang('原子.hs', 'zh_cn', '{"a":"一"}') // 这一条本来会成功
  // D8 之后 human-dirty 不再能制造失败：改用「另一个 Run 先占住 en_us」制造 held
  currentRun = 'run-other'
  await arbiter.read('原子.hs')
  assert.equal((await arbiter.lockLang('原子.hs', ['en_us'])).locked, true)
  currentRun = 'run-1'
  const result = await arbiter.lockLang('原子.hs', ['zh_cn', 'en_us'])
  assert.equal(result.locked, false)
  if (result.locked) return
  assert.equal(result.reason, 'held')
  assert.equal(result.locale, 'en_us', '失败结果要能定位到具体语言')
  assert.equal(result.path, langPath('en_us', '原子.hs'))
  assert.equal(arbiter.isLocked(langPath('zh_cn', '原子.hs')), false, '失败时一条都不得登记')
  assert.equal(arbiter.isLocked(langPath('en_us', '原子.hs')), false)
  assert.equal(locks.ownerOf(langPath('zh_cn', '原子.hs')), null)
})

await test('写语言后锁仍在，锁版本刷新为写后版本（语言也可连续写）', async () => {
  seedSource('语言连写.hs', '正文\\n')
  seedLang('语言连写.hs', 'zh_cn', '{"a":"一"}')
  const path = langPath('zh_cn', '语言连写.hs')
  const result = await arbiter.lockLang('语言连写.hs', ['zh_cn'])
  assert.equal(result.locked, true)

  langAssets.set(path, '{"a":"一改"}') // 模拟宿主写语言草稿
  const written = await arbiter.noteWritten(path)
  assert.equal(written, await contentVersion('{"a":"一改"}'))
  assert.equal(arbiter.isLocked(path), true, '写语言不得释放语言锁')
  assert.equal(locks.lockedVersion(path), written, '语言锁版本必须刷新')

  const writable = await arbiter.assertWritable(path)
  assert.equal(writable.ok, true, '同一 Run 连续写语言不应被判「持锁期间被改动」')
})

/* ───────────────────────── unlock / isLocked / endRound ───────────────────────── */

await test('unlock_source 只放本 Run 的锁，别的 Run 不受影响', async () => {
  seedSource('解锁.hs', '正文\\n')
  currentRun = 'run-owner'
  await arbiter.read('解锁.hs')
  assert.equal((await arbiter.lock(['解锁.hs'])).locked, true)

  currentRun = 'run-intruder'
  assert.deepEqual(arbiter.unlock(['解锁.hs']), [], '不得释放别的 Run 的锁')
  assert.equal(locks.ownerOf('解锁.hs'), 'run-owner')

  currentRun = 'run-owner'
  assert.deepEqual(arbiter.unlock(['解锁.hs']), ['解锁.hs'])
  assert.equal(arbiter.isLocked('解锁.hs'), false)
  assert.deepEqual(arbiter.unlock(['解锁.hs']), [], '重复 unlock 幂等')
})

await test('unlock_lang 释放并幂等', async () => {
  seedSource('解锁语言.hs', '正文\\n')
  seedLang('解锁语言.hs', 'zh_cn', '{"a":"一"}')
  const path = langPath('zh_cn', '解锁语言.hs')
  assert.equal((await arbiter.lockLang('解锁语言.hs', ['zh_cn'])).locked, true)
  assert.equal(arbiter.isLocked(path), true)
  assert.deepEqual(arbiter.unlockLang('解锁语言.hs', ['zh_cn']), [path])
  assert.equal(arbiter.isLocked(path), false)
  assert.deepEqual(arbiter.unlockLang('解锁语言.hs', ['zh_cn']), [], '重复 unlock_lang 幂等')
})

await test('endRound：Run 结束释放本 Run 全部锁（源文件 + 语言）', async () => {
  seedSource('收尾.hs', '正文\\n')
  seedLang('收尾.hs', 'zh_cn', '{"a":"一"}')
  await arbiter.read('收尾.hs')
  assert.equal((await arbiter.lock(['收尾.hs'])).locked, true)
  assert.equal((await arbiter.lockLang('收尾.hs', ['zh_cn'])).locked, true)
  assert.equal(arbiter.isLocked('收尾.hs'), true)
  assert.equal(arbiter.isLocked(langPath('zh_cn', '收尾.hs')), true)

  arbiter.endRound()
  assert.equal(arbiter.isLocked('收尾.hs'), false)
  assert.equal(arbiter.isLocked(langPath('zh_cn', '收尾.hs')), false)
  assert.equal(locks.lockedPaths().length, 0)
})

await test('heldPaths：返回本 Run 持有的全部锁（源文件 + 语言），unlock 后减少', async () => {
  for (const name of ['甲.hs', '乙.hs', '丙.hs']) {
    seedSource(name, '正文')
    await arbiter.read(name)
    assert.equal((await arbiter.lock([name])).locked, true)
  }
  seedLang('甲.hs', 'zh_cn', '{"a":"一"}')
  seedLang('甲.hs', 'en_us', '{"a":"one"}')
  assert.equal((await arbiter.lockLang('甲.hs', ['zh_cn', 'en_us'])).locked, true)

  const held = arbiter.heldPaths()
  assert.equal(held.length, 5, '3 个源文件锁 + 2 个语言锁')
  assert.ok(held.includes('甲.hs'))
  assert.ok(held.includes('乙.hs'))
  assert.ok(held.includes('丙.hs'))
  assert.ok(held.includes(langPath('zh_cn', '甲.hs')))
  assert.ok(held.includes(langPath('en_us', '甲.hs')))

  assert.deepEqual(arbiter.unlock(['乙.hs']), ['乙.hs'])
  assert.equal(arbiter.heldPaths().length, 4, 'unlock 一个后剩 4')
  assert.equal(arbiter.heldPaths().includes('乙.hs'), false)

  // 别的 Run 看不到本 Run 的锁
  currentRun = 'run-other'
  assert.deepEqual(arbiter.heldPaths(), [], 'heldPaths 只返回本 Run 的锁')
})

/* ───────────────────────── 撤销日志（写前映像仍然可用） ───────────────────────── */

await test('撤销日志记下写前映像，回滚后文件回到旧内容', async () => {
  seedSource('回滚.hs', '原始\\n')
  const runKey = currentRun
  await arbiter.read('回滚.hs')
  await arbiter.lock(['回滚.hs'])
  await arbiter.assertWritable('回滚.hs')
  sources.set('回滚.hs', '改坏\\n')
  await arbiter.noteWritten('回滚.hs')

  // 新建文件也进同一份日志，用于验证逆序回放
  await arbiter.lock(['新草稿.hs'], { creating: true })
  await arbiter.assertWritable('新草稿.hs', { creating: true })
  sources.set('新草稿.hs', '新内容\\n')
  await arbiter.noteWritten('新草稿.hs')

  const outcomes = await undo.rollback(runKey)
  undo.discard(runKey)
  assert.equal(sources.get('回滚.hs'), '原始\\n', '回滚应恢复到写前内容')
  assert.equal(sources.has('新草稿.hs'), false, '本 Run 新建的草稿应被删除')
  const restored = outcomes.find(item => item.path === '回滚.hs')
  assert.equal(restored?.action, 'restored')
  assert.equal(outcomes[0]?.path, '新草稿.hs', '逆序回放：后写的先撤销')
  assert.equal(outcomes[0]?.action, 'deleted')
})

/* ───────────────────────── 分页参数（D6） ───────────────────────── */

await test('read 的 offset 越界不静默 clamp：报错并回传 totalLines', async () => {
  const nl = String.fromCharCode(10)
  seedSource('分页.hs', ['一', '二', '三'].join(nl) + nl)
  const out = await arbiter.read('分页.hs', 99)
  assert.equal(out.ok, false)
  assert.equal(out.error, 'offset out of range')
  assert.equal(out.totalLines, 4)
  const page = await arbiter.read('分页.hs', 2, 1)
  assert.equal(page.ok, true)
  assert.equal(page.totalLines, 4)
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
