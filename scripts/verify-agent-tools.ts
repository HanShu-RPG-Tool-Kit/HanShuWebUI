/**
 * Agent 工具三语义（read / lock / write）验收脚本。
 *
 * 用一个纯内存的假 AgentHost + 假 AgentToolArbiter，验证 `src/agent/tools.ts` 的派发纪律
 * （文档 §8 三工具协议 / §11 不变量 10「写前必读、写前必锁；未持锁的写一律拒绝」）：
 * - 未持锁的 write 必须被拒绝，且**根本不会调用 host**（严格模式）；
 * - lock → write 走通，host 收到正确内容，write 后 noteWritten 被调用、version 透传；
 * - lock 失败（version_stale）回传 currentVersion / currentContent，write 仍被拒；
 * - create 占名（creating）、rename 源+目标双锁的多路径原子；
 * - read_source 必须走 arbiter.read（登记本 Run 版本），不能直连 host.readSource；
 * - 每个 write 工具成功返回 version；未知工具名返回 ok:false。
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

/** 内容哈希：真实运行时是 SHA 类内容哈希，这里用短哈希便于断言 */
const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex').slice(0, 12)

/**
 * 内存世界：文件表 + 当前锁集合 + 本 Run 读版本表。
 * 假实现刻意和真仲裁层同构（lock 先全验后全落锁、assertWritable 只认锁、noteWritten 消费锁），
 * 这样 tools.ts 的调用顺序一旦写错，这里就会失败。
 */
function makeWorld(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  /** 本 Run 最后读到的版本；lock 的 not_read / version_stale 判据 */
  const readVersions = new Map<string, string>()
  /** 当前持有的锁；creating 记录占名语义 */
  const locks = new Map<string, { creating: boolean; version: string }>()
  /** noteWritten 的调用记录（路径顺序） */
  const notes: string[] = []
  /** arbiter.read 的调用记录，用来证明 read_source 没有绕过仲裁层 */
  const arbiterReads: string[] = []
  const counters = {
    listSources: 0,
    readSource: 0,
    createSource: 0,
    writeSource: 0,
    deleteSource: 0,
    editSource: 0,
    renameSource: 0,
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
  }

  const versionOf = (path: string): string | undefined => {
    const content = files.get(path)
    return content === undefined ? undefined : hash(content)
  }

  const host: AgentHost = {
    listSources: () => {
      counters.listSources += 1
      return { ok: true, sources: [...files.keys()] }
    },
    readSource: (source, offset, limit) => {
      counters.readSource += 1
      const content = files.get(source)
      if (content === undefined) return { ok: false, error: `文件不存在：${source}` }
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
      if (files.has(source)) return { ok: false, error: `同名文件已存在：${source}` }
      files.set(source, content)
      return { ok: true, source, version: hash(content) }
    },
    writeSource: (source, content) => {
      counters.writeSource += 1
      if (!files.has(source)) return { ok: false, error: `文件不存在：${source}` }
      files.set(source, content)
      return { ok: true, source, version: hash(content) }
    },
    deleteSource: async (source) => {
      counters.deleteSource += 1
      if (!files.has(source)) return { ok: false, error: `文件不存在：${source}` }
      files.delete(source)
      return { ok: true, source, deleted: true, version: hash('') }
    },
    editSource: (source, oldText, newText, replaceAll) => {
      counters.editSource += 1
      const content = files.get(source)
      if (content === undefined) return { ok: false, error: `文件不存在：${source}` }
      if (!oldText) return { ok: false, error: 'oldText 不能为空' }
      const hits = content.split(oldText).length - 1
      if (hits === 0) return { ok: false, error: 'oldText 未命中' }
      if (hits > 1 && replaceAll !== true) return { ok: false, error: 'oldText 命中多处' }
      const next =
        replaceAll === true
          ? content.split(oldText).join(newText)
          : content.replace(oldText, newText)
      files.set(source, next)
      return { ok: true, source, version: hash(next) }
    },
    renameSource: async (source, newSource) => {
      counters.renameSource += 1
      const content = files.get(source)
      if (content === undefined) return { ok: false, error: `文件不存在：${source}` }
      if (files.has(newSource)) return { ok: false, error: `目标已存在：${newSource}` }
      files.delete(source)
      files.set(newSource, content)
      return { ok: true, from: source, to: newSource, version: hash(content) }
    },
    validateSource: (source) => {
      counters.validateSource += 1
      return { ok: true, source, diagnostics: [] }
    },
    getActiveFilePath: () => {
      counters.getActiveFilePath += 1
      return { ok: true, name: '序章.hs', kind: 'hanshu', path: 'src/hanshu/序章.hs' }
    },
    listLocales: () => {
      counters.listLocales += 1
      return { ok: true, locales: ['zh_cn'] }
    },
    listLangKeys: async (source, locale, offset, limit) => {
      counters.listLangKeys += 1
      return {
        ok: true,
        source,
        locale: locale ?? 'zh_cn',
        offset: offset ?? 1,
        limit: limit ?? 200,
        keys: [],
      }
    },
    writeLang: async (source, translations) => {
      counters.writeLang += 1
      return {
        ok: true,
        source,
        locales: Object.keys(translations),
        version: versionOf(source) ?? '',
      }
    },
    deleteLangKeys: async (source, keys, locale) => {
      counters.deleteLangKeys += 1
      return {
        ok: true,
        source,
        locale: locale ?? 'zh_cn',
        removed: keys.length,
        version: versionOf(source) ?? '',
      }
    },
    listVoiceStatus: async (source, locale) => {
      counters.listVoiceStatus += 1
      return { ok: true, source, locale: locale ?? 'zh_cn', entries: [] }
    },
    parseHs: async (source, locale) => {
      counters.parseHs += 1
      return { ok: true, source, locale: locale ?? 'zh_cn', version: versionOf(source) ?? '' }
    },
    unparseHs: async (source, locale) => {
      counters.unparseHs += 1
      return { ok: true, source, locale: locale ?? 'zh_cn', version: versionOf(source) ?? '' }
    },
    checkExport: async () => {
      counters.checkExport += 1
      return { ok: true, files: 0, warnings: [] }
    },
  }

  const arbiter: AgentToolArbiter = {
    read: async (source, offset, limit) => {
      arbiterReads.push(source)
      const content = files.get(source)
      if (content === undefined) return { ok: false, error: `文件不存在：${source}` }
      const version = hash(content)
      // 关键：read 要登记「本 Run 读过这一版」，否则后面的 lock 一律 not_read
      readVersions.set(source, version)
      const lines = content.split(String.fromCharCode(10))
      const start = Math.max(0, (offset ?? 1) - 1)
      const end = limit === undefined ? undefined : start + limit
      return {
        ok: true,
        source,
        version,
        content: lines.slice(start, end).join(String.fromCharCode(10)),
        total: lines.length,
      }
    },
    lock: async (paths, options) => {
      const creating = options?.creating === true
      // 多路径原子：先全部校验，再统一落锁；任何一条失败都不得留下半套锁
      for (const path of paths) {
        const content = files.get(path)
        if (creating) {
          if (content !== undefined) {
            return {
              locked: false,
              reason: 'version_stale',
              currentVersion: hash(content),
              currentContent: content,
              hint: '目标已存在：覆盖请用 write_source，或换一个名字',
            }
          }
          continue
        }
        if (content === undefined) {
          return {
            locked: false,
            reason: 'not_found',
            hint: '文件不存在；新建请用 creating: true',
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
            hint: `先 read_source("${path}") 再 lock_source`,
          }
        }
        if (lastRead !== current) {
          return {
            locked: false,
            reason: 'version_stale',
            currentVersion: current,
            currentContent: content,
            hint: '内容已变：重新 read_source 后再 lock_source',
          }
        }
        if (locks.has(path)) {
          return {
            locked: false,
            reason: 'held',
            currentVersion: current,
            currentContent: content,
            hint: '已被占用：换目标或稍后再试',
          }
        }
      }
      for (const path of paths) {
        const content = files.get(path)
        locks.set(path, {
          creating,
          version: creating || content === undefined ? '' : hash(content),
        })
      }
      const first = paths.find((path) => files.has(path))
      const content = first === undefined ? '' : files.get(first) ?? ''
      return { locked: true, version: creating ? '' : hash(content), content }
    },
    assertWritable: async (source, options) => {
      const creating = options?.creating === true
      const held = locks.get(source)
      if (held === undefined || held.creating !== creating) {
        return {
          ok: false,
          error: `未持锁就写入：${source}`,
          hint: `请先调用 lock_source({ paths: ["${source}"]${creating ? ', creating: true' : ''} })`,
        }
      }
      if (creating) {
        if (files.has(source)) {
          return { ok: false, error: `目标已被创建：${source}`, hint: '换一个名字后重新 lock_source' }
        }
        return { ok: true, version: '' }
      }
      const content = files.get(source)
      if (content === undefined) {
        return { ok: false, error: `文件不存在：${source}`, hint: '改用 create_source' }
      }
      const version = hash(content)
      if (version !== held.version) {
        return {
          ok: false,
          error: `持锁后内容被改：${source}`,
          hint: '重新 read_source 后 lock_source',
        }
      }
      return { ok: true, version }
    },
    noteWritten: (source) => {
      notes.push(source)
      // 写成功后锁被消费（文档 §8 锁生命周期①），版本表推进到最新
      locks.delete(source)
      const version = versionOf(source)
      if (version === undefined) readVersions.delete(source)
      else readVersions.set(source, version)
    },
    endRound: () => {
      locks.clear()
    },
  }

  return {
    files,
    readVersions,
    locks,
    notes,
    arbiterReads,
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

/** read → lock 是任何写之前的固定前置流程 */
async function readAndLock(world: World, source: string): Promise<void> {
  const read = await run(world, 'read_source', { source })
  assert.equal(read.ok, true, `read_source 应成功：${source}`)
  const locked = await run(world, 'lock_source', { paths: [source] })
  assert.equal(locked.locked, true, `lock_source 应成功：${source}`)
}

/** 新建/改名的目标名：creating 语义占位 */
async function lockCreating(world: World, source: string): Promise<void> {
  const locked = await run(world, 'lock_source', { paths: [source], creating: true })
  assert.equal(locked.locked, true, `creating lock 应成功：${source}`)
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

await test('工具名集合与 AGENT_TOOL_KINDS 完整一致', async () => {
  const names = AGENT_TOOLS.map((tool) => tool.function.name)
  assert.equal(names.length, new Set(names).size, '工具名不能重复')
  assert.deepEqual(
    [...AGENT_TOOL_NAMES].sort(),
    [...names].sort(),
    'AGENT_TOOL_NAMES 必须与 AGENT_TOOLS 一致',
  )
  const kinds = Object.keys(AGENT_TOOL_KINDS)
  assert.deepEqual(
    [...kinds].sort(),
    [...names].sort(),
    'AGENT_TOOL_KINDS 的键集合必须与工具名集合一致',
  )
  for (const name of names) {
    assert.ok(
      ['read', 'lock', 'write'].includes(AGENT_TOOL_KINDS[name]),
      `${name} 的 kind 必须是 read / lock / write`,
    )
  }
  const countByKind = (kind: string) =>
    names.filter((name) => AGENT_TOOL_KINDS[name] === kind).length
  assert.equal(countByKind('read'), 8, 'read 类必须是 8 个')
  assert.equal(countByKind('lock'), 1, 'lock 类只有 lock_source')
  assert.equal(countByKind('write'), 9, 'write 类必须是 9 个')
  assert.equal(AGENT_TOOL_KINDS.lock_source, 'lock')
  assert.deepEqual(AGENT_TOOLS.filter((tool) => tool.type !== 'function'), [])
})

await test('未持锁的 write 被拒绝，且 host 从未被调用', async () => {
  const world = makeWorld({ '序章.hs': '旧正文' })
  const result = await run(world, 'write_source', { source: '序章.hs', content: '新正文' })
  assert.equal(result.ok, false)
  assert.equal(world.counters.writeSource, 0, '未持锁时绝不能调用 host.writeSource')
  assert.match(JSON.stringify(result), /lock_source/, '拒绝体里必须给出 lock_source 的下一步')
  assert.equal(world.files.get('序章.hs'), '旧正文', '被拒的写不能改动文件')
})

await test('read → lock → write 走通，host 收到新内容且 noteWritten 被调用', async () => {
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
  assert.equal(world.files.get('序章.hs'), '新正文')
  assert.deepEqual(world.notes, ['序章.hs'], '写成功后必须 noteWritten')
  assert.equal(written.version, hash('新正文'), 'write 结果应透传内容哈希')
})

await test('lock 版本过期时回传当前版本与内容，write 仍被拒', async () => {
  const world = makeWorld({ '序章.hs': 'agent 读到的正文' })
  await run(world, 'read_source', { source: '序章.hs' })
  // 模拟 read 之后人类改了文件（哈希变化）
  world.files.set('序章.hs', '用户刚改的正文')
  const denial = await run(world, 'lock_source', { paths: ['序章.hs'] })
  assert.equal(denial.locked, false)
  assert.equal(denial.reason, 'version_stale')
  assert.equal(denial.currentContent, '用户刚改的正文', '失败要回传最新内容供一次往返自愈')
  assert.equal(denial.currentVersion, hash('用户刚改的正文'))
  assert.equal(typeof denial.hint, 'string')
  const rejected = await run(world, 'write_source', { source: '序章.hs', content: 'agent 的写入' })
  assert.equal(rejected.ok, false)
  assert.equal(world.counters.writeSource, 0)
  assert.equal(world.files.get('序章.hs'), '用户刚改的正文')
})

await test('create_source：目标已存在时 lock(creating) 失败、create 被拒；目标不存在时成功', async () => {
  // ① 目标已存在：占名失败 → create 不得触达 host
  const occupied = makeWorld({ '已有.hs': '占位正文' })
  const deniedLock = await run(occupied, 'lock_source', { paths: ['已有.hs'], creating: true })
  assert.equal(deniedLock.locked, false)
  assert.equal(deniedLock.currentContent, '占位正文')
  const deniedCreate = await run(occupied, 'create_source', {
    source: '已有.hs',
    content: '覆盖尝试',
  })
  assert.equal(deniedCreate.ok, false)
  assert.equal(occupied.counters.createSource, 0, '未占住名字时 create 不得触达 host')
  assert.equal(occupied.files.get('已有.hs'), '占位正文')

  // ② 目标不存在：占名成功 → create 成功并返回 version
  const fresh = makeWorld()
  await lockCreating(fresh, '新建.hs')
  const created = await run(fresh, 'create_source', { source: '新建.hs', content: '新文件正文' })
  assert.equal(created.ok, true)
  assert.equal(created.version, hash('新文件正文'))
  assert.equal(fresh.files.get('新建.hs'), '新文件正文')
  assert.deepEqual(fresh.notes, ['新建.hs'])
})

await test('rename_source：源锁成功但目标锁失败时 host.renameSource 不被调用（多路径原子）', async () => {
  const world = makeWorld({ '序章.hs': '正文', '占位.hs': '已存在' })
  await readAndLock(world, '序章.hs')
  const targetDenied = await run(world, 'lock_source', { paths: ['占位.hs'], creating: true })
  assert.equal(targetDenied.locked, false)
  const rename = await run(world, 'rename_source', {
    source: '序章.hs',
    newSource: '占位.hs',
  })
  assert.equal(rename.ok, false)
  assert.equal(world.counters.renameSource, 0, '目标没锁住时 rename 不得触达 host')
  assert.equal(world.files.get('序章.hs'), '正文', '失败时源文件不能被改动')

  // 换成没被占用的名字：两个锁都拿到后 rename 成功，两个路径都 noteWritten
  await lockCreating(world, '序章 改名.hs')
  const renamed = await run(world, 'rename_source', {
    source: '序章.hs',
    newSource: '序章 改名.hs',
  })
  assert.equal(renamed.ok, true)
  assert.equal(world.counters.renameSource, 1)
  assert.equal(world.files.has('序章.hs'), false)
  assert.equal(world.files.get('序章 改名.hs'), '正文')
  assert.equal(renamed.version, hash('正文'))
  assert.deepEqual(world.notes, ['序章.hs', '序章 改名.hs'])
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

await test('未知工具名返回 ok:false', async () => {
  const world = makeWorld()
  const raw = await executeAgentTool(world.target, makeCall('不存在的工具'))
  const parsed = JSON.parse(raw) as { ok: boolean; error: string }
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /未知工具/)
})

await test('每个 write 工具成功后都返回 version（内容哈希）', async () => {
  const writeCases: Array<{
    tool: string
    prepare: (world: World) => Promise<Record<string, unknown>>
  }> = [
    {
      tool: 'create_source',
      prepare: async (world) => {
        await lockCreating(world, '新建.hs')
        return { source: '新建.hs', content: '新文件正文' }
      },
    },
    {
      tool: 'write_source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', content: '覆盖后的正文' }
      },
    },
    {
      tool: 'edit_source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', oldText: '原文', newText: '改后' }
      },
    },
    {
      tool: 'rename_source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        await lockCreating(world, '序章 改名.hs')
        return { source: '序章.hs', newSource: '序章 改名.hs' }
      },
    },
    {
      tool: 'delete_source',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs' }
      },
    },
    {
      tool: 'write_lang',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', translations: { zh_cn: [{ key: '7f3a91c2', text: '译文' }] } }
      },
    },
    {
      tool: 'delete_lang_keys',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', keys: ['7f3a91c2'] }
      },
    },
    {
      tool: 'parse_hs',
      prepare: async (world) => {
        await readAndLock(world, '序章.hs')
        return { source: '序章.hs', locale: 'zh_cn' }
      },
    },
    {
      tool: 'unparse_hs',
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
    assert.equal(result.ok, true, `${item.tool} 应成功`)
    assert.equal(typeof result.version, 'string', `${item.tool} 应返回 version`)
    assert.ok((result.version as string).length > 0, `${item.tool} 的 version 不应为空`)
  }
  assert.equal(writeCases.length, 9, 'write 类工具应全部覆盖到')
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
  assert.equal(world.files.get('序章.hs'), '新正文')
})

await test('每个 write 工具的描述都要求先 lock_source，read 工具标注只读', async () => {
  for (const tool of AGENT_TOOLS) {
    const name = tool.function.name
    const kind = AGENT_TOOL_KINDS[name]
    if (kind === 'write') {
      assert.match(tool.function.description, /lock_source/, `${name} 的描述必须写明先 lock_source`)
    }
    if (kind === 'read') {
      assert.match(tool.function.description, /只读/, `${name} 的描述必须标注只读`)
    }
  }
})

console.log(`通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  throw new Error(`Agent 工具协议验证失败：${failures.join('；')}`)
}
