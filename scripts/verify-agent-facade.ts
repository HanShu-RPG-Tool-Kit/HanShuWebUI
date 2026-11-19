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
 * 5. 历史 Run 主动回滚（阶段 17）：无记录时空结果、归档段拒绝、成功 Run 的 user 条目挂
 *    runKey/rollbackable，`rollbackRun` 后置 rolledBack 并清掉再次回滚的入口
 * 6. 回滚通知（任务 35）：成功后写 hanshu.rollback 条目；data 的 runs/outcomes/forced 正确；
 *    model 序列按尾部角色保持 user/assistant 严格交替（尾部 user 时前置空 assistant 占位）
 * 7. `forkSegment`（任务 37）：默认全量继承（标题加「（继承）」、旧段转 dormant、条目 id 重新分配）、
 *    `beforeEntryId` 截断复制与 `label: 'branch'`、封存段仍可 fork、删除源段后新段仍自包含、
 *    分支里的 hanshu.rollback 仍映射成回滚卡片；以及用 Run 统计行的 `forkBeforeEntryId`
 *    直接分支到当前 Run 末尾（任务 39 的端到端配合）
 *
 * 跑法：`node scripts/run-verification.mjs scripts/verify-agent-facade.ts`
 */
import assert from 'node:assert/strict'
import { MemoryStorage, createSession, type EntryRecord, type Storage } from '@earendil-works/pi-durable'
import { IndexedDbStorage } from '@earendil-works/pi-durable/storage/indexeddb'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createAgentRuntime } from '../src/plugins/agent/core/pi/facade'
import { RunUndoLog } from '../src/plugins/agent/core/runtime/runUndo'
import { contentVersion } from '../src/plugins/agent/core/runtime/version'
import {
  IndexedDbUndoJournalBackend,
  undoJournalKey,
  type UndoJournalRecord,
} from '../src/plugins/agent/core/store/undoJournal'
import {
  IndexedDbRunRollbackBackend,
  runRollbackKey,
  type RunRollbackSegmentRecord,
} from '../src/plugins/agent/core/store/runRollbackStore'
import type { AgentFileWorld, AgentHost, AgentRuntime } from '../src/plugins/agent/core/contracts'

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

type FakeStore = {
  keyPath: string | string[] | null
  data: Map<string, unknown>
  indexes: Map<string, { keyPath: string }>
}

/**
 * 假 IndexedDB：只实现本脚本用到的 API（open/升级建库/事务/objectStore 的 get·put·add·delete/
 * 索引 getAll/事务 complete 事件）。索引只为归档段库的 `scope` 列表服务（forkSegment 会查一次
 * 源段的归档快照）；游标仍不实现 —— 真要用到时它会明确报错，而不是悄悄返回错误结果。
 */
function makeFakeIndexedDb() {
  const databases = new Map<string, Map<string, FakeStore>>()

  function keyOf(storeName: string, store: FakeStore, value: unknown, key: unknown): string {
    if (key !== undefined && key !== null) return String(key)
    const keyPath = store.keyPath
    if (typeof keyPath === 'string' && value !== null && typeof value === 'object') {
      return String((value as Record<string, unknown>)[keyPath])
    }
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
        store.data.set(keyOf(name, store, value, key), value)
        const request: FakeRequest = {}
        queueMicrotask(() => request.onsuccess?.())
        return request
      },
      add: (value: unknown, key?: unknown) => {
        const target = keyOf(name, store, value, key)
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
      index: (indexName: string) => {
        const index = store.indexes.get(indexName)
        if (index === undefined) throw new Error(`假 IndexedDB 没有索引：${indexName}`)
        return {
          getAll: (query?: unknown) => {
            const request: FakeRequest = {}
            queueMicrotask(() => {
              request.result = [...store.data.values()].filter((value) => {
                if (query === undefined) return true
                const record = value as Record<string, unknown> | null
                return record !== null && record !== undefined && record[index.keyPath] === query
              })
              request.onsuccess?.()
            })
            return request
          },
        }
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
          const store: FakeStore = {
            keyPath: options?.keyPath ?? null,
            data: new Map(),
            indexes: new Map(),
          }
          stores!.set(storeName, store)
          return {
            name: storeName,
            createIndex: (indexName: string, keyPath: string) => {
              store.indexes.set(indexName, { keyPath })
              return { name: indexName }
            },
          }
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
/** 记录原始全局，脚本结束时还原；否则同进程后面的套件会读到假 localStorage（例如 config 的默认值用例） */
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
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

/** 每个会话各拿一个包装对象，但底层是同一份内存库（= 同一个 IndexedDB 库） */
function conversationStorageHandle(): Storage {
  const target = conversationStorage
  return new Proxy(target, {
    get(store, property) {
      if (property === 'close') return async () => {}
      const value = Reflect.get(store, property, store)
      return typeof value === 'function' ? value.bind(store) : value
    },
  }) as unknown as Storage
}

const indexedDbStorageClass = IndexedDbStorage as unknown as {
  open: (name: string, options?: unknown) => Promise<Storage>
}
indexedDbStorageClass.open = async () => conversationStorageHandle()

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

/**
 * 往段会话里追加一条 user 条目，返回条目 id。
 *
 * 为什么需要它：`recordRollbackRun` 的调用点在成功 Run 的收尾里，而真跑一轮 Run 要连
 * deepseek provider（联网），验收脚本不能依赖网络。这里直接按生产同构的存储格式补一条
 * user 条目，再配合 `IndexedDbRunRollbackBackend` 播种回滚记录，就能验「回滚图标挂到哪、
 * 回滚后置灰」这些纯数据逻辑。
 *
 * 注意：必须等 runtime 关闭后再开会话 —— 一份存储同一时刻只能有一个 Session 写。
 */
async function seedEntry(conversationId: number, draft: Record<string, unknown>): Promise<string> {
  const session = createSession(conversationStorageHandle())
  try {
    const entry = await session.commit(
      (tx) => tx.appendEntry(conversationId as never, draft as never),
      BACKGROUND_CONTEXT,
    )
    return String((entry as { id: unknown }).id)
  } finally {
    await session.close(BACKGROUND_CONTEXT)
  }
}

/**
 * 读原始对话条目（含 kind/data/model）。
 *
 * 回滚通知的 model 序列只有从真实会话存储读回来才算验到，而一份存储同一时刻只能有一个
 * Session 写 —— 所以调用前必须先把 runtime 关掉。
 */
async function readConversationEntries(conversationId: number): Promise<EntryRecord[]> {
  const session = createSession(conversationStorageHandle())
  try {
    const page = await session.commit(
      (tx) =>
        tx.scanEntries({ conversationId: conversationId as never, order: 'ascending' }, 1000),
      BACKGROUND_CONTEXT,
    )
    return [...page.items]
  } finally {
    await session.close(BACKGROUND_CONTEXT)
  }
}

async function seedUserEntry(conversationId: number, text: string): Promise<string> {
  return seedEntry(conversationId, {
    kind: 'pi.user',
    model: [{ role: 'user', content: text }],
  })
}

async function saveRunRollback(record: RunRollbackSegmentRecord): Promise<void> {
  const backend = new IndexedDbRunRollbackBackend({ scope: record.scope })
  await backend.save(record)
}

async function loadRunRollback(record: {
  scope: string
  windowId: string
  segmentId: string
}): Promise<RunRollbackSegmentRecord | null> {
  const backend = new IndexedDbRunRollbackBackend({ scope: record.scope })
  return backend.load(runRollbackKey(record.scope, record.windowId, record.segmentId))
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

/* ───────────────────────── 3. 历史 Run 主动回滚（阶段 17） ───────────────────────── */

await test('历史 Run 回滚：没有记录时 rollbackRun / rollbackFromRun / rollbackAll 都是空结果', async () => {
  resetEnv()
  const { host } = makeHost()
  const runtime = makeRuntime('no-record-scope', 'window-no-record', host)
  try {
    await runtime.open()
    const calls: Array<[string, () => Promise<{ ok: boolean; rolledBackRuns: string[]; outcomes: unknown[]; conflicts: unknown[] }>]> = [
      ['rollbackRun', () => runtime.rollbackRun('missing-run')],
      ['rollbackFromRun', () => runtime.rollbackFromRun('missing-run')],
      ['rollbackAll', () => runtime.rollbackAll()],
    ]
    for (const [label, call] of calls) {
      const result = await call()
      assert.equal(result.ok, true, `${label}：没有可回滚记录时应成功返回空结果`)
      assert.deepEqual(result.rolledBackRuns, [], `${label}：不应声称回滚了任何一轮`)
      assert.deepEqual(result.outcomes, [])
      assert.deepEqual(result.conflicts, [])
    }
  } finally {
    await runtime.close()
  }
})

await test('历史 Run 回滚：归档段（sealed）拒绝回滚，user 条目标注为不可回滚', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'sealed-rollback-scope'
  const windowId = 'window-sealed-rollback'
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

  const runKey = 'run-sealed-1'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  const userEntryId = await seedUserEntry(Number(segmentId), '请改写序章')
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [{ runKey, userEntryId, createdAt: 1_760_000_000_000, entries }],
  })
  // 模拟 archive() 封段：段元数据 sealed=true（归档段不可再回滚，D4）
  fakeStorage.setItem(
    `hanshu.agent.segment.${windowId}.${scope}`,
    JSON.stringify({
      [segmentId]: {
        createdAt: 1_760_000_000_000,
        updatedAt: 1_760_000_000_000,
        title: '已归档',
        runCount: 1,
        sealed: true,
      },
    }),
  )

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    assert.equal(runtime.view().segmentSealed, true, '段元数据 sealed 应被读成 segmentSealed')
    const item = runtime.view().items.find((entry) => entry.kind === 'user')
    assert.ok(item && item.kind === 'user', 'user 条目应出现在视图里')
    assert.equal(item.runKey, runKey, '归档段的 Run 记录仍要能定位到消息')
    assert.equal(item.rollbackable, false, '归档段的改动不可回滚')
    assert.equal(item.rolledBack, undefined)

    const result = await runtime.rollbackRun(runKey)
    assert.equal(result.ok, false)
    assert.equal(result.error, '归档段不可回滚')
    assert.deepEqual(result.rolledBackRuns, [])
    assert.equal(files.get('序章.hs'), '写后正文', '被拒绝时不能动文件')
  } finally {
    await runtime.close()
  }
})

await test('历史 Run 回滚：成功 Run 的改动可回滚，回滚后 user 条目置 rolledBack 并持久化', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'run-rollback-scope'
  const windowId = 'window-run-rollback'
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

  // 生产里这条记录由成功 Run 的收尾写入；这里用真实 RunUndoLog + 真实后端播种同样的数据
  const runKey = 'run-success-1'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  const userEntryId = await seedUserEntry(Number(segmentId), '请改写序章')
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [{ runKey, userEntryId, createdAt: 1_760_000_000_000, entries }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    const before = runtime.view().items.find((entry) => entry.kind === 'user')
    assert.ok(before && before.kind === 'user')
    assert.equal(before.id, userEntryId, '回滚图标要挂在触发这一轮的 user 条目上')
    assert.equal(before.runKey, runKey)
    assert.equal(before.rollbackable, true)
    assert.equal(before.rolledBack, undefined)

    const result = await runtime.rollbackRun(runKey)
    assert.equal(result.ok, true, `回滚应成功：${result.error ?? ''}`)
    assert.deepEqual(result.rolledBackRuns, [runKey])
    assert.equal(files.get('序章.hs'), '写前正文', '回滚必须写回写前内容')
    assert.equal(result.outcomes[0]?.action, 'restored')

    const after = runtime.view().items.find((entry) => entry.kind === 'user')
    assert.ok(after && after.kind === 'user')
    assert.equal(after.rollbackable, false, '已回滚的按钮要置灰')
    assert.equal(after.rolledBack, true)

    const stored = await loadRunRollback({ scope, windowId, segmentId })
    assert.equal(stored?.runs[0]?.rolledBack, true, 'rolledBack 必须落库，刷新后按钮仍置灰')

    // 回滚成功后要往对话里写一条通知：UI 挂回滚卡片、模型下一轮也知道哪些文件被撤回了
    const notice = runtime.view().items.find((entry) => entry.kind === 'rollback')
    assert.ok(notice && notice.kind === 'rollback', '回滚成功后应出现回滚通知条目')
    assert.ok(notice.id.length > 0, '通知条目要有稳定 id')
    assert.ok(notice.createdAt > 0, '通知必须带真实时间戳')
    assert.deepEqual(
      notice.runs.map((run) => run.userIndex),
      [0],
      '通知要指回被回滚的 user 轮次',
    )
    assert.ok(
      notice.outcomes.some((outcome) => outcome.action === 'restored'),
      '通知要带上逐文件回退结论',
    )
    assert.equal(notice.forced, undefined, '用户点普通回滚不该被标成强制')
    assert.equal(notice.auto, undefined, '用户主动回滚不是自动回滚')

    // 再点一次：记录里已标记 rolledBack，不能让用户重复回滚（会覆盖回滚后的内容）
    const again = await runtime.rollbackRun(runKey)
    assert.equal(again.ok, true)
    assert.deepEqual(again.rolledBackRuns, [], '已回滚的 Run 不能再回滚一次')
    assert.equal(
      runtime.view().items.filter((entry) => entry.kind === 'rollback').length,
      1,
      '重复点击不能追加第二条通知',
    )
  } finally {
    await runtime.close()
  }

  // 通知的 model 序列只存在会话条目里：关掉 runtime 后按真实存储读回来验
  const rawEntries = await readConversationEntries(Number(segmentId))
  const notices = rawEntries.filter((entry) => entry.kind === 'hanshu.rollback')
  assert.equal(notices.length, 1, '一次回滚只写一条 hanshu.rollback 条目')
  const noticeData = notices[0].data as {
    createdAt?: number
    runs?: Array<{ userIndex?: number; files?: string[] }>
    outcomes?: Array<{ path?: string; action?: string }>
    forced?: boolean
    auto?: boolean
  }
  assert.ok((noticeData.createdAt ?? 0) > 0, 'data.createdAt 要写真实时间戳（UI 排序用）')
  assert.equal(noticeData.runs?.[0]?.userIndex, 0)
  assert.deepEqual(noticeData.runs?.[0]?.files, ['序章.hs'])
  assert.ok(noticeData.outcomes?.some((outcome) => outcome.action === 'restored'))
  assert.equal(noticeData.forced, undefined)
  assert.equal(noticeData.auto, undefined)

  // 播种的 user 是尾部条目 → 生产序列为 [assistant(空), user(通知), assistant(空)]：
  // 尾部 user 后面必须跟 assistant，才能维持模型上下文里 user/assistant 严格交替
  const model = notices[0].model as Array<{ role: string; content: unknown }>
  assert.deepEqual(model.map((message) => message.role), ['assistant', 'user', 'assistant'])
  assert.deepEqual(model[0].content, [], '占位 assistant 不能有正文')
  assert.equal(typeof model[1].content, 'string')
  assert.ok(String(model[1].content).length > 0, '通知文本不能为空')
  assert.deepEqual(model[2].content, [], '尾部占位 assistant 不能有正文')
})

await test('历史 Run 回滚：只允许回滚后缀轮，更早的轮次要用「这一轮及之后」', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'suffix-rollback-scope'
  const windowId = 'window-suffix-rollback'
  const path = '序章.hs'

  const first = makeRuntime(scope, windowId, host)
  let segmentId: string | null = null
  try {
    await first.open()
    segmentId = first.view().segmentId
  } finally {
    await first.close()
  }
  assert.ok(segmentId)

  // 两轮先后改同一个文件：v0 → v1（旧轮）→ v2（新轮）
  const oldRunKey = 'run-suffix-old'
  const newRunKey = 'run-suffix-new'
  const oldEntries = await journalEntriesFor(files, path, 'v0', 'v1', oldRunKey)
  const newEntries = await journalEntriesFor(files, path, 'v1', 'v2', newRunKey)
  const oldUserEntryId = await seedUserEntry(Number(segmentId), '第一轮：改写序章')
  const newUserEntryId = await seedUserEntry(Number(segmentId), '第二轮：再改写序章')
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [
      { runKey: oldRunKey, userEntryId: oldUserEntryId, createdAt: 1000, entries: oldEntries },
      { runKey: newRunKey, userEntryId: newUserEntryId, createdAt: 2000, entries: newEntries },
    ],
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    // 两轮的入口都还在：后缀守卫在调用时判断，不在标注阶段隐藏
    const users = runtime.view().items.filter((entry) => entry.kind === 'user')
    assert.deepEqual(
      users.map((entry) => (entry.kind === 'user' ? entry.runKey : undefined)),
      [oldRunKey, newRunKey],
    )
    for (const user of users) {
      if (user.kind === 'user') assert.equal(user.rollbackable, true)
    }

    // 只回滚旧轮会丢掉新轮的写前状态（v1），因此必须拒绝，且一条文件都不能动
    const blocked = await runtime.rollbackRun(oldRunKey)
    assert.equal(blocked.ok, false, '更早的轮次不能单独回滚')
    assert.match(
      blocked.error ?? '',
      /只能回滚最后一轮/,
      '错误文案要告诉模型为什么被拒（不能静默失败）',
    )
    assert.match(blocked.error ?? '', /这一轮及之后/, '错误文案要指向可行的替代操作')
    assert.deepEqual(blocked.rolledBackRuns, [])
    assert.equal(files.get(path), 'v2', '守卫必须在写盘之前拒绝，文件内容不能动')
    assert.equal(
      runtime.view().items.filter((entry) => entry.kind === 'rollback').length,
      0,
      '失败的回滚不能留下回滚通知',
    )

    // 最新一轮可以单独回滚：v2 → v1
    const newest = await runtime.rollbackRun(newRunKey)
    assert.equal(newest.ok, true, `最新一轮应可回滚：${newest.error ?? ''}`)
    assert.deepEqual(newest.rolledBackRuns, [newRunKey])
    assert.equal(files.get(path), 'v1', '回滚最新一轮写回它的写前内容')
    const stored = await loadRunRollback({ scope, windowId, segmentId })
    assert.equal(
      stored?.runs.find((run) => run.runKey === newRunKey)?.rolledBack,
      true,
      '最新一轮置 rolledBack 并落库',
    )
    assert.equal(
      stored?.runs.find((run) => run.runKey === oldRunKey)?.rolledBack,
      undefined,
      '旧轮此时还没被回滚',
    )

    // 「回滚这一轮及之后」不受后缀守卫限制：旧轮 + 已回滚的新轮一起回退到 v0
    const fromOld = await runtime.rollbackFromRun(oldRunKey)
    assert.equal(fromOld.ok, true, `回滚这一轮及之后应成功：${fromOld.error ?? ''}`)
    assert.deepEqual(fromOld.rolledBackRuns, [oldRunKey], '已回滚的最新一轮不重复计入')
    assert.equal(files.get(path), 'v0', '后缀回滚最终落回最早一轮的写前内容')
  } finally {
    await runtime.close()
  }
})

await test('保存归档：archive() 同时归档所有未封存的活跃段，二次调用返回 null', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'archive-all-scope'
  const windowId = 'window-archive-all'
  const metaKey = `hanshu.agent.segment.${windowId}.${scope}`
  const metaOf = () =>
    JSON.parse(fakeStorage.getItem(metaKey) ?? '{}') as Record<string, { sealed?: boolean }>

  // 第一段：首次 open 自动创建，写入两条对话条目（user + assistant）
  const first = makeRuntime(scope, windowId, host)
  let firstId = ''
  try {
    await first.open()
    firstId = String(first.view().segmentId)
  } finally {
    await first.close()
  }
  assert.ok(firstId)
  await seedEntry(Number(firstId), {
    kind: 'pi.user',
    model: [{ role: 'user', content: '第一段：开场' }],
  })
  await seedEntry(Number(firstId), {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '第一段：答复' }] }],
  })

  // 第二段：createSegment 切换当前段 → 第一段变 dormant，但此时还没有 sealed
  const switching = makeRuntime(scope, windowId, host)
  let secondId = ''
  try {
    await switching.open()
    secondId = (await switching.createSegment('第二段')).id
  } finally {
    await switching.close()
  }
  assert.ok(secondId)
  assert.notEqual(secondId, firstId)
  await seedEntry(Number(secondId), {
    kind: 'pi.user',
    model: [{ role: 'user', content: '第二段：开场' }],
  })

  // 第一段还挂着一份待处理回滚 journal（失败/停止后遗留在库里）。
  // 必须在切段之后播种：切段前播种的话，下个 runtime open() 挂到该段时会把没有
  // reason 的 journal 当失败自动回滚并清空，archive 就取不到可并入的日志了。
  const firstJournal = await journalEntriesFor(
    files,
    '序章.hs',
    '旧正文',
    '新正文',
    'run-archive-first',
  )
  await saveJournal({
    scope,
    windowId,
    segmentId: firstId,
    runKey: 'run-archive-first',
    createdAt: 1,
    entries: firstJournal,
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    assert.equal(runtime.view().segmentId, secondId, '重开应回到上次的当前段')

    const info = await runtime.archive()
    assert.ok(info, '当前段有新增条目，archive 必须返回当前段快照')
    assert.equal(info.segmentId, secondId, '返回值是当前段的快照')
    assert.equal(info.entryCount, 1, '当前段只归档自己的新增条目')

    // 保存 = 归档所有活跃段：非当前段也要有快照
    const snapshots = await runtime.listSnapshots()
    const firstSnaps = snapshots.filter((snapshot) => snapshot.segmentId === firstId)
    const secondSnaps = snapshots.filter((snapshot) => snapshot.segmentId === secondId)
    assert.equal(firstSnaps.length, 1, '非当前活跃段也必须归档')
    assert.equal(secondSnaps.length, 1, '当前段只归档一次')
    assert.equal(firstSnaps[0].entryCount, 2, '另一段快照的条目数 = 它的全部条目')
    assert.equal(firstSnaps[0].filesChanged, 1, '其它段的待处理 journal 并入简化日志')
    assert.equal(firstSnaps[0].rollbackLog?.length, 1)
    assert.equal(firstSnaps[0].rollbackLog?.[0]?.path, '序章.hs')
    // 快照条目能读回，且 UI 映射与生产一致（user/assistant + 末尾统计行）
    const snapshotItems = await runtime.snapshotItems(firstSnaps[0].id)
    assert.equal(snapshotItems.filter((item) => item.kind === 'user').length, 1)
    assert.equal(snapshotItems.filter((item) => item.kind === 'assistant').length, 1)
    // 该段 journal 归档后清空（不能再在刷新后变成待处理回滚）
    assert.equal(
      await loadJournal({ scope, windowId, segmentId: firstId }),
      null,
      '归档后该段的待处理 journal 必须清空',
    )

    // 两段都要 sealed（否则下次发送又会往已保存的段里写）
    const meta = metaOf()
    assert.equal(meta[firstId]?.sealed, true, '非当前段也要封段')
    assert.equal(meta[secondId]?.sealed, true, '当前段封段')

    const before = (await runtime.listSnapshots()).length
    const again = await runtime.archive()
    assert.equal(again, null, '所有段已 sealed 且没有新增条目 → 返回 null')
    assert.equal(
      (await runtime.listSnapshots()).length,
      before,
      '二次 archive 不能新增快照（连当前段也不能重复归档）',
    )
  } finally {
    await runtime.close()
  }
})

await test('历史 Run 回滚：冲突时普通回滚失败、force 强制回滚仍写回写前内容并置 rolledBack', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'force-rollback-scope'
  const windowId = 'window-force-rollback'
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

  const runKey = 'run-force-1'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  const userEntryId = await seedUserEntry(Number(segmentId), '请改写序章')
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [{ runKey, userEntryId, createdAt: 1_760_000_000_000, entries }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    // 打开后再改文件：制造 version_stale（世界在回滚调用时读的是宿主当前内容）
    files.set('序章.hs', '外部改写')

    const guarded = await runtime.rollbackRun(runKey)
    assert.equal(guarded.ok, false, '版本对不上时普通回滚必须失败')
    assert.equal(guarded.error, '部分文件已被修改，未执行回滚')
    assert.equal(guarded.conflicts[0]?.reason, 'version_stale')
    assert.deepEqual(guarded.rolledBackRuns, [])
    assert.equal(files.get('序章.hs'), '外部改写', '普通回滚失败时不能动文件')

    const item = runtime.view().items.find((entry) => entry.kind === 'user')
    assert.ok(item && item.kind === 'user')
    assert.equal(item.rollbackable, true, '强制回滚入口仍要可用')

    const forced = await runtime.rollbackRun(runKey, { force: true })
    assert.equal(forced.ok, true, `强制回滚应成功：${forced.error ?? ''}`)
    assert.deepEqual(forced.rolledBackRuns, [runKey])
    assert.equal(files.get('序章.hs'), '写前正文', '强制回滚要按写前快照覆盖外部改动')
    assert.equal(forced.outcomes[0]?.action, 'restored')

    const after = runtime.view().items.find((entry) => entry.kind === 'user')
    assert.ok(after && after.kind === 'user')
    assert.equal(after.rolledBack, true)
    assert.equal(after.rollbackable, false)

    const stored = await loadRunRollback({ scope, windowId, segmentId })
    assert.equal(stored?.runs[0]?.rolledBack, true, '强制回滚也要把 rolledBack 落库')

    const notice = runtime.view().items.find((entry) => entry.kind === 'rollback')
    assert.ok(notice && notice.kind === 'rollback', '强制回滚同样要写通知')
    assert.equal(notice.forced, true, '强制回滚的通知要带 forced 标记（卡片文案与模型提示不同）')
    assert.equal(notice.auto, undefined, '强制回滚不是自动回滚')
  } finally {
    await runtime.close()
  }
})

await test('历史 Run 回滚：rollbackFromRun / rollbackAll 的 force 冒烟（无记录时空结果）', async () => {
  resetEnv()
  const { host } = makeHost()
  const runtime = makeRuntime('force-empty-scope', 'window-force-empty', host)
  try {
    await runtime.open()
    const from = await runtime.rollbackFromRun('missing-run', { force: true })
    assert.equal(from.ok, true)
    assert.deepEqual(from.rolledBackRuns, [])
    const all = await runtime.rollbackAll({ force: true })
    assert.equal(all.ok, true)
    assert.deepEqual(all.rolledBackRuns, [])
    assert.deepEqual(all.outcomes, [])
    assert.deepEqual(all.conflicts, [])
  } finally {
    await runtime.close()
  }
})

await test('回滚通知：尾部是 assistant 时序列为 [user, assistant]（保持严格交替）', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'notice-tail-assistant-scope'
  const windowId = 'window-notice-tail-assistant'
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
  const conversationId = Number(segmentId)

  const runKey = 'run-notice-assistant'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  const userEntryId = await seedUserEntry(conversationId, '请改写序章')
  // 尾部是 assistant：通知直接以 user 开头即可，不需要前置占位
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '改好了。' }] }],
  })
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [{ runKey, userEntryId, createdAt: 1_760_000_000_000, entries }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    const result = await runtime.rollbackRun(runKey)
    assert.equal(result.ok, true, `回滚应成功：${result.error ?? ''}`)
  } finally {
    await runtime.close()
  }

  const rawEntries = await readConversationEntries(conversationId)
  const notice = rawEntries.find((entry) => entry.kind === 'hanshu.rollback')
  assert.ok(notice, '应写入回滚通知')
  const model = notice.model as Array<{ role: string; content: unknown }>
  assert.deepEqual(model.map((message) => message.role), ['user', 'assistant'])
  assert.deepEqual(model[1].content, [], '尾部占位 assistant 不能有正文')
  const data = notice.data as { runs?: Array<{ userIndex?: number }> }
  assert.equal(data.runs?.[0]?.userIndex, 0, '通知仍要指回第 0 轮 user')
})

await test('回滚通知：尾部是 toolResult 时序列为 [user, assistant]（不额外插占位）', async () => {
  resetEnv()
  const { host, files } = makeHost()
  const scope = 'notice-tail-tool-scope'
  const windowId = 'window-notice-tail-tool'
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
  const conversationId = Number(segmentId)

  const runKey = 'run-notice-tool'
  const entries = await journalEntriesFor(files, '序章.hs', '写前正文', '写后正文', runKey)
  const userEntryId = await seedUserEntry(conversationId, '看看序章再改')
  // 造一轮「assistant 发起工具调用 + toolResult 结果」：尾部角色是 toolResult，不是 user
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'read_source', arguments: { path: '序章.hs' } },
        ],
      },
    ],
  })
  await seedEntry(conversationId, {
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read_source',
        content: [{ type: 'text', text: '写前正文' }],
      },
    ],
  })
  await saveRunRollback({
    scope,
    windowId,
    segmentId,
    runs: [{ runKey, userEntryId, createdAt: 1_760_000_000_000, entries }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    const result = await runtime.rollbackRun(runKey)
    assert.equal(result.ok, true, `回滚应成功：${result.error ?? ''}`)
  } finally {
    await runtime.close()
  }

  const rawEntries = await readConversationEntries(conversationId)
  const notice = rawEntries.find((entry) => entry.kind === 'hanshu.rollback')
  assert.ok(notice, '应写入回滚通知')
  const model = notice.model as Array<{ role: string; content: unknown }>
  assert.deepEqual(
    model.map((message) => message.role),
    ['user', 'assistant'],
    'toolResult 之后可以接 user，序列不需要前置占位',
  )
  assert.deepEqual(model[1].content, [], '尾部占位 assistant 不能有正文')
  const data = notice.data as { runs?: Array<{ userIndex?: number }> }
  assert.equal(data.runs?.[0]?.userIndex, 0, '通知要指回第 0 轮 user')
})

/* ───────────────────────── 7. forkSegment：分支/继承 ───────────────────────── */

/**
 * 模拟「删除源段成功后」的存储状态。
 *
 * 生产里 `facade.deleteSegment` 走 `segmentPurge` 直接删 IndexedDB 里的会话/条目记录；本脚本的对话
 * 后端是 MemoryStorage（见文件头的两处注入），没有可删的 IndexedDB 表，所以在等价位置（内存库的
 * 私有 state）摘掉源会话。效果与真实删除一致：之后任何读取都看不到源段。
 */
type MemoryBackendState = {
  conversations: Map<number, unknown>
  conversationIds: number[]
  entries: Map<number, { conversationId: number }>
  entryIds: Map<number, number[]>
  headEntryIds: Map<number, number[]>
  entryCommitSeqs: Map<number, unknown>
  recordTypes: Map<number, string>
}

function purgeConversation(conversationId: number): void {
  const state = (conversationStorage as unknown as { state: MemoryBackendState }).state
  const sameId = (left: number, right: number) => String(left) === String(right)
  state.conversations.delete(conversationId)
  state.conversationIds = state.conversationIds.filter((id) => !sameId(id, conversationId))
  for (const entryId of state.entryIds.get(conversationId) ?? []) {
    state.entries.delete(entryId)
    state.entryCommitSeqs.delete(entryId)
    state.recordTypes.delete(entryId)
  }
  state.entryIds.delete(conversationId)
  state.headEntryIds.delete(conversationId)
  state.recordTypes.delete(conversationId)
}

/** 造一个「内容齐全」的源段：4 种对话 kind + 一条回滚通知，用来验分支复制是否完整 */
async function seedForkSource(conversationId: number): Promise<void> {
  await seedUserEntry(conversationId, '雨夜序章：先写第一幕')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '好，我先读一下序章再动手。' }] }],
  })
  await seedEntry(conversationId, {
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-fork',
        toolName: 'read_source',
        content: [{ type: 'text', text: '序章正文' }],
      },
    ],
  })
  await seedEntry(conversationId, { kind: 'pi.system', data: { text: '系统提示：保持文风' } })
  await seedEntry(conversationId, {
    kind: 'hanshu.rollback',
    model: [
      { role: 'user', content: '已撤回第 1 轮 Run 的改动' },
      { role: 'assistant', content: [] },
    ],
    data: {
      createdAt: 1_760_000_000_000,
      runs: [{ userIndex: 0, files: ['序章.hs'] }],
      outcomes: [{ path: '序章.hs', action: 'restored' }],
    },
  })
}

await test('forkSegment：无参默认继承全量条目，标题加「（继承）」且旧段转 dormant', async () => {
  resetEnv()
  const scope = 'fork-scope'
  const windowId = 'window-fork-a'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId, 'open 后应有活跃段')
  const conversationId = Number(segmentId)
  await seedForkSource(conversationId)
  const sourceEntries = await readConversationEntries(conversationId)
  assert.equal(sourceEntries.length, 5, '源段应有 5 条条目')

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    const before = await runtime.listSegments()
    const source = before.find((item) => item.id === segmentId)
    assert.ok(source, '源段应在段列表里')
    assert.equal(source.state, 'active')

    const info = await runtime.forkSegment()
    forkedId = info.id
    assert.notEqual(info.id, segmentId, '分支必须是新段')
    assert.equal(info.title, `${source.title}（继承）`, '默认继承的标题要加后缀')
    assert.equal(info.state, 'active', '新段立刻是活跃段')
    assert.equal(info.runCount, 0, '分支不继承 Run 计数')
    assert.equal(info.windowId, windowId)

    const after = await runtime.listSegments()
    assert.equal(
      after.find((item) => item.id === segmentId)?.state,
      'dormant',
      '旧段必须还在（dormant），不能删段',
    )
    assert.equal(after.find((item) => item.id === info.id)?.state, 'active')
  } finally {
    await runtime.close()
  }

  const copied = await readConversationEntries(Number(forkedId))
  assert.equal(copied.length, 5, '分支必须复制全部条目')
  assert.deepEqual(
    copied.map((entry) => entry.kind),
    sourceEntries.map((entry) => entry.kind),
    '分支按原顺序保留条目 kind',
  )
  for (const [index, entry] of copied.entries()) {
    assert.deepEqual(entry.model, sourceEntries[index].model, `第 ${index} 条 model 必须原样保留`)
    assert.deepEqual(entry.data, sourceEntries[index].data, `第 ${index} 条 data 必须原样保留`)
  }
  const copiedIds = copied.map((entry) => String(entry.id))
  assert.equal(new Set(copiedIds).size, copiedIds.length, '分支条目 id 必须互不相同')
  for (const id of copiedIds) {
    assert.ok(
      !sourceEntries.some((entry) => String(entry.id) === id),
      '分支条目要重新分配 id（自包含，不共享源段条目）',
    )
  }

  // 重开时自动回到最新分支段：分支里的回滚通知仍要映射成卡片，并标回对应的 user 行
  const reopened = makeRuntime(scope, windowId, host)
  try {
    await reopened.open()
    assert.equal(reopened.view().segmentId, forkedId, '重开应自动 attach 到最新分支段')
    const rollback = reopened.view().items.find((item) => item.kind === 'rollback')
    assert.ok(rollback, '分支里的 hanshu.rollback 必须仍渲染成回滚卡片')
    const userItem = reopened.view().items.find((item) => item.kind === 'user')
    assert.equal(userItem?.rolledBackRun, true, '被回滚 Run 的 user 行要标 rolledBackRun')
  } finally {
    await reopened.close()
  }
})

await test('forkSegment：beforeEntryId 只复制该条之前的历史，标题加「（分支）」', async () => {
  resetEnv()
  const scope = 'fork-before-scope'
  const windowId = 'window-fork-b'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  await seedUserEntry(conversationId, '第一轮开场')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '第一轮回复' }] }],
  })
  const secondUserId = await seedUserEntry(conversationId, '第二轮追问')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '第二轮回复' }] }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    const source = (await runtime.listSegments()).find((item) => item.id === segmentId)
    assert.ok(source)
    const info = await runtime.forkSegment({ beforeEntryId: secondUserId })
    forkedId = info.id
    assert.equal(info.title, `${source.title}（分支）`, '带 beforeEntryId 时默认 label 是 branch')
  } finally {
    await runtime.close()
  }

  const copied = await readConversationEntries(Number(forkedId))
  assert.deepEqual(
    copied.map((entry) => entry.kind),
    ['pi.user', 'pi.assistant'],
    '只复制锚点之前的条目（第 2 轮 user 及其后都不进分支）',
  )
  const firstText = (copied[0].model as Array<{ content?: unknown }>)[0]?.content
  assert.equal(firstText, '第一轮开场')
})

await test('forkSegment：用统计行的 forkBeforeEntryId 分支，复制到当前 Run 为止', async () => {
  resetEnv()
  const scope = 'fork-runmeta-scope'
  const windowId = 'window-fork-runmeta'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  const base = 1_760_000_000_000
  await seedEntry(conversationId, {
    kind: 'pi.user',
    model: [{ role: 'user', content: '第一轮问题', timestamp: base }],
  })
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '第一轮答复' }],
        timestamp: base + 500,
        usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 0, totalTokens: 230 },
      },
    ],
  })
  const secondUserId = await seedUserEntry(conversationId, '第二轮追问')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '第二轮答复' }],
        timestamp: base + 900,
        usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
      },
    ],
  })

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    const metas = runtime.view().items.filter((item) => item.kind === 'run-meta') as Array<{
      kind: 'run-meta'
      durationMs: number
      turns: number
      forkBeforeEntryId?: string
    }>
    assert.equal(metas.length, 2, '两条 Run 各一条统计行')
    assert.equal(metas[0].turns, 1)
    assert.equal(metas[0].durationMs, 500, '统计行读到真实消息时间戳')
    assert.equal(metas[0].forkBeforeEntryId, secondUserId, '分支点 = 下一条用户条目 id')
    assert.equal(metas[1].forkBeforeEntryId, undefined, '最后一条 Run 复制全部')

    const info = await runtime.forkSegment({ beforeEntryId: metas[0].forkBeforeEntryId })
    forkedId = info.id
    assert.ok(info.title.endsWith('（分支）'), '按统计行分支默认 label=branch')
  } finally {
    await runtime.close()
  }

  const copied = await readConversationEntries(Number(forkedId))
  assert.deepEqual(
    copied.map((entry) => entry.kind),
    ['pi.user', 'pi.assistant'],
    '统计行的分支点正好落在当前 Run 末尾：只复制第一轮的 user + assistant',
  )
  assert.equal(copied.length, 2, '不含下一条用户条目及其答复')
})

await test('forkSegment：label 显式给 branch 时仍是全量复制，只换标题后缀', async () => {
  resetEnv()
  const scope = 'fork-label-scope'
  const windowId = 'window-fork-c'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  await seedUserEntry(conversationId, '只有一轮')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '只有一条回复' }] }],
  })

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    const source = (await runtime.listSegments()).find((item) => item.id === segmentId)
    assert.ok(source)
    const info = await runtime.forkSegment({ label: 'branch' })
    forkedId = info.id
    assert.equal(info.title, `${source.title}（分支）`)
  } finally {
    await runtime.close()
  }
  const copied = await readConversationEntries(Number(forkedId))
  assert.equal(copied.length, 2, '不传 beforeEntryId 时即使 label 是 branch 也全量复制')
})

await test('forkSegment：分支自包含——删掉源段后新段仍能完整读出', async () => {
  resetEnv()
  const scope = 'fork-self-scope'
  const windowId = 'window-fork-d'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  await seedForkSource(conversationId)

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    forkedId = (await runtime.forkSegment()).id
  } finally {
    await runtime.close()
  }

  // 源段被删：生产是 purge IndexedDB，这里在等价位置摘掉内存库里的源会话
  purgeConversation(conversationId)

  const reopened = makeRuntime(scope, windowId, host)
  try {
    await reopened.open()
    assert.equal(reopened.view().segmentId, forkedId, '源段删除后仍要能打开分支段')
    const listed = await reopened.listSegments()
    assert.equal(
      listed.some((item) => item.id === segmentId),
      false,
      '源段删除后必须从段列表消失',
    )
    assert.equal(listed.some((item) => item.id === forkedId), true, '分支段必须还在')
    // pi.system 只给模型看、不进 UI 条目，所以 4 个可视化条目（user/assistant/tool/rollback）
    // 再加最后一条 Run 的统计行 run-meta；回滚通知会先把当前 Run 收尾，所以统计行在通知之前
    assert.deepEqual(
      reopened.view().items.map((item) => item.kind),
      ['user', 'assistant', 'tool', 'run-meta', 'rollback'],
      '分支段的 UI 条目不能依赖源段，必须仍完整',
    )
    const userItem = reopened.view().items.find((item) => item.kind === 'user')
    assert.equal(userItem?.kind, 'user')
  } finally {
    await reopened.close()
  }
  const copied = await readConversationEntries(Number(forkedId))
  assert.equal(copied.length, 5, '分支条目在源段删除后仍逐条可读')
})

await test('forkSegment：封存段仍可 fork，新段是 active 而源段保持 sealed', async () => {
  resetEnv()
  const scope = 'fork-sealed-scope'
  const windowId = 'window-fork-e'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  await seedUserEntry(conversationId, '封存前的最后一轮')
  await seedEntry(conversationId, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '封存前的回复' }] }],
  })

  // 模拟 archive() 成功：段元数据 sealed=true（真实 archive 还要写快照库，假 IDB 不覆盖那部分）
  const metaKey = `hanshu.agent.segment.${windowId}.${scope}`
  const rawMeta = fakeStorage.getItem(metaKey)
  assert.ok(rawMeta, '段元数据应已写入 localStorage')
  const meta = JSON.parse(rawMeta as string) as Record<string, { sealed?: boolean }>
  meta[segmentId] = { ...meta[segmentId], sealed: true }
  fakeStorage.setItem(metaKey, JSON.stringify(meta))

  const runtime = makeRuntime(scope, windowId, host)
  let forkedId = ''
  try {
    await runtime.open()
    const source = (await runtime.listSegments()).find((item) => item.id === segmentId)
    assert.equal(source?.state, 'sealed', '源段应是封存态')
    const info = await runtime.forkSegment()
    forkedId = info.id
    assert.equal(info.state, 'active', '封存段 fork 出来的新段必须可继续使用')
    const after = await runtime.listSegments()
    assert.equal(after.find((item) => item.id === segmentId)?.state, 'sealed', '源段不能被 fork 改回未封存')
  } finally {
    await runtime.close()
  }
  const copied = await readConversationEntries(Number(forkedId))
  assert.equal(copied.length, 2)
})

await test('forkSegment：beforeEntryId 不存在时拒绝，且不建段、不改当前段', async () => {
  resetEnv()
  const scope = 'fork-bad-scope'
  const windowId = 'window-fork-f'
  const { host } = makeHost()
  const first = makeRuntime(scope, windowId, host)
  let segmentId = ''
  try {
    await first.open()
    segmentId = first.view().segmentId ?? ''
  } finally {
    await first.close()
  }
  assert.ok(segmentId)
  const conversationId = Number(segmentId)
  await seedUserEntry(conversationId, '唯一一条')

  const runtime = makeRuntime(scope, windowId, host)
  try {
    await runtime.open()
    const before = await runtime.listSegments()
    await assert.rejects(
      runtime.forkSegment({ beforeEntryId: '999999' }),
      /找不到要分支的消息/,
      '坏 beforeEntryId 必须拒绝',
    )
    const after = await runtime.listSegments()
    assert.equal(after.length, before.length, '拒绝时不能留下半截新段')
    assert.equal(runtime.view().segmentId, segmentId, '拒绝时当前段不能变')
    // 一条 user 条目 + 它的 Run 统计行（最后一条 Run 也会收尾出统计行）
    assert.deepEqual(
      runtime.view().items.map((item) => item.kind),
      ['user', 'run-meta'],
      '拒绝时当前段的条目不受影响',
    )
  } finally {
    await runtime.close()
  }
  assert.equal((await readConversationEntries(conversationId)).length, 1, '源段条目不受影响')
})

/* ───────────────────────── 汇总 ───────────────────────── */

// 还原全局桩：多套件同进程运行时，后面的脚本仍应看到 Node 原生（无）localStorage
if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
else delete (globalThis as { localStorage?: unknown }).localStorage
if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb)
else delete (globalThis as { indexedDB?: unknown }).indexedDB

console.log(`\n通过 ${checks} 项，失败 ${failures.length} 项。`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exitCode = 1
}
