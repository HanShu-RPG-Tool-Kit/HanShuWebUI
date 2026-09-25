/**
 * 文件历史版本（类似 Overleaf）：
 * - 本地 localStorage
 * - .hs 保留更多份
 * - 手动保存 / Agent 覆盖 / 定时快照
 */

const HISTORY_KEY = 'hanshu.fileHistory.v1'
/** 兼容旧备份键 */
const LEGACY_BACKUP_KEY = 'hanshu.fileBackups.v1'

const MAX_DEFAULT = 20
const MAX_HS = 40
const MIN_INTERVAL_MS = 8000

export type FileVersion = {
  id: string
  fileName: string
  content: string
  savedAt: number
  reason: string
}

type HistoryStore = Record<string, FileVersion[]>

function uid() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function maxFor(fileName: string) {
  return fileName.toLowerCase().endsWith('.hs') ? MAX_HS : MAX_DEFAULT
}

function loadStore(): HistoryStore {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw) {
      const data = JSON.parse(raw) as HistoryStore
      if (data && typeof data === 'object') return migrateLegacy(data)
    }
  } catch {
    // fall through
  }
  return migrateLegacy({})
}

function migrateLegacy(store: HistoryStore): HistoryStore {
  try {
    const raw = localStorage.getItem(LEGACY_BACKUP_KEY)
    if (!raw) return store
    const legacy = JSON.parse(raw) as Record<
      string,
      Array<{ fileName: string; content: string; savedAt: number; reason: string }>
    >
    for (const [key, list] of Object.entries(legacy)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const existing = store[key] ?? []
      const merged = [
        ...list.map((item) => ({
          id: uid(),
          fileName: item.fileName,
          content: item.content,
          savedAt: item.savedAt,
          reason: item.reason || 'legacy',
        })),
        ...existing,
      ]
      // 按时间去重内容
      const seen = new Set<string>()
      const dedup: FileVersion[] = []
      for (const v of merged.sort((a, b) => b.savedAt - a.savedAt)) {
        if (seen.has(v.content)) continue
        seen.add(v.content)
        dedup.push(v)
      }
      store[key] = dedup.slice(0, maxFor(key))
    }
    localStorage.removeItem(LEGACY_BACKUP_KEY)
    saveStore(store)
  } catch {
    // ignore
  }
  return store
}

function saveStore(store: HistoryStore) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(store))
  } catch (err) {
    // 配额满：丢掉最旧的非 hs，再试一次
    console.warn('history save failed, pruning', err)
    for (const key of Object.keys(store)) {
      if (!key.endsWith('.hs')) {
        store[key] = (store[key] ?? []).slice(0, 5)
      } else {
        store[key] = (store[key] ?? []).slice(0, 15)
      }
    }
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(store))
    } catch {
      // give up
    }
  }
}

const lastPushAt = new Map<string, number>()

/**
 * 推入历史。同内容跳过；可 force 忽略最短间隔。
 * @returns 是否真正写入
 */
export function pushFileVersion(
  fileName: string,
  content: string,
  reason: string,
  options?: { force?: boolean },
): boolean {
  if (!fileName || content === undefined || content === null) return false
  const key = fileName.toLowerCase()
  const now = Date.now()
  if (!options?.force) {
    const lastAt = lastPushAt.get(key) ?? 0
    if (now - lastAt < MIN_INTERVAL_MS && reason.startsWith('auto')) {
      return false
    }
  }

  const store = loadStore()
  const list = store[key] ?? []
  if (list[0]?.content === content) {
    lastPushAt.set(key, now)
    return false
  }

  const version: FileVersion = {
    id: uid(),
    fileName,
    content,
    savedAt: now,
    reason,
  }
  store[key] = [version, ...list].slice(0, maxFor(fileName))
  saveStore(store)
  lastPushAt.set(key, now)
  return true
}

/** @deprecated 兼容旧名 */
export function pushFileBackup(
  fileName: string,
  content: string,
  reason: string,
): void {
  pushFileVersion(fileName, content, reason, { force: true })
}

export function listFileVersions(fileName: string): FileVersion[] {
  const store = loadStore()
  return store[fileName.toLowerCase()] ?? []
}

export function listHistoryFileNames(): string[] {
  return Object.keys(loadStore()).sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function getFileVersion(
  fileName: string,
  versionId: string,
): FileVersion | null {
  return listFileVersions(fileName).find((v) => v.id === versionId) ?? null
}

export function deleteFileVersion(fileName: string, versionId: string): void {
  const store = loadStore()
  const key = fileName.toLowerCase()
  store[key] = (store[key] ?? []).filter((v) => v.id !== versionId)
  if (store[key].length === 0) delete store[key]
  saveStore(store)
}

export function formatVersionTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function reasonLabel(reason: string): string {
  if (reason === 'manual-save') return '手动保存'
  if (reason === 'auto-hs') return '自动快照'
  if (reason.startsWith('agent.')) return 'Agent 写入前'
  if (reason === 'legacy') return '旧备份'
  if (reason === 'restore-point') return '恢复前'
  return reason
}
