/**
 * 归档段库（文档 §9「会话段与归档段」「存储落地」「占用估算与保留策略」）。
 *
 * 归档段是**不可变**的：一条记录写进去之后不再改，删除只能整条删，且**必须保留仍被引用的父归档段**，
 * 否则跨库谱系断裂（§9「删除能力分两层」）。因此 `append` 对同 id 直接抛错，`remove` 先查引用。
 *
 * 库名按工程 scope 分区（`hanshu.agent.archive.<scope>`），同 scope 的所有窗口可读（§11 第 3 条）。
 * IndexedDB 只在这里出现，且写得尽量薄：主体逻辑与后端无关，Node 下用 MemorySnapshotBackend 测。
 */
import type { SnapshotBackend, SnapshotInfo } from '../contracts'
import { archiveDbName } from './dbNames'

const SNAPSHOT_STORE = 'snapshots'
const ENTRY_STORE = 'entries'
const DB_VERSION = 1

export class SnapshotStore {
  private readonly backend: SnapshotBackend
  /** 工程 scope（分区键）；记录里的 scope 必须与它一致，否则会写进别的分区 */
  readonly scope: string

  constructor(backend: SnapshotBackend, options?: { scope: string }) {
    this.backend = backend
    this.scope = options?.scope?.trim() || 'unknown'
  }

  /** 追加一条归档段；同 id 已存在直接抛错（不可变，不覆盖） */
  async append(record: SnapshotInfo, entries: unknown[]): Promise<void> {
    if (!record.id) throw new Error('归档段 id 不能为空')
    if (record.scope && record.scope !== this.scope) {
      throw new Error(`归档段 scope 不一致：记录是 ${record.scope}，本库是 ${this.scope}`)
    }
    const existing = await this.backend.list(this.scope)
    if (existing.some(snapshot => snapshot.id === record.id)) {
      throw new Error(`归档段已存在且不可修改：${record.id}`)
    }
    // 空 scope 视为「用本库的 scope」；后端按 scope 分区，写错分区的归档段会从列表里消失
    await this.backend.put({ ...record, scope: record.scope || this.scope }, entries.slice())
  }

  /** 按 createdAt 升序（归档段列表从旧到新读） */
  async list(): Promise<SnapshotInfo[]> {
    const snapshots = await this.backend.list(this.scope)
    return snapshots
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(record => ({ ...record }))
  }

  async readEntries(snapshotId: string): Promise<unknown[]> {
    return await this.backend.entries(snapshotId)
  }

  /**
   * 删除一条归档段。仍被其它归档段的 parentSnapshotId 引用时拒绝（`referenced`），
   * 保证谱系不出现「父节点被删、子节点指空」的断裂（§9）。
   */
  async remove(snapshotId: string): Promise<{ removed: boolean; reason?: string }> {
    const snapshots = await this.backend.list(this.scope)
    if (!snapshots.some(snapshot => snapshot.id === snapshotId)) {
      return { removed: false, reason: 'not_found' }
    }
    if (snapshots.some(snapshot => snapshot.parentSnapshotId === snapshotId)) {
      return { removed: false, reason: 'referenced' }
    }
    await this.backend.remove(snapshotId)
    return { removed: true }
  }

  /** 本工程 scope 的占用（字节），供 UI 做 50MB 黄条 / 100MB 红条 */
  async usage(): Promise<number> {
    return await this.backend.usage(this.scope)
  }
}

/* ───────────────────────── 测试用内存后端 ───────────────────────── */

/** 完整实现 `SnapshotBackend`；Node 验收脚本用它，浏览器外的单元测试同样可用 */
export class MemorySnapshotBackend implements SnapshotBackend {
  private readonly records = new Map<string, SnapshotInfo>()
  private readonly entriesById = new Map<string, unknown[]>()

  async put(record: SnapshotInfo, entries: unknown[]): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`归档段已存在且不可修改：${record.id}`)
    this.records.set(record.id, { ...record })
    this.entriesById.set(record.id, entries.slice())
  }

  async list(scope: string): Promise<SnapshotInfo[]> {
    return [...this.records.values()]
      .filter(record => record.scope === scope)
      .map(record => ({ ...record }))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  async entries(snapshotId: string): Promise<unknown[]> {
    const items = this.entriesById.get(snapshotId)
    if (items === undefined) throw new Error(`归档段不存在：${snapshotId}`)
    return items.slice()
  }

  async remove(snapshotId: string): Promise<void> {
    this.records.delete(snapshotId)
    this.entriesById.delete(snapshotId)
  }

  async usage(scope: string): Promise<number> {
    let total = 0
    for (const record of this.records.values()) {
      if (record.scope !== scope) continue
      total += jsonBytes(record) + jsonBytes(this.entriesById.get(record.id) ?? [])
    }
    return total
  }
}

/* ───────────────────────── IndexedDB 后端 ───────────────────────── */

/**
 * 浏览器后端。一个实例只服务一个工程 scope（库名在构造时定死），
 * 因此 `SnapshotStore` 与它应当成对创建。`indexedDB` 工厂可注入，便于测试与多源隔离。
 */
export class IndexedDbSnapshotBackend implements SnapshotBackend {
  private readonly factory: IDBFactory
  private readonly dbName: string
  private opening: Promise<IDBDatabase> | null = null

  constructor(options?: { scope?: string; indexedDB?: IDBFactory }) {
    this.factory = options?.indexedDB ?? defaultIndexedDb()
    this.dbName = archiveDbName(options?.scope?.trim() || 'unknown')
  }

  async put(record: SnapshotInfo, entries: unknown[]): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([SNAPSHOT_STORE, ENTRY_STORE], 'readwrite')
      // 用 add 而不是 put：主键重复时由 IndexedDB 自己拒绝，「不可变」不依赖先读后写
      transaction.objectStore(SNAPSHOT_STORE).add({ ...record })
      transaction.objectStore(ENTRY_STORE).add({ snapshotId: record.id, items: entries.slice() })
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(writeError(record.id, transaction.error))
      transaction.onerror = () => reject(writeError(record.id, transaction.error))
    })
  }

  async list(scope: string): Promise<SnapshotInfo[]> {
    const db = await this.open()
    const records = await new Promise<SnapshotInfo[]>((resolve, reject) => {
      const transaction = db.transaction(SNAPSHOT_STORE, 'readonly')
      // 库本身按 scope 分区，再用 scope 索引过滤一次，防止同库被别的 scope 误用
      const request = transaction.objectStore(SNAPSHOT_STORE).index('scope').getAll(scope)
      request.onsuccess = () => resolve((request.result as SnapshotInfo[]).map(record => ({ ...record })))
      request.onerror = () => reject(request.error ?? new Error(`读取归档段列表失败：${scope}`))
    })
    return records.sort((left, right) => left.createdAt - right.createdAt)
  }

  async entries(snapshotId: string): Promise<unknown[]> {
    const db = await this.open()
    const stored = await new Promise<{ snapshotId: string; items: unknown[] } | undefined>(
      (resolve, reject) => {
        const transaction = db.transaction(ENTRY_STORE, 'readonly')
        const request = transaction.objectStore(ENTRY_STORE).get(snapshotId)
        request.onsuccess = () =>
          resolve(request.result as { snapshotId: string; items: unknown[] } | undefined)
        request.onerror = () => reject(request.error ?? new Error(`读取归档段条目失败：${snapshotId}`))
      },
    )
    if (stored === undefined) throw new Error(`归档段不存在：${snapshotId}`)
    return stored.items
  }

  async remove(snapshotId: string): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([SNAPSHOT_STORE, ENTRY_STORE], 'readwrite')
      transaction.objectStore(SNAPSHOT_STORE).delete(snapshotId)
      transaction.objectStore(ENTRY_STORE).delete(snapshotId)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(writeError(snapshotId, transaction.error))
      transaction.onerror = () => reject(writeError(snapshotId, transaction.error))
    })
  }

  async usage(scope: string): Promise<number> {
    let total = 0
    for (const record of await this.list(scope)) {
      total += jsonBytes(record) + jsonBytes(await this.entries(record.id))
    }
    return total
  }

  private open(): Promise<IDBDatabase> {
    if (this.opening === null) this.opening = openDb(this.factory, this.dbName)
    return this.opening
  }
}

/* ───────────────────────── 浏览器存储配额 ───────────────────────── */

/**
 * 拿持久化配额，避免空间压力下归档段被回收（§9「备份」）。
 * 任何不可用都返回 false，不抛：拿不到配额只是少了保护，不该阻断打开面板。
 */
export async function persistStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (storage === undefined || typeof storage.persist !== 'function') return false
    return await storage.persist()
  } catch {
    return false
  }
}

/** 整站占用估算（可选展示）；不可用返回 null */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    if (storage === undefined || typeof storage.estimate !== 'function') return null
    const estimate = await storage.estimate()
    if (typeof estimate.usage !== 'number' || typeof estimate.quota !== 'number') return null
    return { usage: estimate.usage, quota: estimate.quota }
  } catch {
    return null
  }
}

/* ───────────────────────── IndexedDB 细节 ───────────────────────── */

function defaultIndexedDb(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new Error('当前环境没有 indexedDB：Node 下请使用 MemorySnapshotBackend')
  }
  return indexedDB
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' }).createIndex('scope', 'scope')
      }
      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        db.createObjectStore(ENTRY_STORE, { keyPath: 'snapshotId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(`打开归档段库失败：${name}`))
  })
}

function writeError(snapshotId: string, error: DOMException | null): Error {
  if (error !== null && error.name === 'ConstraintError') {
    return new Error(`归档段已存在且不可修改：${snapshotId}`)
  }
  return error ?? new Error(`写入归档段失败：${snapshotId}`)
}

/** 占用口径：JSON 字节数（归档段记录 + 条目），与面板显示的 MB 数同源 */
function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return new TextEncoder().encode(text === undefined ? '' : text).length
  } catch {
    return 0
  }
}
