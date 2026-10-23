/**
 * 物品展示快照：C 侧 IndexedDB 缓存（按 id+components 指纹）。
 * 工程文件不再持久化 display；导入旧 display 经 ingest 写入此处。
 */

import {
  itemFingerprint,
  readItemStackDisplay,
  type ItemStackDisplay,
} from './itemstack'

export type SnapshotNeededItem = {
  fingerprint: string
  id: string
  components: Record<string, unknown>
}

export type ItemSnapshotStore = {
  get(fingerprint: string): Promise<ItemStackDisplay | undefined>
  put(fingerprint: string, display: ItemStackDisplay): Promise<void>
  delete(fingerprint: string): Promise<void>
  clear(): Promise<void>
}

const DB_NAME = 'hanshu.itemSnapshots.v1'
const STORE = 'snapshots'
const DB_VERSION = 1
/** 自动 needed 队列；≥ 单批 128，留余量给后续 drain */
const NEEDED_LIMIT = 256
/** 手动「刷新全部」时可排队的上限 */
const FORCE_NEEDED_LIMIT = 512
/** 表视图 / 预览 miss 时是否自动入队拉取；手动菜单刷新不受此限 */
const AUTO_REFRESH_STORAGE_KEY = 'hanshu.items.autoSnapshotRefresh'

const memory = new Map<string, ItemStackDisplay>()
const neededOrder: string[] = []
const neededMeta = new Map<string, SnapshotNeededItem>()
const listeners = new Set<() => void>()
/** 正在从 IDB 回填的指纹，避免同步 miss 时重复打打开销 */
const hydrating = new Set<string>()

let revision = 0
let store: ItemSnapshotStore | null = null
let idbUnavailable = false
/** Control 是否已连接；由 itemSnapshotRefresh 同步，供徽章区分「刷新中」与「待连接」 */
let refreshOnline = false
let autoRefreshEnabled = loadAutoRefreshPref()

function loadAutoRefreshPref(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_REFRESH_STORAGE_KEY)
    if (raw === null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

function bump() {
  revision += 1
  for (const listener of listeners) listener()
}

/** miss / 过期 / 表视图滚动时是否自动入队；默认开 */
export function isAutoItemSnapshotRefreshEnabled(): boolean {
  return autoRefreshEnabled
}

/**
 * 开关自动刷新。关闭时清空 needed 队列（已发起的手动刷新批次仍会跑完当前 in-flight）。
 * 手动「刷新物品快照」不受影响。
 */
export function setAutoItemSnapshotRefreshEnabled(enabled: boolean): void {
  if (autoRefreshEnabled === enabled) return
  autoRefreshEnabled = enabled
  try {
    localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* 隐私模式等 */
  }
  if (!enabled) clearAllNeeded()
  bump()
}

export function clearAllNeeded(): void {
  if (neededMeta.size === 0) return
  neededMeta.clear()
  neededOrder.length = 0
  bump()
}

export function setItemSnapshotRefreshOnline(online: boolean): void {
  if (refreshOnline === online) return
  refreshOnline = online
  bump()
}

export function isItemSnapshotRefreshOnline(): boolean {
  return refreshOnline
}

export function getItemSnapshotRevision(): number {
  return revision
}

export function subscribeItemSnapshots(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：注入内存 store，并清空状态 */
export function useMemoryItemSnapshotStore(
  initial?: Map<string, ItemStackDisplay>,
): ItemSnapshotStore {
  memory.clear()
  neededOrder.length = 0
  neededMeta.clear()
  if (initial) {
    for (const [key, value] of initial) memory.set(key, value)
  }
  const memStore: ItemSnapshotStore = {
    async get(fingerprint) {
      return memory.get(fingerprint)
    },
    async put(fingerprint, display) {
      memory.set(fingerprint, display)
    },
    async delete(fingerprint) {
      memory.delete(fingerprint)
    },
    async clear() {
      memory.clear()
    },
  }
  store = memStore
  idbUnavailable = true
  bump()
  return memStore
}

export function resetItemSnapshotCacheForTests(): void {
  memory.clear()
  neededOrder.length = 0
  neededMeta.clear()
  store = null
  idbUnavailable = false
  refreshOnline = false
  autoRefreshEnabled = true
  bump()
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('itemSnapshot IDB open failed'))
  })
}

function defaultIdbStore(): ItemSnapshotStore {
  return {
    async get(fingerprint) {
      const db = await openDb()
      try {
        return await new Promise<ItemStackDisplay | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly')
          const req = tx.objectStore(STORE).get(fingerprint)
          req.onsuccess = () => {
            const value = req.result
            resolve(value && typeof value === 'object' ? (value as ItemStackDisplay) : undefined)
          }
          req.onerror = () => reject(req.error ?? new Error('itemSnapshot get failed'))
        })
      } finally {
        db.close()
      }
    },
    async put(fingerprint, display) {
      const db = await openDb()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).put(display, fingerprint)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('itemSnapshot put failed'))
        })
      } finally {
        db.close()
      }
    },
    async delete(fingerprint) {
      const db = await openDb()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).delete(fingerprint)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('itemSnapshot delete failed'))
        })
      } finally {
        db.close()
      }
    },
    async clear() {
      const db = await openDb()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).clear()
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('itemSnapshot clear failed'))
        })
      } finally {
        db.close()
      }
    },
  }
}

function activeStore(): ItemSnapshotStore {
  if (store) return store
  if (idbUnavailable || typeof indexedDB === 'undefined') {
    idbUnavailable = true
    store = {
      async get(fp) {
        return memory.get(fp)
      },
      async put(fp, display) {
        memory.set(fp, display)
      },
      async delete(fp) {
        memory.delete(fp)
      },
      async clear() {
        memory.clear()
      },
    }
    return store
  }
  store = defaultIdbStore()
  return store
}

function normalizeDisplay(
  fingerprint: string,
  display: ItemStackDisplay,
): ItemStackDisplay {
  return { ...display, snapshotOf: fingerprint }
}

/**
 * 从 IDB 读出时保留原 snapshotOf（可能过期）；仅缺省时补当前指纹。
 * 新鲜写入仍走 putCachedDisplay → normalizeDisplay。
 */
function entryFromStore(
  fingerprint: string,
  raw: ItemStackDisplay,
): ItemStackDisplay {
  const parsed = readItemStackDisplay(raw) ?? raw
  if (typeof parsed.snapshotOf === 'string' && parsed.snapshotOf) return parsed
  return normalizeDisplay(fingerprint, parsed)
}

/** 同步读内存镜像；miss 时异步从 IDB 回填并 bump，供下一帧渲染 */
export function getCachedDisplaySync(
  fingerprint: string,
): ItemStackDisplay | undefined {
  const hit = memory.get(fingerprint)
  if (hit) return hit
  if (!hydrating.has(fingerprint) && !idbUnavailable) {
    hydrating.add(fingerprint)
    void getCachedDisplay(fingerprint).finally(() => {
      hydrating.delete(fingerprint)
    })
  }
  return undefined
}

export function isCachedSnapshotFresh(item: {
  id: string
  components: Record<string, unknown>
}): boolean {
  const fp = itemFingerprint(item)
  const display = memory.get(fp)
  return !!display && display.snapshotOf === fp && !display.iconPending
}

export async function getCachedDisplay(
  fingerprint: string,
): Promise<ItemStackDisplay | undefined> {
  const hit = memory.get(fingerprint)
  if (hit) return hit
  try {
    const loaded = await activeStore().get(fingerprint)
    if (loaded) {
      const entry = entryFromStore(fingerprint, loaded)
      memory.set(fingerprint, entry)
      bump()
      return entry
    }
  } catch {
    idbUnavailable = true
  }
  return undefined
}

function snapshotEntrySame(
  a: ItemStackDisplay,
  b: ItemStackDisplay,
): boolean {
  return (
    a.snapshotOf === b.snapshotOf
    && a.iconPending === b.iconPending
    && a.locale === b.locale
    && a.generatedAt === b.generatedAt
    && a.foil === b.foil
    && a.defaultColor === b.defaultColor
    && a.rarity === b.rarity
    && a.rarityColor === b.rarityColor
    && a.icon?.data === b.icon?.data
    && a.icon?.mime === b.icon?.mime
    && JSON.stringify(a.name) === JSON.stringify(b.name)
    && JSON.stringify(a.tooltip) === JSON.stringify(b.tooltip)
  )
}

export async function putCachedDisplay(
  fingerprint: string,
  display: ItemStackDisplay,
): Promise<void> {
  const normalized = normalizeDisplay(
    fingerprint,
    readItemStackDisplay(display) ?? display,
  )
  const prev = memory.get(fingerprint)
  const unchanged = !!prev && snapshotEntrySame(prev, normalized)
  memory.set(fingerprint, normalized)
  // iconPending：文本可用但仍需再拉图标，保留在 needed
  if (!normalized.iconPending) clearNeeded(fingerprint)
  // 相同内容不再 bump，避免表视图 parse→ingest 同步重渲染死循环
  if (!unchanged) bump()
  try {
    await activeStore().put(fingerprint, normalized)
  } catch {
    idbUnavailable = true
  }
}

/**
 * 旧文件 / 导入的 display → 本机缓存。
 * - 指纹一致：写入并规范 snapshotOf（可被后续 renderSnapshots 覆盖）
 * - 指纹过期：仍写入供 UI 标「过期」，并 markNeeded；新快照到来时 put 覆盖
 * - 已有新鲜缓存：不拿过期文件盖掉
 * 工程文件本身不回写 display（stringify 永不写）。
 */
export function ingestDisplay(
  item: { id: string; components: Record<string, unknown> },
  display: ItemStackDisplay | undefined,
): void {
  if (!display) return
  const fp = itemFingerprint(item)
  if (isCachedSnapshotFresh(item)) return

  if (display.snapshotOf && display.snapshotOf !== fp) {
    const parsed = readItemStackDisplay(display) ?? display
    const prev = memory.get(fp)
    // 已有任意缓存且并非更差时，仍要排队刷新，但不反复 bump
    if (!prev || prev.snapshotOf !== fp) {
      memory.set(fp, parsed)
      bump()
      void activeStore()
        .put(fp, parsed)
        .catch(() => {
          idbUnavailable = true
        })
    }
    if (autoRefreshEnabled) markSnapshotNeeded(item)
    return
  }
  void putCachedDisplay(fp, display)
}

export function isSnapshotNeeded(fingerprint: string): boolean {
  return neededMeta.has(fingerprint)
}

export function markSnapshotNeeded(item: {
  id: string
  components: Record<string, unknown>
}): string {
  const id = item.id.trim()
  if (!id) return ''
  const fingerprint = itemFingerprint(item)
  if (isCachedSnapshotFresh(item)) {
    clearNeeded(fingerprint)
    return fingerprint
  }
  if (neededMeta.has(fingerprint)) {
    // 移到队尾，保持最近需要优先
    const index = neededOrder.indexOf(fingerprint)
    if (index >= 0) neededOrder.splice(index, 1)
    neededOrder.push(fingerprint)
    return fingerprint
  }
  neededMeta.set(fingerprint, {
    fingerprint,
    id,
    components: { ...item.components },
  })
  neededOrder.push(fingerprint)
  while (neededOrder.length > NEEDED_LIMIT) {
    const drop = neededOrder.shift()
    if (drop) neededMeta.delete(drop)
  }
  bump()
  return fingerprint
}

export function clearNeeded(fingerprint: string): void {
  if (!neededMeta.has(fingerprint)) return
  neededMeta.delete(fingerprint)
  const index = neededOrder.indexOf(fingerprint)
  if (index >= 0) neededOrder.splice(index, 1)
  bump()
}

export function listSnapshotsNeeded(limit = NEEDED_LIMIT): SnapshotNeededItem[] {
  const out: SnapshotNeededItem[] = []
  for (const fp of neededOrder) {
    const meta = neededMeta.get(fp)
    if (!meta) continue
    out.push({
      fingerprint: meta.fingerprint,
      id: meta.id,
      components: { ...meta.components },
    })
    if (out.length >= limit) break
  }
  return out
}

export function snapshotsNeededCount(): number {
  return neededMeta.size
}

export type SnapshotRefreshScheduleOptions = {
  force?: boolean
  /** 强制入队数量；离线时用于活动列表提示 */
  queued?: number
}

let refreshScheduler: ((options?: SnapshotRefreshScheduleOptions) => void) | null = null

/** 由 gameDevServer 注册：队列变化时尝试 items.renderSnapshots */
export function setItemSnapshotRefreshScheduler(
  fn: ((options?: SnapshotRefreshScheduleOptions) => void) | null,
): void {
  refreshScheduler = fn
}

export function scheduleItemSnapshotRefresh(options?: SnapshotRefreshScheduleOptions): void {
  refreshScheduler?.(options)
}

/**
 * 强制重新拉取快照：即使当前 fresh 也入队。
 * **不删**内存/IDB 旧条目，旧图继续显示直到 putCachedDisplay 覆盖。
 */
export function forceRequestItemSnapshots(
  items: Iterable<{ id: string; components: Record<string, unknown> }>,
): number {
  let count = 0
  for (const item of items) {
    const id = item.id.trim()
    if (!id) continue
    const fingerprint = itemFingerprint(item)
    neededMeta.set(fingerprint, {
      fingerprint,
      id,
      components: { ...item.components },
    })
    const index = neededOrder.indexOf(fingerprint)
    if (index >= 0) neededOrder.splice(index, 1)
    neededOrder.push(fingerprint)
    count += 1
  }
  while (neededOrder.length > FORCE_NEEDED_LIMIT) {
    const drop = neededOrder.shift()
    if (drop) neededMeta.delete(drop)
  }
  if (count > 0) {
    bump()
    scheduleItemSnapshotRefresh({ force: true, queued: count })
  }
  return count
}
