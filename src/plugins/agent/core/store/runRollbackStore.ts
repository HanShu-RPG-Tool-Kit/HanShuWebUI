/**
 * 活跃段「历史 Run 回滚记录」的持久化（人机交互优化：消息左侧回滚图标 / 输入框旁回滚按钮）。
 *
 * 与 `undoJournal` 的区别：
 * - `undoJournal` 只存**当前待处理回滚**（失败/停止的那一轮），同一段最多一条；
 * - 这里按段存**每一轮曾产生改动的 Run** 的撤销日志，供用户事后主动回滚。
 *
 * 边界：
 * - 只存活跃段；保存（`archive()` 封段）时清空 —— 归档段不可回滚；
 * - 继承来的归档条目没有记录 → 面板不显示回滚图标；
 * - 体积保护：单段记录序列化后超过 8 MB 时从最旧的 Run 开始丢弃，仍超限则抛错，
 *   调用方降级为「这一轮不持久化」（内存里仍可回滚，刷新后失效）。
 */
import type { UndoEntry } from '../contracts'
import { runRollbackDbName } from './dbNames'
import { undoJournalKey } from './undoJournal'

/** 一轮 Run 的撤销记录（用户消息左侧回滚图标对应它） */
export type RunRollbackRecord = {
  runKey: string
  /** 触发这一轮的 user 条目 id（视图用来把按钮挂到对应消息） */
  userEntryId: string
  createdAt: number
  entries: UndoEntry[]
  /** 已经回滚过：按钮保留但置灰，避免重复回滚 */
  rolledBack?: boolean
}

/** 一个活跃段的全部历史 Run 记录（key = scope + windowId + segmentId） */
export type RunRollbackSegmentRecord = {
  scope: string
  windowId: string
  segmentId: string
  runs: RunRollbackRecord[]
}

export type RunRollbackBackend = {
  load: (key: string) => Promise<RunRollbackSegmentRecord | null>
  save: (record: RunRollbackSegmentRecord) => Promise<void>
  clear: (key: string) => Promise<void>
}

/** 单段体积上限；超过就从最旧的 Run 开始丢 */
export const RUN_ROLLBACK_LIMIT_BYTES = 8 * 1024 * 1024
/** 单段最多保留多少轮（防止长会话无限增长） */
export const RUN_ROLLBACK_MAX_RUNS = 80

const DB_VERSION = 1
const ROLLBACK_STORE = 'runs'

/** 稳定 key：与待处理回滚共用 `scope::windowId::segmentId` 编码 */
export function runRollbackKey(scope: string, windowId: string, segmentId: string): string {
  return undoJournalKey(scope, windowId, segmentId)
}

/**
 * 序列化 + 体积/条数保护：先按条数裁，再按体积从旧到新裁。
 * 若只剩最新一轮仍超限，抛错（调用方不持久化这一轮）。
 */
export function serializeRunRollback(record: RunRollbackSegmentRecord): string {
  const runs = [...record.runs]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-RUN_ROLLBACK_MAX_RUNS)
  let text = JSON.stringify({ ...record, runs })
  while (new TextEncoder().encode(text).length > RUN_ROLLBACK_LIMIT_BYTES) {
    if (runs.length <= 1) {
      throw new Error(
        `回滚记录过大（${new TextEncoder().encode(text).length} 字节 > ${RUN_ROLLBACK_LIMIT_BYTES} 字节），本轮不持久化`,
      )
    }
    runs.shift()
    text = JSON.stringify({ ...record, runs })
  }
  return text
}

/** 反序列化；损坏/结构不符返回 null，单条记录也逐项过滤 */
export function deserializeRunRollback(text: string): RunRollbackSegmentRecord | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object') return null
    const record = value as Partial<RunRollbackSegmentRecord>
    if (typeof record.scope !== 'string' || record.scope.length === 0) return null
    if (typeof record.windowId !== 'string' || record.windowId.length === 0) return null
    if (typeof record.segmentId !== 'string' || record.segmentId.length === 0) return null
    if (!Array.isArray(record.runs)) return null
    const runs: RunRollbackRecord[] = []
    for (const item of record.runs) {
      if (item === null || typeof item !== 'object') continue
      const run = item as Partial<RunRollbackRecord>
      if (typeof run.runKey !== 'string' || run.runKey.length === 0) continue
      if (typeof run.userEntryId !== 'string' || run.userEntryId.length === 0) continue
      if (typeof run.createdAt !== 'number') continue
      if (!Array.isArray(run.entries)) continue
      runs.push({
        runKey: run.runKey,
        userEntryId: run.userEntryId,
        createdAt: run.createdAt,
        entries: run.entries.filter(isUndoEntry).map(cloneEntry),
        ...(run.rolledBack === true ? { rolledBack: true } : {}),
      })
    }
    return {
      scope: record.scope,
      windowId: record.windowId,
      segmentId: record.segmentId,
      runs,
    }
  } catch {
    return null
  }
}

/* ───────────────────────── 测试用内存后端 ───────────────────────── */

/** 内存后端：存序列化字符串，与 IndexedDB 后端走同一条体积/反序列化路径 */
export class MemoryRunRollbackBackend implements RunRollbackBackend {
  private readonly records = new Map<string, string>()

  async load(key: string): Promise<RunRollbackSegmentRecord | null> {
    const text = this.records.get(key)
    return text === undefined ? null : deserializeRunRollback(text)
  }

  async save(record: RunRollbackSegmentRecord): Promise<void> {
    this.records.set(recordKey(record), serializeRunRollback(record))
  }

  async clear(key: string): Promise<void> {
    this.records.delete(key)
  }
}

/* ───────────────────────── IndexedDB 后端 ───────────────────────── */

export class IndexedDbRunRollbackBackend implements RunRollbackBackend {
  private readonly scope: string
  private readonly dbName: string
  private readonly factory: IDBFactory | undefined
  private opening: Promise<IDBDatabase> | null = null

  constructor(options?: { scope?: string; indexedDB?: IDBFactory }) {
    this.scope = options?.scope?.trim() || 'unknown'
    this.dbName = runRollbackDbName(this.scope)
    this.factory = options?.indexedDB
  }

  async load(key: string): Promise<RunRollbackSegmentRecord | null> {
    const db = await this.open()
    const stored = await new Promise<string | undefined>((resolve, reject) => {
      const transaction = db.transaction(ROLLBACK_STORE, 'readonly')
      const request = transaction.objectStore(ROLLBACK_STORE).get(key)
      request.onsuccess = () => resolve(request.result as string | undefined)
      request.onerror = () => reject(request.error ?? new Error('读取回滚记录失败'))
    })
    return stored === undefined ? null : deserializeRunRollback(stored)
  }

  async save(record: RunRollbackSegmentRecord): Promise<void> {
    if (record.scope !== this.scope) {
      throw new Error(`回滚记录 scope 不一致：记录是 ${record.scope}，本库是 ${this.scope}`)
    }
    const text = serializeRunRollback(record)
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ROLLBACK_STORE, 'readwrite')
      transaction.objectStore(ROLLBACK_STORE).put(text, recordKey(record))
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('写入回滚记录失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('写入回滚记录失败'))
    })
  }

  async clear(key: string): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ROLLBACK_STORE, 'readwrite')
      transaction.objectStore(ROLLBACK_STORE).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('清除回滚记录失败'))
      transaction.onerror = () => reject(transaction.error ?? new Error('清除回滚记录失败'))
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

function recordKey(record: RunRollbackSegmentRecord): string {
  return runRollbackKey(record.scope, record.windowId, record.segmentId)
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
    throw new Error('当前环境没有 indexedDB：Node 下请使用 MemoryRunRollbackBackend')
  }
  return indexedDB
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ROLLBACK_STORE)) {
        db.createObjectStore(ROLLBACK_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(`打开回滚记录库失败：${name}`))
  })
}
