/**
 * 全 IDE 活动列表：短提示与可更新进度任务的统一通道。
 * 不占编辑区 layout；由右下角铃铛面板展示。
 */

export type ActivityKind = 'info' | 'success' | 'warning' | 'error' | 'progress'

export type ActivityEntry = {
  id: string
  at: number
  kind: ActivityKind
  title: string
  detail?: string
  /** 来源工作区或子系统，如 progress / items / project */
  source?: string
  /** 进度任务：确定进度或不确定 */
  progress?: { current: number; total: number } | 'indeterminate'
  /** progress 完成后为 true；普通通知默认 true */
  done: boolean
  unread: boolean
}

export type ActivitySnapshot = {
  entries: ActivityEntry[]
  unreadCount: number
  open: boolean
}

const LIMIT = 80
let seq = 0
let open = false
const entries: ActivityEntry[] = []
const listeners = new Set<() => void>()
/** useSyncExternalStore 要求 getSnapshot 在未变更时返回同一引用 */
let cachedSnapshot: ActivitySnapshot = {
  entries: [],
  unreadCount: 0,
  open: false,
}

function unreadCountOf(): number {
  let n = 0
  for (const entry of entries) if (entry.unread) n += 1
  return n
}

function rebuildSnapshot(): void {
  cachedSnapshot = {
    entries: entries.slice(),
    unreadCount: unreadCountOf(),
    open,
  }
}

function bump() {
  rebuildSnapshot()
  for (const listener of listeners) listener()
}

export function getActivitySnapshot(): ActivitySnapshot {
  return cachedSnapshot
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setActivityPanelOpen(next: boolean): void {
  if (open === next) return
  open = next
  if (next) {
    for (const entry of entries) entry.unread = false
  }
  bump()
}

export function toggleActivityPanel(): void {
  setActivityPanelOpen(!open)
}

export type PushActivityInput = {
  kind?: ActivityKind
  title: string
  detail?: string
  source?: string
  progress?: ActivityEntry['progress']
  /** 默认：progress 为 false，其余 true */
  done?: boolean
  id?: string
}

export function pushActivity(input: PushActivityInput): string {
  const title = input.title.trim()
  if (!title) return ''
  const id = input.id?.trim() || `act-${Date.now().toString(36)}-${(seq += 1)}`
  const kind = input.kind ?? 'info'
  const done = input.done ?? kind !== 'progress'
  const entry: ActivityEntry = {
    id,
    at: Date.now(),
    kind,
    title,
    detail: input.detail,
    source: input.source,
    progress: input.progress,
    done,
    unread: !open,
  }
  const existing = entries.findIndex((row) => row.id === id)
  if (existing >= 0) entries.splice(existing, 1)
  entries.unshift(entry)
  while (entries.length > LIMIT) entries.pop()
  bump()
  return id
}

export function updateActivity(
  id: string,
  patch: Partial<Omit<ActivityEntry, 'id' | 'at'>>,
): void {
  const entry = entries.find((row) => row.id === id)
  if (!entry) return
  Object.assign(entry, patch)
  if (patch.title !== undefined || patch.detail !== undefined || patch.kind !== undefined || patch.done !== undefined || patch.progress !== undefined) {
    entry.unread = !open
    entry.at = Date.now()
    // 移到顶部
    const index = entries.indexOf(entry)
    if (index > 0) {
      entries.splice(index, 1)
      entries.unshift(entry)
    }
  }
  bump()
}

export function dismissActivity(id: string): void {
  const index = entries.findIndex((row) => row.id === id)
  if (index < 0) return
  entries.splice(index, 1)
  bump()
}

export function clearActivities(): void {
  if (entries.length === 0) return
  entries.length = 0
  bump()
}

export function markActivitiesRead(): void {
  let changed = false
  for (const entry of entries) {
    if (entry.unread) {
      entry.unread = false
      changed = true
    }
  }
  if (changed) bump()
}

/** 推断短提示的 kind（进度工作区迁移用） */
export function inferActivityKind(message: string): ActivityKind {
  if (/失败|错误|异常|不可|无法|请先|无效|拒绝/.test(message)) return 'error'
  if (/警告|跳过|过期/.test(message)) return 'warning'
  if (/已|成功|完成|请求刷新|已排队|已导入|已导出|已下载|已保存|已更新/.test(message)) return 'success'
  return 'info'
}

/** 便捷：推一条短提示 */
export function notify(
  title: string,
  options?: Omit<PushActivityInput, 'title'>,
): string {
  const kind = options?.kind ?? inferActivityKind(title)
  return pushActivity({ ...options, title, kind })
}
