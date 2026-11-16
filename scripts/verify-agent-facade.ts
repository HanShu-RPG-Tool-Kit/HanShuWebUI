/**
 * AgentRuntime（facade）人机交互细节验收：段重命名 + 「用户停止」待处理回滚的恢复语义。
 *
 * 为什么单独一个脚本：facade 的 `open()` 只认 IndexedDB（`IndexedDbStorage` + 归档段库），
 * 而 Node 下没有浏览器存储。这里用两处**最小注入**把真实 facade 跑起来，而不是重写一套假 facade：
 * - `IndexedDbStorage.open` 换成内存 `MemoryStorage`（对话条目按真实 Harness 路径走）；
 * - `globalThis.indexedDB` 换成只实现撤销日志用到的那一小撮 API 的假工厂（get/put/delete/事务完成事件）。
 * 其余全部是生产代码：createAgentRuntime → open → attach → restorePendingRollback。
 *
 * 覆盖：
 * 1. `renameSegment`：首尾空白裁剪、写回段元数据（localStorage）、返回值 title/updatedAt 正确、重开后仍生效
 * 2. `renameSegment` 参数校验：空标题 / 纯空白 / 超过 80 字拒绝，80 字边界通过
 * 3. 停止（`reason: 'stopped'`）的待处理回滚：打开段时**不自动回滚**，只挂卡片；强制回滚后才写回
 * 4. 失败（`reason: 'failure'`）对照：打开段时安全则自动回滚并清日志
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-facade.ts`
 */
import assert from 'node:assert/strict'
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable'
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb'
import { createAgentRuntime } from '../src/agent/pi/facade'
import { RunUndoLog } from '../src/agent/runtime/runUndo'
import { contentVersion } from '../src/agent/runtime/version'
import {
  IndexedDbUndoJournalBackend,
  undoJournalKey,
  type UndoJournalRecord,
} from '../src/agent/store/undoJournal'
import type { AgentFileWorld, AgentHost, AgentRuntime } from '../src/agent/contracts'

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

/* ───────────────────────── 全局桩：localStorage + indexedDB + IndexedDbStorage ───────────────────────── */

/** 假 localStorage：facade 只存段元数据，这里用 Map 就够（隐私模式降级路径另有真实浏览器覆盖） */
class FakeLocalStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

type FakeRequest = {
  result?: unknown
  error?: Error | null
  onsuccess?: (() => void) | null
  onerror?: (() => void) | null
  onupgradeneeded?: (() => void) | null
}

type FakeStore = { keyPath: string | string[] | null; data: Map<string, unknown> }

/**
 * 假 IndexedDB：只实现撤销日志后端用到的 API（open/升级建库/事务/objectStore 的 get·put·delete/
 * 事务 complete 事件）。刻意不实现游标和索引 —— 归档段库在本脚本里不会被打开；真要用到时它会明确报错，
 * 而不是悄悄返回错误结果。
 */
function makeFakeIndexedDb() {
  const databases = new Map<string, Map<string, FakeStore>>()

  function keyOf(storeName: string, store: FakeStore, key: unknown): string {
    if (key !== undefined && key !== null) return String(key)
    const keyPath = store.keyPath
    if (typeof keyPath === 'string') return String((key as never) ?? '')
    throw new Error(`假 IndexedDB 不支持外部键写入：${storeName}`)
  }

  function storeHandle(name: string, store: FakeStore) {
    return {
      get: (key: unknown) => {
        const request: FakeRequest = {}
        queueMicrotask(() => {
          request.result = store.data.get(String(key))
          request.onsuccess?.()
        })
        return request
      },
      put: (value: unknown, key?: unknown) => {
        store.data.set(keyOf(name, store, key), value)
        const request: FakeRequest = {}
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
      add: (value: unknown, key?: unknown) => {
        const target = keyOf(name, store, key)
        if (store.data.has(target)) {
          const request: FakeRequest = { error: new Error('ConstraintError') }
          queueMicrotask(() => request.onerror?.())
          return request
        }
        store.data.set(target, value)
        const request: FakeRequest = {}
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
      delete: (key: unknown) => {
        store.data.delete(String(key))
        const request: FakeRequest = {}
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
      index: () => {
        throw new Error('假 IndexedDB 不实现索引：本脚本不应打开归档段库')
      },
    }
  }

  const factory = {
    open(name: string) {
      const request: FakeRequest = {}
      let stores = databases.get(name)
      const created = stores === undefined
      if (stores === undefined) {
        stores = new Map()
        databases.set(name, stores)
      }
      const db = {
        objectStoreNames: {
          contains: (storeName: string) => stores!.has(storeName),
        },
        createObjectStore: (storeName: string, options?: { keyPath?: string | string[] }) => {
          stores!.set(storeName, { keyPath: options?.keyPath ?? null, data: new Map() })
          return { name: storeName }
        },
        transaction: (storeNames: string | string[], _mode?: string) => {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames]
          const transaction = {
            error: null as Error | null,
            oncomplete: null as (() => void) | null,
            onabort: null as (() => void) | null,
            onerror: null as (() => void) | null,
            objectStore: (storeName: string) => {
              const store = stores!.get(storeName)
              if (store === undefined) throw new Error(`假 IndexedDB 没有 store：${storeName}`)
              return storeHandle(storeName, store)
            },
          }
          // 事务完成事件要等调用方把 oncomplete 挂上再触发：真实的 IndexedDB 也是异步派发
          queueMicrotask(() => {
            if (transaction.error) transaction.onerror?.()
            else transaction.oncomplete?.()
          })
          void names
          return transaction
        },
        close: () => {},
      }
      request.result = db
      queueMicrotask(() => {
        if (created) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }

  return {
    factory: factory as unknown as IDBFactory,
    /** 每个用例一套独立库，避免上一个用例的日志串进来 */
    reset: () => databases.clear(),
  }
}

const fakeStorage = new FakeLocalStorage()
Object.defineProperty(globalThis, 'localStorage', {
  value: fakeStorage,
  configurable: true,
  writable: true,
})
const fakeIdb = makeFakeIndexedDb()
Object.defineProperty(globalThis, 'indexedDB', {
  value: fakeIdb.factory,
  configurable: true,
  writable: true,
})

/**
 * 对话存储：每个用例换一份空的内存库。
 *
 * 生产里 `IndexedDbStorage.open()` 每次返回一个新的包装对象、底层是同一个 IndexedDB；
 * MemoryStorage 被 `close()` 后就真的废了，所以在它外面套一层代理：`close` 变成空操作，
 * 这样「关掉 runtime → 用同一份库重开」与浏览器刷新语义一致。
 */
let conversationStorage = new MemoryStorage()
const indexedDbStorageClass = IndexedDbStorage as unknown as {
  open: (name: string, options?: unknown) => Promise<Storage>
}
indexedDbStorageClass.open = async () => {
  const target = conversationStorage
  return new Proxy(target, {
    get(store, property) {
      if (property === 'close') return async () => {}
      const value = Reflect.get(store, property, store)
      return typeof value === 'function' ? value.bind(store) : value
    },
  }) as unknown as Storage
}

function newMemoryStorage(): MemoryStorage {
  conversationStorage = new MemoryStorage()
  return conversationStorage
}

/* ───────────────────────── 假宿主：文件表 + 世界 ───────────────────────── */

type FakeHost = {
  host: AgentHost
  files: Map<string, string>
}

function makeHost(): FakeHost {
  const files = new Map<string, string>()
  const host = {
    listSources: () => ({ ok: true, sources: [...files.keys()] }),
    readSource: (source: string) =>
      files.has(source)
        ? { ok: true, content: files.get(source), version: '' }
        : { ok: false, error: `cannot read ${source}` },
    readFullSource: (source: string) =>
      files.has(source)
        ? { ok: true, content: files.get(source) }
        : { ok: false, error: `cannot read ${source}` },
    readAssetText: async (path: string) => files.get(path) ?? null,
    isHumanDirty: () => false,
    createSource: (source: string, content: string) => {
      if (files.has(source)) return { ok: false, error: 'already exists' }
      files.set(source, content)
      return { ok: true }
    },
    writeSource: (source: string, content: string) => {
      files.set(source, content)
      return { ok: true }
    },
    discardDraftSource: (source: string) => {
      files.delete(source)
    },
    editSource: () => ({ ok: true }),
    validateSource: () => ({ ok: true }),
    getActiveFilePath: () => ({ ok: true }),
    listLocales: () => ({ ok: true, locales: [] }),
    listLangKeys: async () => ({ ok: true }),
    writeLang: async () => ({ ok: true }),
    deleteLangKeys: async () => ({ ok: true }),
  } as unknown as AgentHost
  return { host, files }
}

function makeWorld(files: Map<string, string>): AgentFileWorld {
  return {
    read: async (path) => {
      const content = files.get(path)
      return content === undefined ? null : { content, version: await contentVersion(content) }
    },
    isHumanDirty: () => false,
    write: async (path, content) => {
      if (content === null) files.delete(path)
      else files.set(path, content)
    },
  }
}

function makeRuntime(scope: string, windowId: string, host: AgentHost): AgentRuntime {
  return createAgentRuntime({
    scope,
    windowId,
    host,
    apiKey: '',
    model: 'deepseek-flash',
  })
}

/** 用例隔离：清 localStorage、清假库、换一份空对话存储 */
function resetEnv(): void {
  fakeStorage.clear()
  fakeIdb.reset()
  newMemoryStorage()
}

/** 用真实 RunUndoLog 造一条与生产同构的撤销日志（写前 before → 写出 after） */
async function journalEntriesFor(
  files: Map<string, string>,
  path: string,
  before: string,
  after: string,
  runKey: string,
) {
  files.set(path, before)
  const log = new RunUndoLog(makeWorld(files))
  await log.recordBefore(runKey, path, 'source')
  log.recordWrite(runKey, path, 'source', {
    content: after,
    version: await contentVersion(after),
  })
  files.set(path, after)
  return log.entriesOf(runKey)
}

async function saveJournal(record: UndoJournalRecord): Promise<void> {
  const backend = new IndexedDbUndoJournalBackend({ scope: record.scope })
  await backend.save(record)
}

async function loadJournal(record: {
  scope: string
  windowId: string
  segmentId: string
}): Promise<UndoJournalRecord | null> {
  const backend = new IndexedDbUndoJournalBackend({ scope: record.scope })
  return backend.load(undoJournalKey(record.scope, record.windowId, record.segmentId))
}

/* ───────────────────────── 1. renameSegment ───────────────────────── */

await test('renameSegment：裁剪首尾空白并写回段元数据，返回值字段正确', async () => {
  resetEnv()
  const { host } = makeHost()
  const runtime = makeRuntime('rename-scope', 'window-a', host)
  try {
    await runtime.open()
    const segmentId = runtime.view().segmentId
    assert.ok(segmentId, 'open 后应有活跃段')
    const before = await runtime.listSegments()
    const previous = before.find((item) => item.id === segmentId)
    assert.ok(previous, '活跃段应出现在段列表里')

    const renamed = await runtime.renameSegment(segmentId, '  雨夜序章  ')
    assert.equal(renamed.id, segmentId)
    assert.equal(renamed.title, '雨夜序章', '标题必须裁剪首尾空白')
    assert.equal(renamed.windowId, 'window-a')
    assert.equal(renamed.state, 'active', '重命名活跃段后状态仍是 active')
    assert.ok(
      renamed.updatedAt >= renamed.createdAt,
      `updatedAt（${renamed.updatedAt}）不得早于 createdAt（${renamed.createdAt}）`,
    )
    assert.ok(renamed.updatedAt > 0 && renamed.createdAt > 0, '时间戳应是真实毫秒值')

    // 持久化：段元数据是 UI 元数据，存 localStorage；刷新后 listSegments 仍应读回标题
    const key = `hanshu.agent.segment.window-a.rename-scope`
    const raw = fakeStorage.getItem(key)
    assert.ok(raw, '段元数据必须写入 localStorage')
    assert.equal(
      (JSON.parse(raw ?? '{}') as Record<string, { title?: string }>)[segmentId]?.title,
      '雨夜序章',
    )

    // 模拟刷新：同一份对话存储 + 同一份 localStorage 上重开
    await runtime.close()
    const reopened = makeRuntime('rename-scope', 'window-a', host)
    try {
      await reopened.open()
      const listed = await reopened.listSegments()
      assert.equal(
        listed.find((item) => item.id === segmentId)?.title,
        '雨夜序章',
        '重开后段标题必须还在',
      )
    } finally {
      await reopened.close()
    }
  } finally {
    await runtime.close()
  }
})

await test('renameSegment：空标题 / 纯空白 / 超过 80 字拒绝，80 字边界通过', async () => {
  resetEnv()
  const { host } = makeHost()
  const runtime = makeRuntime('rename-guard-scope', 'window-b', host)
  try {
    await runtime.open()
    const segmentId = runtime.view().segmentId
    assert.ok(segmentId)

    await assert.rejects(runtime.renameSegment(segmentId, ''), /段标题不能为空/, '空标题必须拒绝')
    await assert.rejects(
      runtime.renameSegment(segmentId, '   \t  '),
      /段标题不能为空/,
      '纯空白标题必须拒绝',
    )
    await assert.rejects(
      runtime.renameSegment(segmentId, '汉'.repeat(81)),
      /段标题过长/,
      '超过 80 字必须拒绝',
    )
    const boundary = await runtime.renameSegment(segmentId, '汉'.repeat(80))
    assert.equal(boundary.title.length, 80, '80 字恰好是允许的上界')

    // 拒绝的调用不能污染已存在的标题
    await assert.rejects(runtime.renameSegment(segmentId, ''))
    const listed = await runtime.listSegments()
    assert.equal(listed.find((item) => item.id === segmentId)?.title, '汉'.repeat(80))
  } finally {
    await runtime.close()
  }
})

/* ───────────────────────── 2. 停止（stopped）待处理回滚 ───────────────────────── */

await test('停止：打开段时不自动回滚，只挂 reason=stopped 的待处理回滚', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'stopped-scope'
  const windowId = 'window-stopped'
  files.set('序章.hs', '写前正文')

  const runtime = makeRuntime(scope, windowId, host)
  let segmentId: string | null = null
  try {
    await runtime.open()
    segmentId = runtime.view().segmentId
    assert.ok(segmentId)
  } finally {
    await runtime.close()
  }

  const runKey = 'run-stopped-1'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  assert.equal(files.get('序章.hs'), '写后正文', '日志造好后文件处于「本 Run 写出」状态')
  await saveJournal({
    scope,
    windowId,
    segmentId,
    runKey,
    reason: 'stopped',
    createdAt: 1_760_000_000_000,
    entries,
  })

  const reopened = makeRuntime(scope, windowId, host)
  try {
    await reopened.open()
    const pending = reopened.view().pendingRollback
    assert.ok(pending, '停止留下的日志必须恢复成待处理回滚卡片')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.reason, 'stopped')
    assert.deepEqual(pending.conflicts, [], '停止的回滚不预演冲突')
    assert.equal(files.get('序章.hs'), '写后正文', '停止的改动必须保留，不得自动回滚')
    assert.ok(
      await loadJournal({ scope, windowId, segmentId: segmentId! }),
      '用户还没选择之前，日志必须留在库里的',
    )
  } finally {
    await reopened.close()
  }
})

await test('停止：强制回滚后才写回写前内容，日志清空、卡片转 failed', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'stopped-force-scope'
  const windowId = 'window-stopped-force'
  files.set('序章.hs', '写前正文')

  const first = makeRuntime(scope, windowId, host)
  let segmentId: string | null = null
  try {
    await first.open()
    segmentId = first.view().segmentId
  } finally {
    await first.close()
  }
  assert.ok(segmentId)

  const runKey = 'run-stopped-2'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  await saveJournal({
    scope,
    windowId,
    segmentId,
    runKey,
    reason: 'stopped',
    createdAt: 1_760_000_000_000,
    entries,
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    assert.equal(runtime.view().pendingRollback?.reason, 'stopped')
    const outcomes = await runtime.forceRollback()
    assert.ok(outcomes.length > 0, '强制回滚应有逐条结论')
    assert.equal(outcomes[0].path, '序章.hs')
    assert.equal(outcomes[0].action, 'restored')
    assert.equal(files.get('序章.hs'), '写前正文', '强制回滚必须写回写前内容')
    assert.equal(runtime.view().pendingRollback?.status, 'failed')
    assert.equal(
      await loadJournal({ scope, windowId, segmentId }),
      null,
      '回滚完成后日志必须清空',
    )
  } finally {
    await runtime.close()
  }
})

await test('失败对照：reason=failure 且预演安全时打开段即自动回滚并清日志', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'failure-scope'
  const windowId = 'window-failure'
  files.set('序章.hs', '写前正文')

  const first = makeRuntime(scope, windowId, host)
  let segmentId: string | null = null
  try {
    await first.open()
    segmentId = first.view().segmentId
  } finally {
    await first.close()
  }
  assert.ok(segmentId)

  const runKey = 'run-failure-1'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  await saveJournal({
    scope,
    windowId,
    segmentId,
    runKey,
    reason: 'failure',
    createdAt: 1_760_000_000_000,
    entries,
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    assert.equal(runtime.view().pendingRollback, null, '失败且安全时不应留下卡片')
    assert.equal(files.get('序章.hs'), '写前正文', '失败 Run 的改动应自动回滚')
    assert.equal(
      await loadJournal({ scope, windowId, segmentId }),
      null,
      '自动回滚后日志必须清空',
    )
  } finally {
    await runtime.close()
  }
})

await test('停止：保留（放弃回滚）后改动留在草稿里，卡片与日志都清掉', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'stopped-abandon-scope'
  const windowId = 'window-stopped-abandon'
  files.set('序章.hs', '写前正文')

  const first = makeRuntime(scope, windowId, host)
  let segmentId: string | null = null
  try {
    await first.open()
    segmentId = first.view().segmentId
  } finally {
    await first.close()
  }
  assert.ok(segmentId)

  const runKey = 'run-stopped-abandon'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  await saveJournal({
    scope,
    windowId,
    segmentId,
    runKey,
    reason: 'stopped',
    createdAt: 1_760_000_000_000,
    entries,
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    assert.equal(runtime.view().pendingRollback?.reason, 'stopped')
    await runtime.abandonRollback()
    assert.equal(files.get('序章.hs'), '写后正文', '选择保留时不能动文件')
    assert.equal(runtime.view().pendingRollback, null, '选择保留后卡片应消失')
    assert.equal(
      await loadJournal({ scope, windowId, segmentId }),
      null,
      '选择保留后日志应清空（下次打开不再提示）',
    )
  } finally {
    await runtime.close()
  }
})

await test('abort：空闲时调用是安全空操作（不进入运行态、不挂卡片）', async () => {
  resetEnv()
  const { host } = makeHost()
  const runtime = makeRuntime('abort-idle-scope', 'window-abort-idle', host)
  try {
    await runtime.open()
    assert.equal(runtime.view().runState, 'idle')
    await runtime.abort()
    assert.equal(runtime.view().runState, 'idle', '空闲时 abort 不应把状态改成 aborted')
    assert.equal(runtime.view().pendingRollback, null, '空闲时 abort 不应挂待处理回滚')
  } finally {
    await runtime.close()
  }
})

/* ───────────────────────── 汇总 ───────────────────────── */

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
