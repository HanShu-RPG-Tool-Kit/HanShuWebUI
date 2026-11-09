/**
 * Agent 工具三语义（read / lock / write）验收脚本（修正草案 D2 两把锁后的版本）。
 *
 * 用一个纯内存的假 AgentHost + 假 AgentToolArbiter，验证 `src/agent/tools.ts` 的派发纪律：
 * - 工具集固定 19 个：8 read + 4 lock（lock_source / unlock_source / lock_lang / unlock_lang）+ 7 write；
 *   不含 rename_source / delete_source（D1b：agent 零 S 写入，改名删除由用户自己做）；
 * - 未持锁的 write 被拒绝，且**根本不会调用 host**（严格模式）；
 * - 写成功**不释放锁**：lock 一次可以连续写多次，不需要反复 lock（D2）；
 * - unlock_source 幂等，held 列调用后本 Run 仍持有的**全部**路径（P3）；
 * - lock_source 只锁源文件，不再展开派生语言资产（语言用 lock_lang 单独锁）；
 * - 语言类写工具需要「源锁 + 目标语言锁」，缺 lock_lang 时拒绝且不触达宿主；
 * - 每个 write 工具成功返回写后 version；changed 由写后版本与持锁版本比较得出（P7）；
 *   未知工具名返回 ok:false。
 *
 * 运行：node scripts/run-verification.mjs scripts/verify-agent-tools.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  AGENT_TOOLS,
  AGENT_TOOL_KINDS,
  AGENT_TOOL_NAMES,
  executeAgentTool,
  type AgentToolCall,
} from '../src/agent/tools'
import type { AgentHost, AgentToolArbiter } from '../src/agent/contracts'

/** 内容哈希：真实运行时是 SHA 内容哈希，这里用短哈希便于断言 */
const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12)

const LANGS = ['zh_cn', 'en_us']
const CURRENT_LOCALE = 'zh_cn'

/** 派生语言资产路径：与真实宿主同口径（assets/<locale>/lang_<ext>/<base>.lang） */
function langPath(source: string, locale: string): string {
  const dot = source.lastIndexOf('.')
  const base = dot >= 0 ? source.slice(0, dot) : source
  const ext = dot >= 0 ? source.slice(dot + 1) : ''
  return `assets/${locale}/lang_${ext}/${base}.lang`
}

function deriveLangTargets(
  source: string,
  locales?: string[],
): Array<{ locale: string; path: string }> {
  const list = locales !== undefined && locales.length > 0 ? locales : LANGS
  return list.map((locale) => ({ locale, path: langPath(source, locale) }))
}

/**
 * 内存世界：源文件表 + 语言资产表 + 锁集合 + 本 Run 读版本表。
 * 假实现刻意和真仲裁层同构：lock 先全验后全落锁、assertWritable 只认锁、
 * noteWritten 刷新锁版本但**不释放锁**。tools.ts 的调用顺序一旦写错，这里就会失败。
 */
function makeWorld(
  initialSources: Record<string, string> = {},
  initialAssets: Record<string, string> = {},
) {
  const sources = new Map<string, string>(Object.entries(initialSources))
  const assets = new Map<string, string>(Object.entries(initialAssets))
  /** 本 Run 最后读到的版本；lock 的 not_read / version_stale 判据 */
  const readVersions = new Map<string, string>()
  /** 当前持有的锁（源文件与 .lang 共用一张表）；creating 记录占名语义 */
  const locks = new Map<string, { creating: boolean; version: string }>()
  /** noteWritten 的调用记录（路径顺序） */
  const notes: string[] = []
  /** arbiter.read 的调用记录，用来证明 read_source 没有绕过仲裁层 */
  const arbiterReads: string[] = []
  /** arbiter.read 收到的分页参数（校验「非法参数不触达仲裁/宿主」） */
  const arbiterReadArgs: Array<{ offset: number | undefined; limit: number | undefined }> = []
  /** assertWritable 的调用记录（校验「参数/键问题先于锁校验」） */
  const assertWritableCalls: string[] = []
  /** list_voice_status 收到的分页参数（B3 透传） */
  const voicePageArgs: Array<{ offset: number | undefined; limit: number | undefined }> = []
  /** delete_lang_keys 收到的 force 参数 */
  const deleteForces: Array<boolean | undefined> = []
  /** validateSourceName 的调用记录（A2：占名前校验） */
  const validateNameCalls: string[] = []
  /** arbiter.lock 实际收到的路径（A2：应使用校验后的规范名） */
  const lockPaths: string[] = []
  const counters = {
    listSources: 0,
    readSource: 0,
    createSource: 0,
    writeSource: 0,
    editSource: 0,
    validateSource: 0,
    getActiveFilePath: 0,
    listLocales: 0,
    listLangKeys: 0,
    writeLang: 0,
    deleteLangKeys: 0,
    listVoiceStatus: 0,
    parseHs: 0,
    unparseHs: 0,
    checkExport: 0,
    derivedLangTargets: 0,
    readAssetText: 0,
  }

  /** 源文件或语言资产的内容；不存在返回 undefined */
  const contentOf = (path: string): string | undefined =>
    sources.get(path) ?? assets.get(path)

  const host: AgentHost = {
    listSources: () => {
      counters.listSources += 1
      return {
        ok: true,
        packages: ['default'],
        sources: [...sources.keys()].map((name) => ({
          name,
          // detached 资源（工程目录外）：只能读、不能写（6-A 透传）
          detached: name.includes('detached'),
        })),
      }
    },
    readSource: (source, offset, limit) => {
      counters.readSource += 1
      const content = sources.get(source)
      if (content === undefined) return { ok: false, error: `File not found: ${source}` }
      const lines = content.split(String.fromCharCode(10))
      const start = Math.max(0, (offset ?? 1) - 1)
      const end = limit === undefined ? undefined : start + limit
      return {
        ok: true,
        source,
        content: lines.slice(start, end).join(String.fromCharCode(10)),
        version: hash(content),
      }
    },
    createSource: (source, content) => {
      counters.createSource += 1
      if (sources.has(source)) return { ok: false, error: `Source already exists: ${source}` }
      sources.set(source, content)
      return { ok: true, source }
    },
    writeSource: (source, content) => {
      counters.writeSource += 1
      const previous = sources.get(source)
      if (previous === undefined) return { ok: false, error: `Source not found: ${source}` }
      sources.set(source, content)
      // 宿主如实回报「内容是否变化」；工具层 P7 会再用写后版本覆盖它
      return { ok: true, source, changed: previous !== content }
    },
    editSource: (source, oldText, newText, replaceAll) => {
      counters.editSource += 1
      const content = sources.get(source)
      if (content === undefined) return { ok: false, error: `Source not found: ${source}` }
      if (!oldText) return { ok: false, error: 'oldText must not be empty' }
      const hits = content.split(oldText).length - 1
      if (hits === 0) return { ok: false, error: 'oldText not found' }
      if (hits > 1 && replaceAll !== true) return { ok: false, error: 'oldText matched multiple times' }
      const next =
        replaceAll === true
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText)
      sources.set(source, next)
      return { ok: true, source }
    },
    validateSource: (source) => {
      counters.validateSource += 1
      return { ok: true, source, diagnostics: [] }
    },
    getActiveFilePath: () => {
      counters.getActiveFilePath += 1
      return { ok: true, name: '序章.hs', kind: 'hanshu', path: 'src/hanshu/序章.hs' }
    },
    validateSourceName: (name) => {
      validateNameCalls.push(name)
      // A2 假宿主：拒绝目录/绝对路径/保留字符；接受的名字规范化出 `.hs` 后缀
      if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes(':')) {
        return {
          ok: false,
          error: `invalid name: ${name}`,
          hint: 'Use a plain logical file name such as "chapter.hs".',
        }
      }
      const canonical = /\.(hs|md|char)$/i.test(name) ? name : `${name}.hs`
      return { ok: true, name: canonical }
    },
    listLocales: () => {
      counters.listLocales += 1
      return { ok: true, locales: LANGS }
    },
    derivedLangTargets: (source, locales) => {
      counters.derivedLangTargets += 1
      return deriveLangTargets(source, locales)
    },
    readAssetText: async (path) => {
      counters.readAssetText += 1
      return assets.get(path) ?? null
    },
    listLangKeys: async (source, locale, offset, limit) => {
      counters.listLangKeys += 1
      // 宿主阶段 2-A 的草稿语义：读草稿优先，字段由工具层原样透传（工具不改写）
      return {
        ok: true,
        source,
        locale: locale ?? CURRENT_LOCALE,
        path: langPath(source, locale ?? CURRENT_LOCALE),
        draft: true,
        saved: false,
        version: 'draft-version',
        localDraft: true,
        // 6-A：语言文件是否存在 / 是否为当前语言，也要原样透传
        localeExists: true,
        active: (locale ?? CURRENT_LOCALE) === CURRENT_LOCALE,
        offset: offset ?? 1,
        limit: limit ?? 200,
        keys: [],
      }
    },
    writeLang: async (source, translations) => {
      counters.writeLang += 1
      const writtenPaths: string[] = []
      const locales: Array<Record<string, unknown>> = []
      for (const [locale, entries] of Object.entries(translations)) {
        const path = langPath(source, locale)
        assets.set(path, entries.map((entry) => `${entry.key} # ${entry.text}`).join(String.fromCharCode(10)))
        writtenPaths.push(path)
        // 故意返回旧宿主那套「已保存」字段：工具层必须统一改写成草稿标记
        locales.push({ locale, path, written: entries.length, saved: true, savedToProject: true })
      }
      return { ok: true, source, writtenPaths, locales, saved: true, version: 'host-version' }
    },
    deleteLangKeys: async (source, keys, locale, force) => {
      counters.deleteLangKeys += 1
      deleteForces.push(force)
      const path = langPath(source, locale ?? CURRENT_LOCALE)
      assets.set(path, '')
      return { ok: true, source, removed: keys.length, writtenPaths: [path], saved: true, version: 'host-version' }
    },
    listVoiceStatus: async (source, locale, offset, limit) => {
      counters.listVoiceStatus += 1
      voicePageArgs.push({ offset, limit })
      return {
        ok: true,
        source,
        locale: locale ?? CURRENT_LOCALE,
        total: 0,
        truncated: false,
        missingCount: 0,
        missingSample: [],
        entries: [],
      }
    },
    parseHs: async (source, locale) => {
      counters.parseHs += 1
      const path = langPath(source, locale ?? CURRENT_LOCALE)
      if (!assets.has(path)) assets.set(path, '')
      return { ok: true, source, writtenPaths: [path], saved: true, version: 'host-version' }
    },
    unparseHs: async (source, locale) => {
      counters.unparseHs += 1
      return { ok: true, source, locale: locale ?? CURRENT_LOCALE, writtenPaths: [source] }
    },
    checkExport: async () => {
      counters.checkExport += 1
      // 6-A：宿主会新增 truncated / warningTotal，工具层只透传
      return { ok: true, files: 0, warnings: [], truncated: false, warningTotal: 3 }
    },
  }

  const MAX_PAGE_LINES = 2000

  const arbiter: AgentToolArbiter = {
    read: async (source, offset, limit) => {
      arbiterReads.push(source)
      arbiterReadArgs.push({ offset, limit })
      const content = sources.get(source)
      if (content === undefined) return { ok: false, error: `File not found: ${source}` }
      const version = hash(content)
      // 关键：read 要登记「本 Run 读过这一版」，否则后面的 lock 一律 not_read
      readVersions.set(source, version)
      const lines = content.split(String.fromCharCode(10))
      const totalLines = lines.length
      const start = (offset ?? 1) - 1
      if (start >= totalLines) {
        // 6-B：offset 越界由宿主/仲裁层给 ok:false，工具只透传
        return {
          ok: false,
          error: `offset ${offset} is out of range`,
          totalLines,
          hint: `The file only has ${totalLines} lines. Use a smaller offset.`,
        }
      }
      const requested = limit ?? 400
      const limitClamped = requested > MAX_PAGE_LINES
      const count = limitClamped ? MAX_PAGE_LINES : requested
      return {
        ok: true,
        source,
        version,
        content: lines.slice(start, start + count).join(String.fromCharCode(10)),
        totalLines,
        limitClamped,
        offset: start + 1,
        limit: count,
      }
    },
    lock: async (paths, options) => {
      const creating = options?.creating === true
      lockPaths.push(...paths)
      // 多路径原子：先全部校验，再统一落锁；任何一条失败都不得留下半套锁
      for (const path of paths) {
        const content = sources.get(path)
        if (creating) {
          if (content !== undefined) {
            return {
              locked: false,
              reason: 'already_exists',
              currentVersion: hash(content),
              currentContent: content,
              hint: 'Target already exists. Do not pass creating: true; use write_source instead.',
            }
          }
          continue
        }
        if (content === undefined) {
          return {
            locked: false,
            reason: 'not_found',
            hint: 'File not found. Pass creating: true to reserve a new name.',
          }
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
            hint: 'Content changed since last read. Read again, then lock.',
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
      return { locked: true, version: creating ? '' : hash(firstContent), content: firstContent }
    },
    lockLang: async (source, locales) => {
      // 语言锁与源文件锁同表；已存在的 .lang 记录版本（隐式读，与真仲裁层一致），
      // 不存在的按 creating 占位。多语言原子：这里没有失败分支（单 Run），直接全落锁。
      const targets = deriveLangTargets(source, locales)
      const langs = targets.map((item) => {
        const content = assets.get(item.path)
        const existed = content !== undefined
        const version = existed ? hash(content) : null
        locks.set(item.path, { creating: !existed, version: version ?? '' })
        return { locale: item.locale, path: item.path, existed, version }
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
      const targets = deriveLangTargets(source, locales)
      const released: string[] = []
      for (const item of targets) {
        if (locks.delete(item.path)) released.push(item.path)
      }
      return released
    },
    isLocked: (path) => locks.has(path),
    heldPaths: () => [...locks.keys()],
    assertWritable: async (path, options) => {
      assertWritableCalls.push(path)
      const creating = options?.creating === true
      const held = locks.get(path)
      if (creating) {
        if (held === undefined || !held.creating) {
          return {
            ok: false,
            error: `Path not reserved: ${path}`,
            hint: `Call lock_source({ "paths": ["${path}"], "creating": true }) first.`,
            reason: 'not_read',
          }
        }
        if (sources.has(path)) {
          return {
            ok: false,
            error: `Path already exists: ${path}`,
            hint: 'Use write_source instead.',
            reason: 'already_exists',
          }
        }
        return { ok: true, version: '' }
      }
      if (held === undefined) {
        return {
          ok: false,
          error: `Path not locked: ${path}`,
          hint: `Call lock_source({ "paths": ["${path}"] }) first (lock_lang for language files).`,
          reason: 'not_read',
        }
      }
      const content = contentOf(path)
      if (content === undefined) {
        // creating 锁（尚不存在的 .lang / 新文件）：允许写，宿主会新建
        return { ok: true, version: held.version }
      }
      const version = hash(content)
      if (held.version !== version) {
        return {
          ok: false,
          error: `Content changed after locking: ${path}`,
          hint: 'Re-read and lock again (lock_lang for language files).',
          reason: 'version_stale',
        }
      }
      return { ok: true, version }
    },
    noteWritten: async (path) => {
      notes.push(path)
      const content = contentOf(path)
      if (content === undefined) return null
      const version = hash(content)
      readVersions.set(path, version)
      const held = locks.get(path)
      // D2：只刷新锁锚点，**不释放锁**
      if (held !== undefined) locks.set(path, { ...held, creating: false, version })
      return version
    },
    endRound: () => {
      locks.clear()
      readVersions.clear()
    },
  }

  return {
    sources,
    assets,
    readVersions,
    locks,
    notes,
    arbiterReads,
    arbiterReadArgs,
    assertWritableCalls,
    voicePageArgs,
    deleteForces,
    validateNameCalls,
    lockPaths,
    counters,
    host,
    arbiter,
    target: { host, arbiter },
  }
}

type World = ReturnType<typeof makeWorld>

let callSeq = 0
function makeCall(name: string, args: Record<string, unknown> = {}): AgentToolCall {
  callSeq += 1
  return {
    id: `call_${callSeq}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

async function run(
  world: World,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const raw = await executeAgentTool(world.target, makeCall(name, args))
  return JSON.parse(raw) as Record<string, any>
}

/* ── D5：工具 JSON 里的 agent 文案（error/hint/notes/summary/warnings/message）必须英文 ── */

const CJK_PATTERN = /\p{Script=Han}/u
const AGENT_TEXT_KEYS = new Set(['error', 'hint', 'notes', 'summary', 'warnings', 'message'])

/** 递归收集 agent 文案字段；diagnostics 是编辑器诊断数据（中文属于 UI），不参与扫描 */
function collectAgentTextFields(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectAgentTextFields(item, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'diagnostics' || key === 'invalidKeys' || key === 'duplicates') continue
    if (AGENT_TEXT_KEYS.has(key)) {
      if (typeof item === 'string') out.push(item)
      else collectAgentTextFields(item, out)
      continue
    }
    if (item && typeof item === 'object') collectAgentTextFields(item, out)
  }
  return out
}

function assertAgentTextIsEnglish(tool: string, raw: string): void {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const chinese = collectAgentTextFields(parsed).filter((text) => CJK_PATTERN.test(text))
  assert.deepEqual(chinese, [], `${tool} 的 error/hint/notes/summary 字段不能含中文（D5）`)
}

/** read → lock 是任何源文件写之前的固定前置流程 */
async function readAndLock(world: World, source: string): Promise<void> {
  const read = await run(world, 'read_source', { source })
  assert.equal(read.ok, true, `read_source 应成功：${source}`)
  const locked = await run(world, 'lock_source', { paths: [source] })
  assert.equal(locked.locked, true, `lock_source 应成功：${source}`)
}

/** 新建文件：creating 语义占名 */
async function lockCreating(world: World, source: string): Promise<void> {
  const locked = await run(world, 'lock_source', { paths: [source], creating: true })
  assert.equal(locked.locked, true, `creating lock 应成功：${source}`)
}

/** 语言写的前置：目标语言的 .lang 锁 */
async function lockLangFor(world: World, source: string, locales: string[]): Promise<void> {
  const locked = await run(world, 'lock_lang', { source, locales })
  assert.equal(locked.locked, true, `lock_lang 应成功：${source} ${locales.join(',')}`)
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

await test('工具集固定 19 个（8 read + 4 lock + 7 write），且不含改名/删除', async () => {
  const names = AGENT_TOOLS.map((tool) => tool.function.name)
  assert.equal(names.length, new Set(names).size, '工具名不能重复')
  assert.deepEqual(
    [...AGENT_TOOL_NAMES].sort(),
    [...names].sort(),
    'AGENT_TOOL_NAMES 必须与 AGENT_TOOLS 一致',
  )
  assert.deepEqual(
    [...Object.keys(AGENT_TOOL_KINDS)].sort(),
    [...names].sort(),
    'AGENT_TOOL_KINDS 的键集合必须与工具名集合一致',
  )
  const countByKind = (kind: string) =>
    names.filter((name) => AGENT_TOOL_KINDS[name] === kind).length
  assert.equal(names.length, 19, '工具总数必须是 19（修正草案 D2/D1b）')
  assert.equal(countByKind('read'), 8, 'read 类必须是 8 个')
  assert.equal(countByKind('lock'), 4, 'lock 类必须是 4 个')
  assert.equal(countByKind('write'), 7, 'write 类必须是 7 个')
  assert.deepEqual(
    names.filter((name) => AGENT_TOOL_KINDS[name] === 'lock').sort(),
    ['lock_lang', 'lock_source', 'unlock_lang', 'unlock_source'],
  )
  assert.ok(!names.includes('rename_source'), 'agent 不再提供 rename_source（D1b）')
  assert.ok(!names.includes('delete_source'), 'agent 不再提供 delete_source（D1b）')
  assert.deepEqual(AGENT_TOOLS.filter((tool) => tool.type !== 'function'), [])
})

await test('未持锁的 write 被拒绝，且 host 从未被调用', async () => {
  const world = makeWorld({ '序章.hs': '旧正文' })
  const result = await run(world, 'write_source', { source: '序章.hs', content: '新正文' })
  assert.equal(result.ok, false)
  assert.equal(world.counters.writeSource, 0, '未持锁时绝不能调用 host.writeSource')
  assert.match(JSON.stringify(result), /lock_source/, '拒绝体里必须给出 lock_source 的下一步')
  assert.equal(world.sources.get('序章.hs'), '旧正文', '被拒的写不能改动文件')
})

await test('read → lock → write 走通，host 收到新内容且写后锁仍在', async () => {
  const world = makeWorld({ '序章.hs': '旧正文' })
  const read = await run(world, 'read_source', { source: '序章.hs' })
  assert.equal(read.ok, true)
  assert.equal(read.version, hash('旧正文'))
  const locked = await run(world, 'lock_source', { paths: ['序章.hs'] })
  assert.equal(locked.locked, true)
  assert.equal(locked.content, '旧正文', 'lock 成功应顺带回传最新内容')
  const written = await run(world, 'write_source', { source: '序章.hs', content: '新正文' })
  assert.equal(written.ok, true)
  assert.equal(world.counters.writeSource, 1)
  assert.equal(world.sources.get('序章.hs'), '新正文')
  assert.deepEqual(world.notes, ['序章.hs'], '写成功后必须 noteWritten')
  assert.equal(written.version, hash('新正文'), 'write 结果应是写后内容哈希')
  assert.equal(world.arbiter.isLocked('序章.hs'), true, '写成功不释放锁（D2）')
})

await test('写成功不释放锁：lock 一次可以连续写，不需要重新 lock', async () => {
  const world = makeWorld({ '序章.hs': 'v1' })
  await readAndLock(world, '序章.hs')
  const first = await run(world, 'write_source', { source: '序章.hs', content: 'v2' })
  const second = await run(world, 'write_source', { source: '序章.hs', content: 'v3' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(world.counters.writeSource, 2, '两次写都应触达宿主，不能要求重新 lock')
  assert.equal(world.sources.get('序章.hs'), 'v3')
  assert.equal(second.version, hash('v3'))
  assert.equal(world.arbiter.isLocked('序章.hs'), true)
})

await test('lock 版本过期时回传当前版本与内容，write 仍被拒', async () => {
  const world = makeWorld({ '序章.hs': 'agent 读到的正文' })
  await run(world, 'read_source', { source: '序章.hs' })
  // 模拟 read 之后人类改了文件（哈希变化）
  world.sources.set('序章.hs', '用户刚改的正文')
  const denial = await run(world, 'lock_source', { paths: ['序章.hs'] })
  assert.equal(denial.locked, false)
  assert.equal(denial.reason, 'version_stale')
  assert.equal(denial.currentContent, '用户刚改的正文', '失败要回传最新内容供一次往返自愈')
  assert.equal(denial.currentVersion, hash('用户刚改的正文'))
  assert.equal(typeof denial.hint, 'string')
  const rejected = await run(world, 'write_source', { source: '序章.hs', content: 'agent 的写入' })
  assert.equal(rejected.ok, false)
  assert.equal(world.counters.writeSource, 0)
  assert.equal(world.sources.get('序章.hs'), '用户刚改的正文')
})

await test('create_source：目标已存在时 lock(creating) 失败、create 被拒；不存在时成功且 version 非空', async () => {
  // ① 目标已存在：占名失败 → create 不得触达 host
  const occupied = makeWorld({ '已有.hs': '占位正文' })
  const deniedLock = await run(occupied, 'lock_source', { paths: ['已有.hs'], creating: true })
  assert.equal(deniedLock.locked, false)
  assert.equal(deniedLock.reason, 'already_exists')
  assert.equal(deniedLock.currentContent, '占位正文')
  const deniedCreate = await run(occupied, 'create_source', {
    source: '已有.hs',
    content: '覆盖尝试',
  })
  assert.equal(deniedCreate.ok, false)
  assert.equal(occupied.counters.createSource, 0, '未占住名字时 create 不得触达 host')
  assert.equal(occupied.sources.get('已有.hs'), '占位正文')

  // ② 目标不存在：占名成功 → create 成功并返回写后 version（D6：不再是空串）
  const fresh = makeWorld()
  await lockCreating(fresh, '新建.hs')
  const created = await run(fresh, 'create_source', { source: '新建.hs', content: '新文件正文' })
  assert.equal(created.ok, true)
  assert.equal(typeof created.version, 'string', 'create 必须返回 version')
  assert.ok(created.version.length > 0, 'create 的 version 不能是空串')
  assert.equal(created.version, hash('新文件正文'))
  assert.equal(fresh.sources.get('新建.hs'), '新文件正文')
  assert.deepEqual(fresh.notes, ['新建.hs'])
})

await test('read_source 走 arbiter.read 而不是 host.readSource', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const read = await run(world, 'read_source', { source: '序章.hs' })
  assert.equal(read.ok, true)
  assert.equal(world.counters.readSource, 0, 'read_source 不得直接调用 host.readSource')
  assert.deepEqual(world.arbiterReads, ['序章.hs'], '必须经 arbiter.read 登记本 Run 读到的版本')
  assert.equal(read.version, hash('正文'))
  const locked = await run(world, 'lock_source', { paths: ['序章.hs'] })
  assert.equal(locked.locked, true, 'arbiter.read 的登记让随后的 lock 通过')
})

await test('read_source 参数校验：非正整数 offset / limit 直接拒绝且不触达宿主', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const badArgs: Array<Record<string, unknown>> = [
    { offset: 0 },
    { offset: -1 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: -2 },
    { limit: 2.5 },
  ]
  for (const extra of badArgs) {
    const result = await run(world, 'read_source', { source: '序章.hs', ...extra })
    const key = 'offset' in extra ? 'offset' : 'limit'
    assert.equal(result.ok, false, JSON.stringify(extra))
    assert.equal(result.error, `${key} must be a positive integer`, JSON.stringify(extra))
    assert.equal(typeof result.hint, 'string')
  }
  assert.equal(world.arbiterReads.length, 0, '参数错误不得调用 arbiter.read')
  assert.equal(world.arbiterReadArgs.length, 0)
  assert.equal(world.counters.readSource, 0, '参数错误不得触达宿主')
})

await test('read_source 透传 totalLines / limitClamped，越界错误原样透传', async () => {
  const content = ['第一行', '第二行', '第三行'].join(String.fromCharCode(10))
  const world = makeWorld({ '序章.hs': content })

  const page = await run(world, 'read_source', { source: '序章.hs', offset: 2, limit: 1 })
  assert.equal(page.ok, true, JSON.stringify(page))
  assert.equal(page.content, '第二行')
  assert.equal(page.totalLines, 3, 'totalLines 要原样透传')
  assert.equal(page.limitClamped, false, 'limitClamped 要原样透传')
  assert.deepEqual(world.arbiterReadArgs, [{ offset: 2, limit: 1 }], '合法参数要传给仲裁层')

  const clamped = await run(world, 'read_source', { source: '序章.hs', offset: 1, limit: 5000 })
  assert.equal(clamped.limitClamped, true)
  assert.equal(clamped.limit, 2000, 'limit 被宿主 clamp 的结果要透传')

  const outOfRange = await run(world, 'read_source', { source: '序章.hs', offset: 10 })
  assert.equal(outOfRange.ok, false, 'offset 越界由宿主给 ok:false')
  assert.match(String(outOfRange.error), /out of range/)
  assert.equal(outOfRange.totalLines, 3, '越界错误里的 totalLines 也要透传')
  assert.equal(typeof outOfRange.hint, 'string')
})

await test('read 工具透传宿主新字段：detached / localeExists+active / truncated+warningTotal', async () => {
  const world = makeWorld({ 'detached.hs': '正文' })
  const listed = await run(world, 'list_sources', {})
  assert.equal(listed.ok, true)
  const entry = (listed.sources as Array<Record<string, unknown>>).find(
    (item) => item.name === 'detached.hs',
  )
  assert.equal(entry?.detached, true, 'list_sources.detached 要透传')

  const keys = await run(world, 'list_lang_keys', { source: 'detached.hs' })
  assert.equal(keys.localeExists, true, 'list_lang_keys.localeExists 要透传')
  assert.equal(keys.active, true, 'list_lang_keys.active 要透传')

  const exported = await run(world, 'check_export', {})
  assert.equal(exported.truncated, false, 'check_export.truncated 要透传')
  assert.equal(exported.warningTotal, 3, 'check_export.warningTotal 要透传')
})

await test('宿主抛出的 Error 被转成结构化 {ok:false,error,hint}，不逃逸为异常', async () => {
  const world = makeWorld()
  world.host.getActiveFilePath = () => {
    throw new Error('resource name is not unique: 序章.hs')
  }
  const raw = await executeAgentTool(world.target, makeCall('get_active_file_path'))
  const parsed = JSON.parse(raw) as { ok: boolean; error: string; hint: string }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /resource name is not unique/)
  assert.equal(typeof parsed.hint, 'string')
  assert.match(parsed.hint, /unexpected error/)
  assert.match(parsed.hint, /list_sources/)
})

await test('未知工具名返回 ok:false', async () => {
  const world = makeWorld()
  const raw = await executeAgentTool(world.target, makeCall('不存在的工具'))
  const parsed = JSON.parse(raw) as { ok: boolean; error: string }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /unknown tool/)
})

await test('write 工具成功只返回草稿标记：源文件给本地 version，语言写给 draft/saved/version:null', async () => {
  const writeCases: Array<{
    tool: string
    kind: 'source' | 'lang'
    prepare: (world: World) => Promise<Record<string, unknown>>
  }> = [
    {
      tool: 'create_source',
      kind: 'source',
      prepare: async (world) => {
        await lockCreating(world, '新建.hs')
        return { source: '新建.hs', content: '新文件正文' }
      },
    },
    {
      tool: 'write_source',
      kind: 'source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', content: '覆盖后的正文' }
      },
    },
    {
      tool: 'edit_source',
      kind: 'source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', oldText: '原文', newText: '改后' }
      },
    },
    {
      tool: 'write_lang',
      kind: 'lang',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        await lockLangFor(world, '序章.hs', ['zh_cn'])
        return { source: '序章.hs', translations: { zh_cn: [{ key: '7f3a91c2', text: '译文' }] } }
      },
    },
    {
      tool: 'delete_lang_keys',
      kind: 'lang',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        await lockLangFor(world, '序章.hs', ['zh_cn'])
        return { source: '序章.hs', locale: 'zh_cn', keys: ['7f3a91c2'] }
      },
    },
    {
      tool: 'parse_hs',
      kind: 'lang',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        await lockLangFor(world, '序章.hs', ['zh_cn'])
        return { source: '序章.hs', locale: 'zh_cn' }
      },
    },
    {
      tool: 'unparse_hs',
      kind: 'source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', locale: 'zh_cn' }
      },
    },
  ]
  for (const item of writeCases) {
    const world = makeWorld({ '序章.hs': '原文正文' })
    const args = await item.prepare(world)
    const result = await run(world, item.tool, args)
    const serialized = JSON.stringify(result)
    assert.equal(result.ok, true, `${item.tool} 应成功：${serialized}`)
    assert.equal(result.draft, true, `${item.tool} 必须返回 draft:true`)
    assert.equal(result.saved, false, `${item.tool} 不能声称已保存（saved:false）`)
    assert.match(String(result.hint), /save the project/i, `${item.tool} hint 要提醒保存工程`)
    assert.equal(serialized.includes('"saved":true'), false, `${item.tool} 不能出现 saved:true`)
    assert.equal('versions' in result, false, `${item.tool} 不再返回 versions`)
    if (item.kind === 'source') {
      assert.equal(typeof result.version, 'string', `${item.tool} 应返回本地 version`)
      assert.ok((result.version as string).length > 0, `${item.tool} 的本地 version 不应为空`)
    } else {
      assert.equal(result.version, null, `${item.tool} 语言写 version 必须是 null`)
      assert.ok(Array.isArray(result.writtenPaths), `${item.tool} 应返回 writtenPaths`)
      if (Array.isArray(result.locales)) {
        for (const entry of result.locales) {
          assert.equal(entry.draft, true, `${item.tool} 逐条结果要标 draft:true`)
          assert.equal(entry.saved, false, `${item.tool} 逐条结果要标 saved:false`)
          assert.equal(entry.savedToProject, false, `${item.tool} 逐条结果不能声称 savedToProject`)
        }
      }
    }
  }
  assert.equal(writeCases.length, 7, 'write 类工具应全部覆盖到')
})

await test('语言写成功只返回草稿标记，逐条 locales 也标草稿（无 saved:true）', async () => {
  const world = makeWorld({ '序章.hs': '原文正文' })
  await readAndLock(world, '序章.hs')
  await lockLangFor(world, '序章.hs', ['zh_cn'])
  const result = await run(world, 'write_lang', {
    source: '序章.hs',
    translations: { zh_cn: [{ key: '7f3a91c2', text: '译文' }] },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.draft, true)
  assert.equal(result.saved, false)
  assert.equal(result.version, null, '语言写不能返回落盘版本')
  assert.match(String(result.hint), /save the project/i)
  assert.deepEqual(result.writtenPaths, [langPath('序章.hs', 'zh_cn')])
  assert.equal(JSON.stringify(result).includes('"saved":true'), false)
  assert.equal(result.locales[0].draft, true)
  assert.equal(result.locales[0].saved, false)
  assert.equal(result.locales[0].savedToProject, false)
  // 工具层仍要登记草稿版本给锁表用（但不出现在返回体）
  assert.ok(world.notes.includes('序章.hs'))
  assert.ok(world.notes.includes(langPath('序章.hs', 'zh_cn')))
})

await test('list_lang_keys 透传宿主的 draft / saved 字段', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const result = await run(world, 'list_lang_keys', { source: '序章.hs' })
  assert.equal(result.ok, true)
  assert.equal(result.draft, true, '宿主给的 draft 要透传')
  assert.equal(result.saved, false, '宿主给的 saved 要透传')
  assert.equal(result.version, 'draft-version', '草稿版本原样透传')
  assert.equal(world.counters.listLangKeys, 1)
})

await test('write_lang 键格式校验：大写/非法进 invalidKeys，且不触达锁与宿主', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const result = await run(world, 'write_lang', {
    source: '序章.hs',
    translations: {
      zh_cn: [
        { key: '7F3A91C2', text: '大写' },
        { key: 'not-a-key', text: '非法' },
      ],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid translation keys')
  assert.deepEqual([...result.invalidKeys].sort(), ['7F3A91C2', 'not-a-key'].sort())
  assert.deepEqual(result.duplicates, [])
  assert.equal(typeof result.hint, 'string')
  assert.match(String(result.hint), /lowercase hex/)
  assert.equal(world.counters.writeLang, 0, '键非法不得调用宿主')
  assert.equal(world.assertWritableCalls.length, 0, '键校验先于锁校验')
})

await test('write_lang 同语言重复键进 duplicates；跨语言同键不算重复', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const dup = await run(world, 'write_lang', {
    source: '序章.hs',
    translations: {
      zh_cn: [
        { key: '7f3a91c2', text: 'a' },
        { key: '7f3a91c2', text: 'b' },
      ],
    },
  })
  assert.equal(dup.ok, false)
  assert.deepEqual(dup.duplicates, ['7f3a91c2'])
  assert.deepEqual(dup.invalidKeys, [])
  assert.equal(world.counters.writeLang, 0)

  // 跨语言同一个 key 是正常的（同一句台词的多语言译文），应进入锁校验而不是键校验
  const cross = await run(world, 'write_lang', {
    source: '序章.hs',
    translations: {
      zh_cn: [{ key: '7f3a91c2', text: '中文' }],
      en_us: [{ key: '7f3a91c2', text: 'English' }],
    },
  })
  assert.equal(cross.ok, false)
  assert.notEqual(cross.error, 'invalid translation keys', '跨语言同键不是重复')
  assert.match(JSON.stringify(cross), /lock_source/, '应走到严格的锁校验')
  assert.equal(world.assertWritableCalls[0], '序章.hs')
  assert.equal(world.counters.writeLang, 0)
})

await test('delete_lang_keys 键格式校验：非法与重复都拒绝，且不触达锁与宿主', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  const result = await run(world, 'delete_lang_keys', {
    source: '序章.hs',
    locale: 'zh_cn',
    keys: ['7F3A91C2', 'bad-key', '7f3a91c2', '7f3a91c2'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'invalid translation keys')
  assert.deepEqual([...result.invalidKeys].sort(), ['7F3A91C2', 'bad-key'].sort())
  assert.deepEqual(result.duplicates, ['7f3a91c2'])
  assert.equal(world.counters.deleteLangKeys, 0)
  assert.equal(world.assertWritableCalls.length, 0)
})

await test('写后 version 非空且等于写后内容哈希（create / write / edit / unparse）', async () => {
  const createWorld = makeWorld()
  await lockCreating(createWorld, '新建.hs')
  const created = await run(createWorld, 'create_source', { source: '新建.hs', content: '新建正文' })
  assert.equal(created.version, hash('新建正文'))

  const writeWorld = makeWorld({ '序章.hs': '旧正文' })
  await readAndLock(writeWorld, '序章.hs')
  const written = await run(writeWorld, 'write_source', { source: '序章.hs', content: '新正文' })
  assert.equal(typeof written.version, 'string')
  assert.ok(String(written.version).length > 0)
  assert.equal(written.version, hash('新正文'))

  const editWorld = makeWorld({ '序章.hs': '第一段 第二段' })
  await readAndLock(editWorld, '序章.hs')
  const edited = await run(editWorld, 'edit_source', {
    source: '序章.hs',
    oldText: '第一段',
    newText: '改后',
  })
  assert.equal(edited.version, hash('改后 第二段'))

  const unparseWorld = makeWorld({ '序章.hs': '正文' })
  await readAndLock(unparseWorld, '序章.hs')
  const unparsed = await run(unparseWorld, 'unparse_hs', { source: '序章.hs', locale: 'zh_cn' })
  assert.equal(typeof unparsed.version, 'string')
  assert.ok(String(unparsed.version).length > 0)
  assert.equal(unparsed.version, hash('正文'))
})

await test('P7 changed：同内容重写两次为 changed:false 且 version 不再变化', async () => {
  const world = makeWorld({ '序章.hs': '旧正文' })
  await readAndLock(world, '序章.hs')
  const first = await run(world, 'write_source', { source: '序章.hs', content: '同一段正文' })
  assert.equal(first.changed, true, '第一次改了内容 → changed:true')
  const firstVersion = first.version
  const second = await run(world, 'write_source', { source: '序章.hs', content: '同一段正文' })
  assert.equal(second.changed, false, '同内容重写 → changed:false（P7）')
  assert.equal(second.version, firstVersion, '同内容重写 version 不变')
  const third = await run(world, 'write_source', { source: '序章.hs', content: '又一段正文' })
  assert.equal(third.changed, true, '内容真的变了 → changed:true')
  assert.notEqual(third.version, firstVersion)
})

await test('A2 lock_source 占名前若名字非法则拒绝且不触达 arbiter，合法时用规范名去锁', async () => {
  const world = makeWorld()
  const invalid = await run(world, 'lock_source', { paths: ['../evil.hs'], creating: true })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.errorCode, 'invalid_arguments')
  assert.match(String(invalid.error), /invalid file name: \.\.\/evil\.hs/)
  assert.deepEqual(world.validateNameCalls, ['../evil.hs'])
  assert.equal(world.lockPaths.length, 0, '非法名字不得触达 arbiter（不占名）')

  const canonical = await run(world, 'lock_source', { paths: ['chapter'], creating: true })
  assert.equal(canonical.locked, true, JSON.stringify(canonical))
  assert.deepEqual(world.lockPaths, ['chapter.hs'], '必须用宿主返回的规范名去 lock')
  assert.equal(world.arbiter.isLocked('chapter.hs'), true)
})

await test('lock_source 多路径原子：一条失败则一条都不持有', async () => {
  const world = makeWorld({ 'a.hs': 'A', 'b.hs': 'B' })
  await run(world, 'read_source', { source: 'a.hs' })
  const denied = await run(world, 'lock_source', { paths: ['a.hs', 'b.hs'] })
  assert.equal(denied.locked, false)
  assert.equal(denied.reason, 'not_read')
  const aPermit = await world.arbiter.assertWritable('a.hs')
  assert.equal(aPermit.ok, false, 'b 失败时 a 也不能被锁住')
  await run(world, 'read_source', { source: 'b.hs' })
  const granted = await run(world, 'lock_source', { paths: ['a.hs', 'b.hs'] })
  assert.equal(granted.locked, true)
})

await test('lock_source 只锁源文件，不再展开派生语言资产', async () => {
  const world = makeWorld(
    { '序章.hs': '正文' },
    { [langPath('序章.hs', 'zh_cn')]: '旧译文' },
  )
  await readAndLock(world, '序章.hs')
  assert.equal(world.arbiter.isLocked('序章.hs'), true)
  assert.equal(
    world.arbiter.isLocked(langPath('序章.hs', 'zh_cn')),
    false,
    'lock_source 不应顺带锁 .lang（D2：语言用 lock_lang）',
  )
  assert.equal(world.counters.derivedLangTargets, 0, 'lock_source 不应调用 derivedLangTargets')
})

await test('unlock_source 幂等：只释放本 Run 的指定路径，不误放其它锁', async () => {
  const world = makeWorld({ 'a.hs': 'A', 'b.hs': 'B' })
  await readAndLock(world, 'a.hs')
  await readAndLock(world, 'b.hs')
  // held = 调用后本 Run 仍持有的**全部**路径（P3：不是只看本次请求的路径）
  const first = await run(world, 'unlock_source', { paths: ['a.hs'] })
  assert.deepEqual(first.unlocked, ['a.hs'])
  assert.deepEqual(first.held, ['b.hs'], 'a 已释放；b 仍持有，必须出现在 held')
  const second = await run(world, 'unlock_source', { paths: ['a.hs'] })
  assert.deepEqual(second.unlocked, [], '重复解锁应幂等')
  assert.deepEqual(second.held, ['b.hs'])
  assert.equal(world.arbiter.isLocked('b.hs'), true, '不能误放其它路径的锁')
})

await test('write_source 已删除 expectedVersion 参数，模型误传时忽略而不失败', async () => {
  const definition = AGENT_TOOLS.find((tool) => tool.function.name === 'write_source')
  assert.ok(definition, '必须有 write_source')
  const parameters = definition.function.parameters as {
    properties: Record<string, unknown>
  }
  assert.equal('expectedVersion' in parameters.properties, false, 'schema 里不能再有 expectedVersion')
  const world = makeWorld({ '序章.hs': '旧正文' })
  await readAndLock(world, '序章.hs')
  const written = await run(world, 'write_source', {
    source: '序章.hs',
    content: '新正文',
    expectedVersion: 123,
  })
  assert.equal(written.ok, true, '误传的 expectedVersion 应被忽略，不影响写入')
  assert.equal(world.sources.get('序章.hs'), '新正文')
})

await test('新工具参数错误返回英文 error/hint', async () => {
  const world = makeWorld()
  const lockLang = await run(world, 'lock_lang', {})
  assert.equal(lockLang.ok, false)
  assert.match(String(lockLang.error), /requires "source"/)
  assert.match(String(lockLang.hint), /get_active_file_path|list_sources/)
  const unlockSource = await run(world, 'unlock_source', {})
  assert.equal(unlockSource.ok, false)
  assert.match(String(unlockSource.error), /requires "paths"/)
})

await test('工具 JSON 的 error/hint/notes/summary/warnings 字段全部英文（D5）', async () => {
  const world = makeWorld({ 'chapter.hs': '正文' })
  const calls: Array<[string, Record<string, unknown>]> = [
    ['write_source', { source: 'chapter.hs', content: 'new content' }],
    ['write_lang', { source: 'chapter.hs', translations: { zh_cn: [{ key: 'BADKEY', text: 'x' }] } }],
    ['delete_lang_keys', { source: 'chapter.hs', keys: ['BADKEY'] }],
    ['lock_source', {}],
    ['unlock_source', {}],
    ['lock_lang', {}],
    ['read_source', { source: 'chapter.hs', offset: 0 }],
    ['unknown_tool', {}],
  ]
  for (const [name, args] of calls) {
    assertAgentTextIsEnglish(name, await executeAgentTool(world.target, makeCall(name, args)))
  }

  // 参数不是合法 JSON：同样是结构化英文错误，不能让 parse 异常逃逸
  const badJson = await executeAgentTool(world.target, {
    id: 'bad-json',
    type: 'function',
    function: { name: 'read_source', arguments: '{not json' },
  })
  assertAgentTextIsEnglish('bad-json', badJson)

  // 宿主抛异常：error/hint 必须英文
  const throwing = makeWorld()
  throwing.host.getActiveFilePath = () => {
    throw new Error('resource name is not unique: chapter.hs')
  }
  assertAgentTextIsEnglish(
    'host-throw',
    await executeAgentTool(throwing.target, makeCall('get_active_file_path')),
  )
})

await test('B4 失败体统一 errorCode（reason 优先，兜底 host_error）', async () => {
  const world = makeWorld({ 'chapter.hs': '正文' })
  // 未持锁写：reason=not_read，同时保留 reason 兼容字段
  const denied = await run(world, 'write_source', { source: 'chapter.hs', content: '新' })
  assert.equal(denied.ok, false)
  assert.equal(denied.errorCode, 'not_read')
  assert.equal(denied.reason, 'not_read')

  // 非法参数 / 非法键 / 未知工具 / 非法 JSON
  const badOffset = await run(world, 'read_source', { source: 'chapter.hs', offset: 0 })
  assert.equal(badOffset.errorCode, 'invalid_arguments')
  const badKeys = await run(world, 'write_lang', {
    source: 'chapter.hs',
    translations: { zh_cn: [{ key: 'BAD', text: 'x' }] },
  })
  assert.equal(badKeys.errorCode, 'invalid_keys')
  const unknown = await run(world, 'nope', {})
  assert.equal(unknown.errorCode, 'unknown_tool')
  const rawBadJson = await executeAgentTool(world.target, {
    id: 'bad-json-2',
    type: 'function',
    function: { name: 'read_source', arguments: '{bad' },
  })
  assert.equal((JSON.parse(rawBadJson) as { errorCode: string }).errorCode, 'invalid_arguments')

  // 宿主抛异常 → host_error
  world.host.getActiveFilePath = () => {
    throw new Error('boom')
  }
  const thrown = await run(world, 'get_active_file_path', {})
  assert.equal(thrown.errorCode, 'host_error')

  // 宿主 offset 越界失败体：透传 total，并补 errorCode=invalid_arguments
  world.host.listLangKeys = async () => ({
    ok: false,
    error: 'offset out of range',
    total: 1,
  })
  const langKeys = await run(world, 'list_lang_keys', { source: 'chapter.hs', offset: 9 })
  assert.equal(langKeys.ok, false)
  assert.equal(langKeys.errorCode, 'invalid_arguments')
  assert.equal(langKeys.total, 1)

  // 宿主 keys_not_in_source：保留 reason / missingKeys，并补 errorCode
  const langWorld = makeWorld({ '序章.hs': '正文' })
  await readAndLock(langWorld, '序章.hs')
  await lockLangFor(langWorld, '序章.hs', ['zh_cn'])
  langWorld.host.writeLang = async () => ({
    ok: false,
    error: 'keys are not in source',
    reason: 'keys_not_in_source',
    missingKeys: ['deadbeef'],
    hint: 'Call parse_hs first.',
  })
  const notInSource = await run(langWorld, 'write_lang', {
    source: '序章.hs',
    translations: { zh_cn: [{ key: 'deadbeef', text: 'x' }] },
  })
  assert.equal(notInSource.errorCode, 'keys_not_in_source')
  assert.equal(notInSource.reason, 'keys_not_in_source')
  assert.deepEqual(notInSource.missingKeys, ['deadbeef'])
})

await test('B5 already_exists 的 hint 不再拼 lock_source；not_read 仍保留锁兜底', async () => {
  // lock_source creating 命中已存在：reason=already_exists，hint 只指向 write_source
  const world = makeWorld({ 'existing.hs': '正文' })
  const lockDenial = await run(world, 'lock_source', {
    paths: ['existing.hs'],
    creating: true,
  })
  assert.equal(lockDenial.locked, false)
  assert.equal(lockDenial.reason, 'already_exists')
  assert.equal(lockDenial.errorCode, 'already_exists')
  assert.equal(String(lockDenial.hint).includes('lock_source'), false, String(lockDenial.hint))

  // not_read：仍追加 lock_source 兜底（deniedJson 路径）
  const writeDenial = await run(world, 'write_source', { source: 'other.hs', content: 'x' })
  assert.equal(writeDenial.errorCode, 'not_read')
  assert.match(String(writeDenial.hint), /lock_source/)
})

await test('B2 list_lang_keys 参数校验与 limit 上限，不合法不触达宿主', async () => {
  const world = makeWorld({ 'chapter.hs': '正文' })
  const badArgs: Array<Record<string, unknown>> = [
    { offset: 0 },
    { offset: -1 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: 1001 },
  ]
  for (const extra of badArgs) {
    const result = await run(world, 'list_lang_keys', { source: 'chapter.hs', ...extra })
    assert.equal(result.ok, false, JSON.stringify(extra))
    assert.equal(result.errorCode, 'invalid_arguments', JSON.stringify(extra))
  }
  assert.equal(world.counters.listLangKeys, 0, '参数非法不得调用宿主')
  const ok = await run(world, 'list_lang_keys', {
    source: 'chapter.hs',
    offset: 1,
    limit: 1000,
  })
  assert.equal(ok.ok, true)
  assert.equal(world.counters.listLangKeys, 1)
})

await test('B3 list_voice_status 分页参数校验并透传宿主', async () => {
  const world = makeWorld({ 'chapter.hs': '正文' })
  for (const extra of [{ offset: 0 }, { limit: 501 }] as Array<Record<string, unknown>>) {
    const bad = await run(world, 'list_voice_status', { source: 'chapter.hs', ...extra })
    assert.equal(bad.ok, false, JSON.stringify(extra))
    assert.equal(bad.errorCode, 'invalid_arguments', JSON.stringify(extra))
  }
  assert.equal(world.counters.listVoiceStatus, 0, '参数非法不得调用宿主')
  const page = await run(world, 'list_voice_status', {
    source: 'chapter.hs',
    locale: 'en_us',
    offset: 2,
    limit: 10,
  })
  assert.equal(page.ok, true)
  assert.deepEqual(world.voicePageArgs, [{ offset: 2, limit: 10 }], '分页参数要透传')
  assert.equal(page.total, 0)
  assert.equal(page.truncated, false)
})

await test('delete_lang_keys 的 force 参数透传宿主', async () => {
  const world = makeWorld({ '序章.hs': '正文' })
  await readAndLock(world, '序章.hs')
  await lockLangFor(world, '序章.hs', ['zh_cn'])
  const forced = await run(world, 'delete_lang_keys', {
    source: '序章.hs',
    locale: 'zh_cn',
    keys: ['7f3a91c2'],
    force: true,
  })
  assert.equal(forced.ok, true, JSON.stringify(forced))
  assert.deepEqual(world.deleteForces, [true])
})

await test('B8/N1/N2：工具描述说明 savedVersion / fileTotal / 键身份语义', async () => {
  const description = (name: string): string => {
    const tool = AGENT_TOOLS.find((item) => item.function.name === name)
    assert.ok(tool, `缺少工具 ${name}`)
    return tool.function.description
  }
  const listDesc = description('list_lang_keys')
  for (const keyword of [
    'localeExists',
    'hasSaved',
    'hasLocalMirror',
    'savedVersion',
    'savedVersion !== null',
    'hasDraft',
    'localeInProject',
    '正文键数',
  ]) {
    assert.ok(listDesc.includes(keyword), `list_lang_keys 描述缺少 ${keyword}`)
  }
  const writeDesc = description('write_lang')
  for (const keyword of ['fileTotal', '孤儿键', 'warnings', '只警告不拒绝']) {
    assert.ok(writeDesc.includes(keyword), `write_lang 描述缺少 ${keyword}`)
  }
  const parseDesc = description('parse_hs')
  for (const keyword of ['created', 'replaced', '唯一键数', '正文语句数']) {
    assert.ok(parseDesc.includes(keyword), `parse_hs 描述缺少 ${keyword}`)
  }
  assert.ok(
    parseDesc.includes('不是') && parseDesc.includes('旧译文'),
    'parse_hs 描述要澄清 replaced 不是覆盖旧译文条数',
  )
  const deleteDesc = description('delete_lang_keys')
  assert.ok(deleteDesc.includes('哈希'), 'delete_lang_keys 描述要说明键名是文本哈希')
  assert.ok(deleteDesc.includes('别删该条目'), 'delete_lang_keys 描述要提醒保键身份')
})

await test('每个 write 工具描述都要求先 lock_source，语言写还要 lock_lang 且标草稿；read 工具标注只读', async () => {
  const langWrites = new Set(['write_lang', 'delete_lang_keys', 'parse_hs'])
  for (const tool of AGENT_TOOLS) {
    const name = tool.function.name
    const kind = AGENT_TOOL_KINDS[name]
    if (kind === 'write') {
      assert.match(tool.function.description, /lock_source/, `${name} 的描述必须写明先 lock_source`)
      if (langWrites.has(name)) {
        assert.match(tool.function.description, /lock_lang/, `${name} 的描述必须写明 lock_lang`)
        assert.match(tool.function.description, /本地草稿/, `${name} 的描述必须说明只写本地草稿`)
        assert.match(tool.function.description, /保存工程/, `${name} 的描述必须提醒用户保存工程`)
        assert.equal(
          tool.function.description.includes('draft:true'),
          true,
          `${name} 的描述要写明返回 draft:true`,
        )
      }
      for (const banned of ['立即写进工程文件', '不需要再保存工程', '写入即已保存', '就代表落盘']) {
        assert.equal(
          tool.function.description.includes(banned),
          false,
          `${name} 的描述不能声称已落盘：${banned}`,
        )
      }
    }
    if (kind === 'read') {
      assert.match(tool.function.description, /只读/, `${name} 的描述必须标注只读`)
    }
    if (kind === 'lock') {
      assert.match(tool.function.description, /【lock/, `${name} 的描述必须标注 lock 语义`)
    }
  }
})

console.log(`通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  throw new Error(`Agent 工具协议验证失败：${failures.join('；')}`)
}
