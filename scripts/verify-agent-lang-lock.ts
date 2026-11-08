/**
 * 语言锁（lock_lang / unlock_lang）验收脚本（修正草案 D2「两把锁」）。
 *
 * 覆盖「语言写入必须同时持有源文件锁 + 每个目标语言的锁」这条关键协议：
 * - `lock_source` 只锁源文件，**不再**展开派生 `.lang`；
 * - 写译文前必须 `lock_lang({ source, locales })`，否则 `write_lang` / `delete_lang_keys` /
 *   `parse_hs` 被拒绝且**不触达宿主**（严格模式，hint 用英文并指向 lock_lang）；
 * - 写成功**不释放锁**：同一 Run 可连续写；`unlock_lang` 幂等释放；
 * - `unlock_*` 的 held 是调用后本 Run 仍持有的**全部**路径（源文件 + 语言资产，P3）；
 * - 宿主的 keys_not_in_source / missingKeys 结构化错误原样透传（P8）；
 * - 外部回写 `.lang` 后，语言锁版本不一致 → 拒绝覆盖别人的译文；
 * - 语言文件不存在时 `lock_lang` 按 creating 占位（首次写译文）；
 * - 写译文只落**本地草稿**：成功返回 draft:true / saved:false / version:null，
 *   不再声称「已落盘」，hint 提醒用户保存工程（D1）。
 *
 * 用纯内存的假 AgentHost + 假 AgentToolArbiter（与 `verify-agent-tools` 同构），
 * 不依赖运行时 / 存储层的并行改造。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-lang-lock.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectMissingTranslationWarnings } from '../src/agent/agentOps'
import { executeAgentTool, type AgentToolCall } from '../src/agent/tools'
import type { AgentHost, AgentToolArbiter } from '../src/agent/contracts'

const SOURCE = '阿拉丁神灯.hs'
const LANGS = ['zh_cn', 'en_us']
const CURRENT_LOCALE = 'zh_cn'
const LANG_ZH = `assets/zh_cn/lang_hs/阿拉丁神灯.lang`
const LANG_EN = `assets/en_us/lang_hs/阿拉丁神灯.lang`
const LANG_JA = `assets/ja_jp/lang_hs/阿拉丁神灯.lang`

const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12)

const EOL = String.fromCharCode(10)

/** 派生语言资产路径：与真实宿主同口径（assets/<locale>/lang_<ext>/<base>.lang） */
function langPath(source: string, locale: string): string {
  const dot = source.lastIndexOf('.')
  const base = dot >= 0 ? source.slice(0, dot) : source
  const ext = dot >= 0 ? source.slice(dot + 1) : ''
  return `assets/${locale}/lang_${ext}/${base}.lang`
}

/**
 * 场景：一个源文件 + 两种工程语言（zh_cn 已有译文、en_us 还没有）。
 * 锁版本与 noteWritten 语义刻意和真仲裁层一致：写成功只刷新锚点、不释放锁。
 */
function makeScene() {
  const sources = new Map<string, string>([[SOURCE, '第一幕：开场']])
  const assets = new Map<string, string>([[LANG_ZH, 'd6e15f31 # 旧译文']])
  const readVersions = new Map<string, string>()
  const locks = new Map<string, { creating: boolean; version: string }>()
  /** 语言类宿主的调用计数：被拒的写必须保持 0 */
  const calls = { writeLang: 0, deleteLangKeys: 0, parseHs: 0, unparseHs: 0 }

  const contentOf = (path: string): string | undefined =>
    sources.get(path) ?? assets.get(path)

  const host: AgentHost = {
    readFullSource: (source) => {
      const content = sources.get(source)
      return content === undefined
        ? { ok: false, error: `Source not found: ${source}` }
        : { ok: true, content }
    },
    readSource: (source) => host.readFullSource?.(source) ?? { ok: false, error: 'unavailable' },
    isHumanDirty: () => false,
    derivedLangTargets: (source, locales) => {
      const list = locales !== undefined && locales.length > 0 ? locales : LANGS
      return list.map((locale) => ({ locale, path: langPath(source, locale) }))
    },
    readAssetText: async (path) => assets.get(path) ?? null,
    writeSource: (source, content) => {
      sources.set(source, content)
      return { ok: true, source }
    },
    createSource: (source, content) => {
      sources.set(source, content)
      return { ok: true, source }
    },
    editSource: () => ({ ok: true }),
    validateSource: () => ({ ok: true }),
    getActiveFilePath: () => ({ ok: true, name: SOURCE, kind: 'hanshu' }),
    listLocales: () => ({ ok: true, locales: LANGS }),
    listLangKeys: async () => ({ ok: true, source: SOURCE, entries: [] }),
    writeLang: async (source, translations) => {
      calls.writeLang += 1
      const writtenPaths: string[] = []
      const locales: Array<Record<string, unknown>> = []
      for (const [locale, entries] of Object.entries(translations)) {
        const path = langPath(source, locale)
        assets.set(
          path,
          entries.map((entry) => `${entry.key} # ${entry.text}`).join(EOL),
        )
        writtenPaths.push(path)
        // 故意返回「已保存」字段：工具层必须统一改写成草稿标记（D1）
        locales.push({ locale, path, saved: true, savedToProject: true })
      }
      return { ok: true, source, writtenPaths, locales, saved: true, version: 'host-version' }
    },
    deleteLangKeys: async (source, keys, locale) => {
      calls.deleteLangKeys += 1
      const path = langPath(source, locale ?? CURRENT_LOCALE)
      assets.set(path, '')
      return {
        ok: true,
        source,
        removed: keys.length,
        writtenPaths: [path],
        saved: true,
        version: 'host-version',
      }
    },
    listVoiceStatus: async () => ({ ok: true, entries: [] }),
    parseHs: async (source, locale) => {
      calls.parseHs += 1
      const path = langPath(source, locale ?? CURRENT_LOCALE)
      if (!assets.has(path)) assets.set(path, '')
      return {
        ok: true,
        source,
        writtenPaths: [path],
        saved: true,
        version: 'host-version',
      }
    },
    unparseHs: async () => {
      calls.unparseHs += 1
      return { ok: true, source: SOURCE }
    },
    checkExport: async () => ({ ok: true, files: 0, warnings: [] }),
  }

  const arbiter: AgentToolArbiter = {
    read: async (source) => {
      const content = sources.get(source)
      if (content === undefined) return { ok: false, error: `Source not found: ${source}` }
      const version = hash(content)
      readVersions.set(source, version)
      return { ok: true, source, version, content, total: 1 }
    },
    lock: async (paths, options) => {
      const creating = options?.creating === true
      for (const path of paths) {
        const content = sources.get(path)
        if (creating) {
          if (content !== undefined) {
            return {
              locked: false,
              reason: 'already_exists',
              currentVersion: hash(content),
              currentContent: content,
              hint: 'Target already exists. Do not pass creating: true.',
            }
          }
          continue
        }
        if (content === undefined) {
          return { locked: false, reason: 'not_found', hint: 'File not found.' }
        }
        const current = hash(content)
        const lastRead = readVersions.get(path)
        if (lastRead === undefined) {
          return {
            locked: false,
            reason: 'not_read',
            currentVersion: current,
            currentContent: content,
            hint: `Call read_source("${path}") first.`,
          }
        }
        if (lastRead !== current) {
          return {
            locked: false,
            reason: 'version_stale',
            currentVersion: current,
            currentContent: content,
            hint: 'Content changed; read again, then lock.',
          }
        }
      }
      for (const path of paths) {
        const content = sources.get(path)
        locks.set(path, {
          creating,
          version: creating || content === undefined ? '' : hash(content),
        })
      }
      const first = paths[0]
      const firstContent = first === undefined ? '' : sources.get(first) ?? ''
      return {
        locked: true,
        version: creating ? '' : hash(firstContent),
        content: firstContent,
      }
    },
    lockLang: async (source, locales) => {
      const list = locales !== undefined && locales.length > 0 ? locales : LANGS
      const langs = list.map((locale) => {
        const path = langPath(source, locale)
        const content = assets.get(path)
        const existed = content !== undefined
        const version = existed ? hash(content) : null
        locks.set(path, { creating: !existed, version: version ?? '' })
        return { locale, path, existed, version }
      })
      return { locked: true, langs }
    },
    unlock: (paths) => {
      const released: string[] = []
      for (const path of paths) {
        if (locks.delete(path)) released.push(path)
      }
      return released
    },
    unlockLang: (source, locales) => {
      const list = locales !== undefined && locales.length > 0 ? locales : LANGS
      const released: string[] = []
      for (const locale of list) {
        const path = langPath(source, locale)
        if (locks.delete(path)) released.push(path)
      }
      return released
    },
    isLocked: (path) => locks.has(path),
    heldPaths: () => [...locks.keys()],
    assertWritable: async (path, options) => {
      const creating = options?.creating === true
      const held = locks.get(path)
      if (creating) {
        if (held === undefined || !held.creating) {
          return {
            ok: false,
            error: `Path not reserved: ${path}`,
            hint: `Call lock_source({ "paths": ["${path}"], "creating": true }) first.`,
          }
        }
        return { ok: true, version: '' }
      }
      if (held === undefined) {
        return {
          ok: false,
          error: `Path not locked: ${path}`,
          hint: `Call lock_source({ "paths": ["${path}"] }) first (lock_lang for language files).`,
        }
      }
      const content = contentOf(path)
      if (content === undefined) {
        // creating 锁（尚不存在的 .lang）：允许宿主新建
        return { ok: true, version: held.version }
      }
      const version = hash(content)
      if (held.version !== version) {
        return {
          ok: false,
          error: `Content changed after locking: ${path}`,
          hint: 'Re-read and lock again (lock_lang for language files).',
        }
      }
      return { ok: true, version }
    },
    noteWritten: async (path) => {
      const content = contentOf(path)
      if (content === undefined) return null
      const version = hash(content)
      readVersions.set(path, version)
      const held = locks.get(path)
      // D2：写成功只刷新锁锚点，不释放锁
      if (held !== undefined) locks.set(path, { ...held, creating: false, version })
      return version
    },
    endRound: () => {
      locks.clear()
      readVersions.clear()
    },
  }

  return {
    host,
    arbiter,
    target: { host, arbiter },
    sources,
    assets,
    calls,
  }
}

type Scene = ReturnType<typeof makeScene>

async function callTool(
  scene: Scene,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const call: AgentToolCall = {
    id: name,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
  const raw = await executeAgentTool(scene.target, call)
  return JSON.parse(raw) as Record<string, any>
}

/** read → lock_source 是任何写之前的固定前置 */
async function lockSource(scene: Scene): Promise<void> {
  const read = await scene.arbiter.read(SOURCE)
  assert.equal(read.ok, true)
  const locked = await scene.arbiter.lock([SOURCE])
  assert.equal(locked.locked, true, `lock_source 应成功：${JSON.stringify(locked)}`)
}

let checks = 0
const failures: string[] = []
async function test(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    checks += 1
    console.log(`通过：${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`失败：${name}`, error)
  }
}

async function withScene(body: (scene: Scene) => Promise<void>): Promise<void> {
  const scene = makeScene()
  try {
    await body(scene)
  } finally {
    await scene.arbiter.endRound()
  }
}

await test('lock_source 不锁语言资产；未 lock_lang 的 write_lang 被拒且 host 未被调用', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    assert.equal(scene.arbiter.isLocked(SOURCE), true)
    assert.equal(scene.arbiter.isLocked(LANG_ZH), false, 'lock_source 不应展开 .lang（D2）')

    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '新译文' }] },
    })
    assert.equal(output.ok, false, JSON.stringify(output))
    assert.equal(scene.calls.writeLang, 0, '缺语言锁时绝不能调用宿主写入')
    assert.match(String(output.error), /not writable/i, '新拒绝体用英文')
    assert.match(String(output.hint), /lock_lang/, 'hint 必须指向 lock_lang')
    assert.match(String(output.hint), /zh_cn/, 'hint 要带上具体语言标签')
    assert.equal(scene.assets.get(LANG_ZH), 'd6e15f31 # 旧译文', '被拒时译文不能变化')
  })
})

await test('非法键在加锁与宿主调用之前被拒绝（write_lang / delete_lang_keys）', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    const write = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'D6E15F31', text: '大写' }] },
    })
    assert.equal(write.ok, false, JSON.stringify(write))
    assert.equal(write.error, 'invalid translation keys')
    assert.deepEqual(write.invalidKeys, ['D6E15F31'])
    assert.equal(scene.calls.writeLang, 0, '键非法不得调用宿主')
    assert.equal(scene.arbiter.isLocked(LANG_ZH), false, '键校验不应触达语言锁')

    const deleted = await callTool(scene, 'delete_lang_keys', {
      source: SOURCE,
      locale: 'zh_cn',
      keys: ['d6e15f31', 'd6e15f31'],
    })
    assert.equal(deleted.ok, false, JSON.stringify(deleted))
    assert.deepEqual(deleted.duplicates, ['d6e15f31'])
    assert.equal(scene.calls.deleteLangKeys, 0)
  })
})

await test('lock_lang 后 write_lang 成功，写后两把锁都还在', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    const locked = await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })
    assert.equal(locked.locked, true, JSON.stringify(locked))
    assert.equal(locked.langs.length, 1)
    assert.equal(locked.langs[0].locale, 'zh_cn')
    assert.equal(locked.langs[0].path, LANG_ZH)
    assert.equal(locked.langs[0].existed, true)
    assert.equal(locked.langs[0].version, hash('d6e15f31 # 旧译文'))

    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '新译文' }] },
    })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(scene.calls.writeLang, 1)
    assert.deepEqual(output.writtenPaths, [LANG_ZH])
    assert.ok((scene.assets.get(LANG_ZH) ?? '').includes('新译文'))
    assert.equal(output.draft, true, '语言写只落本地草稿')
    assert.equal(output.saved, false, '不能声称已保存')
    assert.equal(output.version, null, '语言写不返回落盘版本')
    assert.match(String(output.hint), /save the project/i, 'hint 要提醒用户保存工程')
    assert.equal(JSON.stringify(output).includes('"saved":true'), false)
    assert.equal(output.locales[0].draft, true)
    assert.equal(output.locales[0].saved, false)
    assert.equal(output.locales[0].savedToProject, false)
    assert.equal(scene.arbiter.isLocked(SOURCE), true, '写成功不释放源文件锁（D2）')
    assert.equal(scene.arbiter.isLocked(LANG_ZH), true, '写成功不释放语言锁（D2）')
  })
})

await test('语言写成功只返回草稿标记：draft:true / saved:false / version:null', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })
    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '草稿译文' }] },
    })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(output.draft, true)
    assert.equal(output.saved, false)
    assert.equal(output.version, null)
    assert.match(String(output.hint), /save the project/i)
    const serialized = JSON.stringify(output)
    assert.equal(serialized.includes('"saved":true'), false, '绝不能出现 saved:true')
    assert.equal(serialized.includes('"savedToProject":true'), false)
    assert.deepEqual(output.writtenPaths, [LANG_ZH])
    for (const entry of output.locales) {
      assert.equal(entry.draft, true)
      assert.equal(entry.saved, false)
      assert.equal(entry.savedToProject, false)
    }
  })
})

await test('写成功不释放锁：同一 Run 连续写两次译文不需要重新 lock', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })
    const first = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '第一版' }] },
    })
    const second = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '第二版' }] },
    })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal(first.draft, true)
    assert.equal(second.draft, true)
    assert.equal(second.saved, false)
    assert.equal(second.version, null)
    assert.equal(scene.calls.writeLang, 2, '第二次写也必须触达宿主（锁仍在）')
    assert.ok((scene.assets.get(LANG_ZH) ?? '').includes('第二版'))
  })
})

await test('外部回写 .lang 后：语言锁版本冲突，write_lang 被拒且宿主未被调用', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })

    // 模拟另一个窗口 / 外部程序改了 .lang，源文件没动
    scene.assets.set(LANG_ZH, 'd6e15f31 # 别人的译文')

    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '我会覆盖别人的' }] },
    })
    assert.equal(output.ok, false, JSON.stringify(output))
    assert.equal(scene.calls.writeLang, 0, '版本冲突时绝不能调用宿主写入')
    assert.match(String(output.hint), /lock_lang/, '提示重新 lock_lang')
    assert.equal(scene.assets.get(LANG_ZH), 'd6e15f31 # 别人的译文', '别人的译文必须原样保留')
  })
})

await test('新语言的 .lang 不存在时 lock_lang 按 creating 占位，write_lang 成功', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    const locked = await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['ja_jp'] })
    assert.equal(locked.locked, true, JSON.stringify(locked))
    assert.equal(locked.langs[0].locale, 'ja_jp')
    assert.equal(locked.langs[0].path, LANG_JA)
    assert.equal(locked.langs[0].existed, false, '不存在的 .lang 按 creating 处理')
    assert.equal(locked.langs[0].version, null)

    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { ja_jp: [{ key: 'd6e15f31', text: '日本語' }] },
    })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(scene.calls.writeLang, 1)
    assert.ok((scene.assets.get(LANG_JA) ?? '').includes('日本語'))
    assert.equal(output.draft, true, '新语言首次写也是草稿')
    assert.equal(output.saved, false)
    assert.equal(output.version, null)
    assert.equal(scene.arbiter.isLocked(LANG_JA), true)
  })
})

await test('多语言写入需要覆盖每个目标语言的锁：漏锁的语种整体拒绝', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })

    const denied = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: {
        zh_cn: [{ key: 'd6e15f31', text: '中文' }],
        en_us: [{ key: 'd6e15f31', text: 'English' }],
      },
    })
    assert.equal(denied.ok, false, JSON.stringify(denied))
    assert.equal(scene.calls.writeLang, 0, '漏锁一种语言时整批拒绝，不能写一半')
    assert.match(String(denied.hint), /en_us/, 'hint 要指出缺的是 en_us 的锁')
    assert.equal(scene.assets.has(LANG_EN), false, '不能落下半套写入')

    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['en_us'] })
    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: {
        zh_cn: [{ key: 'd6e15f31', text: '中文' }],
        en_us: [{ key: 'd6e15f31', text: 'English' }],
      },
    })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(scene.calls.writeLang, 1)
    assert.equal(output.draft, true)
    assert.equal(output.saved, false)
    assert.equal(output.version, null)
    assert.equal(output.locales.length, 2, '两种语言各一条草稿结果')
    for (const entry of output.locales) assert.equal(entry.saved, false)
    assert.ok((scene.assets.get(LANG_ZH) ?? '').includes('中文'))
    assert.ok((scene.assets.get(LANG_EN) ?? '').includes('English'))
  })
})

await test('unlock_lang 幂等释放语言锁，之后 write_lang 再次被拒', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE })
    assert.equal(scene.arbiter.isLocked(LANG_ZH), true)
    assert.equal(scene.arbiter.isLocked(LANG_EN), true)

    const first = await callTool(scene, 'unlock_lang', { source: SOURCE })
    assert.deepEqual([...first.unlocked].sort(), [LANG_EN, LANG_ZH].sort())
    // P3：held 是调用后本 Run 仍持有的全部路径 —— 源文件锁还在
    assert.deepEqual(first.held, [SOURCE], '源文件锁仍持有 → held 必须包含它')
    assert.equal(scene.arbiter.isLocked(LANG_ZH), false)
    assert.equal(scene.arbiter.isLocked(LANG_EN), false)

    const second = await callTool(scene, 'unlock_lang', { source: SOURCE })
    assert.deepEqual(second.unlocked, [], '重复解锁应幂等')
    assert.deepEqual(second.held, [SOURCE])

    const denied = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'd6e15f31', text: '解锁后不许写' }] },
    })
    assert.equal(denied.ok, false)
    assert.equal(scene.calls.writeLang, 0)
    assert.match(String(denied.hint), /lock_lang/)
  })
})

await test('P3 部分解锁：held 列出调用后仍持有的全部路径（源文件 + 其它语言）', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', {
      source: SOURCE,
      locales: ['zh_cn', 'en_us', 'ja_jp'],
    })
    const released = await callTool(scene, 'unlock_lang', {
      source: SOURCE,
      locales: ['zh_cn'],
    })
    assert.deepEqual(released.unlocked, [LANG_ZH])
    const held: string[] = released.held
    assert.ok(held.includes(SOURCE), 'held 要包含源文件锁')
    assert.ok(held.includes(LANG_EN), 'held 要包含 en_us 语言锁')
    assert.ok(held.includes(LANG_JA), 'held 要包含 ja_jp 语言锁')
    assert.equal(held.includes(LANG_ZH), false, '已释放的 zh_cn 不能出现在 held')
    assert.equal(scene.arbiter.isLocked(LANG_ZH), false)

    const releasedSource = await callTool(scene, 'unlock_source', { paths: [SOURCE] })
    const heldAfterSource: string[] = releasedSource.held
    assert.equal(heldAfterSource.includes(SOURCE), false)
    assert.ok(heldAfterSource.includes(LANG_EN), '源锁释放后语言锁仍持有')
  })
})

await test('P8 宿主 keys_not_in_source / missingKeys 结构化错误纯透传', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })
    scene.host.writeLang = async () => ({
      ok: false,
      error: 'keys are not in source',
      reason: 'keys_not_in_source',
      missingKeys: ['deadbeef'],
      hint: 'Call parse_hs first to add keys to the source.',
    })
    const output = await callTool(scene, 'write_lang', {
      source: SOURCE,
      translations: { zh_cn: [{ key: 'deadbeef', text: 'x' }] },
    })
    assert.equal(output.ok, false, JSON.stringify(output))
    assert.equal(output.reason, 'keys_not_in_source')
    assert.deepEqual(output.missingKeys, ['deadbeef'])
    assert.match(String(output.hint), /parse_hs/)
  })
})

await test('parse_hs 与 delete_lang_keys 同样需要语言锁', async () => {
  await withScene(async (scene) => {
    await lockSource(scene)
    const deniedParse = await callTool(scene, 'parse_hs', { source: SOURCE, locale: 'zh_cn' })
    assert.equal(deniedParse.ok, false, JSON.stringify(deniedParse))
    assert.equal(scene.calls.parseHs, 0)
    assert.match(String(deniedParse.hint), /lock_lang/)

    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['zh_cn'] })
    const parsed = await callTool(scene, 'parse_hs', { source: SOURCE, locale: 'zh_cn' })
    assert.equal(parsed.ok, true, JSON.stringify(parsed))
    assert.equal(scene.calls.parseHs, 1)
    assert.equal(parsed.draft, true, 'parse_hs 只写草稿')
    assert.equal(parsed.saved, false)
    assert.equal(parsed.version, null)

    // 换一个未锁的语言删键 → 拒绝；锁上后才允许
    const deniedDelete = await callTool(scene, 'delete_lang_keys', {
      source: SOURCE,
      locale: 'en_us',
      keys: ['d6e15f31'],
    })
    assert.equal(deniedDelete.ok, false, JSON.stringify(deniedDelete))
    assert.equal(scene.calls.deleteLangKeys, 0)
    assert.match(String(deniedDelete.hint), /lock_lang/)
    await callTool(scene, 'lock_lang', { source: SOURCE, locales: ['en_us'] })
    const deleted = await callTool(scene, 'delete_lang_keys', {
      source: SOURCE,
      locale: 'en_us',
      keys: ['d6e15f31'],
    })
    assert.equal(deleted.ok, true, JSON.stringify(deleted))
    assert.equal(scene.calls.deleteLangKeys, 1)
    assert.equal(deleted.draft, true, 'delete_lang_keys 只写草稿')
    assert.equal(deleted.saved, false)
    assert.equal(deleted.version, null)
  })
})

await test('导出预检会把「正文有键、语言文件没文本」列成警告（基线保留）', async () => {
  const content = ['narrator:d6e15f31//', 'narrator:4c81c0ad//'].join(EOL)
  const review = await collectMissingTranslationWarnings(
    [{ name: SOURCE, content }],
    ['zh_cn', 'ja_jp'],
    async (_sourceName, locale) => (locale === 'zh_cn' ? { d6e15f31: '有译文' } : {}),
  )
  const zh = review.summaries.find((item) => item.locale === 'zh_cn')
  const ja = review.summaries.find((item) => item.locale === 'ja_jp')
  assert.equal(zh?.missing, 1, 'zh_cn 缺 1 个键')
  assert.equal(ja?.missing, 2, 'ja_jp 两句都缺')
  assert.equal(review.warnings.length, 2)
  assert.match(review.warnings[0]!, /^\[zh_cn\] 1 of 2 keys have no translation/)
  assert.match(review.warnings[0]!, /list_lang_keys/)
  for (const warning of review.warnings) {
    assert.equal(/\p{Script=Han}/u.test(warning), false, `agent 警告必须英文：${warning}`)
  }
})

console.log(`通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  throw new Error(`语言锁验证失败：${failures.join('；')}`)
}
