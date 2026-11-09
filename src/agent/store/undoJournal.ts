/**
 * 活跃段撤销日志的持久化（修正草案 D3/D4）。
 *
 * 为什么需要它：失败 Run 的「待处理回滚」以前只在内存，刷新即丢；D4 要求活跃段把
 * `{path, beforeHash, beforeContent, afterHash, afterContent}` 日志落 IndexedDB，
 * 刷新后失败卡片上的回滚入口仍然可用。封段（保存）后该段日志随之作废 —— 归档段不可回滚。
 *
 * 边界：
 * - 日志里是**正文**（写前内容），所以有体积保护：序列化后超过 4 MB 直接抛错，
 *   调用方（facade）捕获后降级为「本次不持久化」，不阻断 Run 收尾。
 * - 只存纯数据（`UndoEntry`），不存 Map/Set；`RunUndoLog.entriesOf()` 就是序列化入口。
 * - IndexedDB 代码写得薄，Node 下用 `MemoryUndoJournalBackend` 验收，import 不碰浏览器 API。
 */
import type { UndoEntry } from '../contracts'
import { undoJournalDbName } from './dbNames'

/** 一条活跃段的待处理回滚：key 由 scope + windowId + segmentId 共同决定 */
export type UndoJournalRecord = {
  scope: string
  windowId: string
  segmentId: string
  /** 产生这条日志的 Run（`pi.live.run.taskId` 的本地映射） */
  runKey: string
  createdAt: number
  entries: UndoEntry[]
}

export type UndoJournalBackend = {
  load: (key: string) => Promise<UndoJournalRecord | null>
  save: (record: UndoJournalRecord) => Promise<void>
  clear: (key: string) => Promise<void>
}

/** 体积上限：活跃段日志含正文，大文件 × 多语言会很大（D3 风险 5），超过就不持久化 */
export const UNDO_JOURNAL_LIMIT_BYTES = 4 * 1024 * 1024

const DB_VERSION = 1
const JOURNAL_STORE = 'journals'

/**
 * 稳定的日志 key：三段各自 URL 编码后用 `::` 连接。
 * 不用 `_` 清洗（那是库名的做法）：key 要避免 `a:b` 与 `a_b` 撞成同一个。
 */
export function undoJournalKey(scope: string, windowId: string, segmentId: string): string {
  return `${encodePart(scope)}::${encodePart(windowId)}::${encodePart(segmentId)}`
}

/**
 * 序列化 + 体积保护。超过 `UNDO_JOURNAL_LIMIT_BYTES` 抛错（调用方降级为不持久化）；
 * 抛错发生在写库之前，不会留下半截日志。
 */
export function serializeUndoJournal(record: UndoJournalRecord): string {
  const text = JSON.stringify(record)
  const bytes = new TextEncoder().encode(text).length
  if (bytes > UNDO_JOURNAL_LIMIT_BYTES) {
    throw new Error(
      `撤销日志过大（${bytes} 字节 > ${UNDO_JOURNAL_LIMIT_BYTES} 字节），本次不持久化`,
    )
  }
  return text
}

/**
 * 反序列化；损坏 / 结构不符时返回 null（刷新后读到坏数据应当当没有日志，而不是炸面板）。
 * 条目本身再过滤一遍，回放逻辑不依赖持久化数据可信。
 */
export function deserializeUndoJournal(text: string): UndoJournalRecord | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return null
    const record = value as Partial<UndoJournalRecord>
    if (typeof record.scope !== 'string' || record.scope.length === 0) return null
    if (typeof record.windowId !== 'string' || record.windowId.length === 0) return null
    if (typeof record.segmentId !== 'string' || record.segmentId.length === 0) return null
    if (typeof record.runKey !== 'string' || record.runKey.length === 0) return null
    if (typeof record.createdAt !== 'number') return null
    if (!Array.isArray(record.entries)) return null
    return {
      scope: record.scope,
      windowId: record.windowId,
      segmentId: record.segmentId,
      runKey: record.runKey,
      createdAt: record.createdAt,
      entries: record.entries.filter(isUndoEntry).map(cloneEntry),
    }
  } catch {
    return null
  }
}

/* ───────────────────────── 测试用内存后端 ───────────────────────── */

/**
 * 内存后端：存的是**序列化后的字符串**而不是对象引用 ——
 * 既保证 roundtrip 与 IndexedDB 完全同构（同一条体积保护/反序列化路径），
 * 也让 load 返回副本，外部改不到内部状态。
 */
export class MemoryUndoJournalBackend implements UndoJournalBackend {
  private readonly records = new Map<string, string>()

  async load(key: string): Promise<UndoJournalRecord | null> {
    const text = this.records.get(key)
    return text === undefined ? null : deserializeUndoJournal(text)
  }

  async save(record: UndoJournalRecord): Promise<void> {
    this.records.set(recordKey(record), serializeUndoJournal(record))
  }

  async clear(key: string): Promise<void> {
    this.records.delete(key)
  }
}

/* ───────────────────────── IndexedDB 后端 ───────────────────────── */

/**
 * 浏览器后端：一个实例服务一个工程 scope（库名 `hanshu.agent.undo.<scope>`），
 * 库内用 `undoJournalKey` 区分窗口与段。`indexedDB` 工厂可注入，便于测试。
 * 不注入时**构造不抛**，只有真正读写才需要 IDB（Node 下 import 安全）。
 */
export class IndexedDbUndoJournalBackend implements UndoJournalBackend {
  private readonly scope: string
  private readonly dbName: string
  private readonly factory: IDBFactory | undefined
  private opening: Promise<IDBDatabase> | null = null

  constructor(options?: { scope?: string; indexedDB?: IDBFactory }) {
    this.scope = options?.scope?.trim() || 'unknown'
    this.dbName = undoJournalDbName(this.scope)
    this.factory = options?.indexedDB
  }

  async load(key: string): Promise<UndoJournalRecord | null> {
    const db = await this.open()
    const stored = await new Promise<string | undefined>((resolve, reject) => {
      const transaction = db.transaction(JOURNAL_STORE, 'readonly')
      const request = transaction.objectStore(JOURNAL_STORE).get(key)
      request.onsuccess = () => resolve(request.result as string | undefined)
      request.onerror = () => reject(request.error ?? new Error('读取撤销日志失败'))
    })
    return stored === undefined ? null : deserializeUndoJournal(stored)
  }

  async save(record: UndoJournalRecord): Promise<void> {
    if (record.scope !== this.scope) {
      throw new Error(`撤销日志 scope 不一致：记录是 ${record.scope}，本库是 ${this.scope}`)
    }
    // 先做体积保护（写库之前），过大直接抛错让调用方降级
    const text = serializeUndoJournal(record)
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(JOURNAL_STORE, 'readwrite')
      transaction.objectStore(JOURNAL_STORE).put(text, recordKey(record))
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('写入撤销日志失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('写入撤销日志失败'))
    })
  }

  async clear(key: string): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(JOURNAL_STORE, 'readwrite')
      transaction.objectStore(JOURNAL_STORE).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('清除撤销日志失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('清除撤销日志失败'))
    })
  }

  private open(): Promise<IDBDatabase> {
    if (this.opening === null) {
      this.opening = openDb(this.factory ?? defaultIndexedDb(), this.dbName)
    }
    return this.opening
  }
}

/* ───────────────────────── 细节 ───────────────────────── */

function recordKey(record: UndoJournalRecord): string {
  return undoJournalKey(record.scope, record.windowId, record.segmentId)
}

function encodePart(part: string): string {
  return encodeURIComponent(part.trim() === '' ? 'unknown' : part.trim())
}

function cloneEntry(entry: UndoEntry): UndoEntry {
  return {
    kind: entry.kind,
    channel: entry.channel,
    path: entry.path,
    before: { content: entry.before.content, version: entry.before.version },
    after: entry.after,
  }
}

function isUndoEntry(value: unknown): value is UndoEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<UndoEntry>
  if (typeof entry.path !== 'string' || entry.path.length === 0) return false
  if (entry.channel !== 'source' && entry.channel !== 'lang') return false
  if (entry.kind !== 'write' && entry.kind !== 'create') return false
  if (typeof entry.after !== 'string') return false
  const before = entry.before
  if (before === null || before === undefined || typeof before !== 'object') return false
  const image = before as { content?: unknown; version?: unknown }
  if (typeof image.content !== 'string' && image.content !== null) return false
  if (typeof image.version !== 'string' && image.version !== null) return false
  return true
}

function defaultIndexedDb(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new Error('当前环境没有 indexedDB：Node 下请使用 MemoryUndoJournalBackend')
  }
  return indexedDB
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        // 日志 key 用外部键（scope::window::segment），值是可 JSON 序列化的字符串
        db.createObjectStore(JOURNAL_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(`打开撤销日志库失败：${name}`))
  })
}
