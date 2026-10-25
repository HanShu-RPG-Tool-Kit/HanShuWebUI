/**
 * 将 needed 队列经 Control 出站 `items.renderSnapshots` 批量拉取并写入本机快照缓存。
 * 进度写入 IDE 活动列表（稳定 id，可更新进度条）。
 */

import { pushActivity, updateActivity } from '../activity'
import {
  listSnapshotsNeeded,
  markSnapshotNeeded,
  putCachedDisplay,
  setItemSnapshotRefreshOnline,
  setItemSnapshotRefreshScheduler,
  snapshotsNeededCount,
  type SnapshotNeededItem,
  type SnapshotRefreshScheduleOptions,
} from '../workspaces/gameplay/itemSnapshotCache'
import { readItemStackDisplay } from '../workspaces/gameplay/itemstack'
import { controlRequest, isControlConnected } from './controlHub'

/** 与 mod `items.renderSnapshots` 上限对齐；超过则 too_many_items */
export const RENDER_SNAPSHOTS_BATCH = 128
const DRAIN_COOLDOWN_MS = 400
const ICON_PENDING_RETRY_MS = 1500
/**
 * 同一指纹连续收到 `iconPending` 的最大次数。
 * mod 若一直出不了图标，超过后接受纯文本快照并出队，避免同一批干烧。
 */
export const ICON_PENDING_MAX_ATTEMPTS = 3
/** 单条图标等待约 8s；整批留余量 */
const RPC_TIMEOUT_MS = 20000
const ACTIVITY_ID = 'items.snapshot-refresh'

let started = false
let draining = false
let drainTimer: ReturnType<typeof setTimeout> | null = null
let backoffUntil = 0
/** fingerprint → 已收到 iconPending 的次数 */
const iconPendingAttempts = new Map<string, number>()

/** 当前刷新波次；写完且队列空则收束 */
let wave: { written: number; total: number; iconGaveUp?: number } | null = null

type RenderSnapshotsResult = {
  snapshots?: Array<{
    key?: string
    ok?: boolean
    error?: string
    display?: unknown
  }>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clearDrainTimer() {
  if (!drainTimer) return
  clearTimeout(drainTimer)
  drainTimer = null
}

function ensureWave(queueSize: number): void {
  if (queueSize <= 0) return
  if (!wave) {
    wave = { written: 0, total: queueSize }
    pushActivity({
      id: ACTIVITY_ID,
      kind: 'progress',
      title: '刷新物品快照',
      source: 'items',
      progress: { current: 0, total: queueSize },
      done: false,
    })
    return
  }
  wave.total = Math.max(wave.total, wave.written + queueSize)
  updateActivity(ACTIVITY_ID, {
    kind: 'progress',
    title: '刷新物品快照',
    progress: { current: wave.written, total: wave.total },
    done: false,
  })
}

function announceOfflineQueued(count: number): void {
  if (count <= 0) return
  if (!wave) {
    wave = { written: 0, total: count }
  } else {
    wave.total = Math.max(wave.total, wave.written + count)
  }
  pushActivity({
    id: ACTIVITY_ID,
    kind: 'progress',
    title: '刷新物品快照',
    detail: `已排队 ${count} 项 · 待连接游戏开发服务器`,
    source: 'items',
    progress: 'indeterminate',
    done: false,
  })
}

function afterBatch(okCount: number, iconGaveUp = 0): void {
  if (!wave) return
  wave.written += okCount
  wave.iconGaveUp = (wave.iconGaveUp ?? 0) + iconGaveUp
  const remaining = snapshotsNeededCount()
  wave.total = Math.max(wave.total, wave.written + remaining)
  if (remaining === 0) {
    const n = wave.written
    const gaveUp = wave.iconGaveUp ?? 0
    updateActivity(ACTIVITY_ID, {
      kind: gaveUp > 0 ? 'warning' : 'success',
      title: n > 0 ? `已刷新 ${n} 个物品快照` : '物品快照已是最新',
      detail: gaveUp > 0 ? `其中 ${gaveUp} 个图标未就绪，已保留文本快照` : undefined,
      progress: undefined,
      done: true,
    })
    wave = null
    return
  }
  updateActivity(ACTIVITY_ID, {
    kind: 'progress',
    title: '刷新物品快照',
    detail: `队列剩余 ${remaining}`,
    progress: { current: Math.min(wave.written, wave.total), total: wave.total },
    done: false,
  })
}

function pauseWaveForDisconnect(): void {
  if (!wave) return
  updateActivity(ACTIVITY_ID, {
    kind: 'progress',
    title: '刷新物品快照',
    detail: '连接已断开 · 待重连后继续',
    progress: 'indeterminate',
    done: false,
  })
}

/**
 * @param force 重连时强制取消已有 timer 并尽快 drain（避免离线空跑 timer 吞掉 onopen 调度）
 */
export function scheduleItemSnapshotRefresh(options?: SnapshotRefreshScheduleOptions): void {
  if (!started) return
  if (options?.queued && options.queued > 0 && !isControlConnected()) {
    announceOfflineQueued(options.queued)
  }
  if (options?.force) {
    // 强制刷新：允许图标再试一轮
    iconPendingAttempts.clear()
    clearDrainTimer()
  }
  if (drainTimer) return
  const wait = options?.force
    ? 0
    : Math.max(DRAIN_COOLDOWN_MS, backoffUntil - Date.now())
  drainTimer = setTimeout(() => {
    drainTimer = null
    void drainSnapshotQueue()
  }, wait)
}

export function ensureItemSnapshotRefreshStarted(): void {
  if (started) return
  started = true
  setItemSnapshotRefreshScheduler((options) => scheduleItemSnapshotRefresh(options))
  setItemSnapshotRefreshOnline(isControlConnected())
  scheduleItemSnapshotRefresh()
}

/** Control 连上 / 断开时由 controlHub 调用 */
export function onControlConnectionChange(online: boolean): void {
  setItemSnapshotRefreshOnline(online)
  if (online) {
    backoffUntil = 0
    scheduleItemSnapshotRefresh({ force: true })
  } else {
    clearDrainTimer()
    pauseWaveForDisconnect()
  }
}

/** 测试用：直接跑一轮 drain（可注入 request） */
export async function drainSnapshotQueueForTests(
  request: typeof controlRequest = controlRequest,
): Promise<void> {
  await drainSnapshotQueue(request)
}

async function drainSnapshotQueue(
  request: typeof controlRequest = controlRequest,
): Promise<void> {
  if (draining) return
  if (!isControlConnected() && request === controlRequest) {
    // 离线不空转重排；等 onControlConnectionChange(true) 再 force drain
    return
  }
  const queueSize = snapshotsNeededCount()
  const batch = listSnapshotsNeeded(RENDER_SNAPSHOTS_BATCH)
  if (batch.length === 0) {
    if (wave && queueSize === 0) afterBatch(0)
    return
  }

  ensureWave(queueSize)
  draining = true
  let okCount = 0
  let iconGaveUp = 0
  try {
    const flushed = await flushBatch(batch, request)
    okCount = flushed.okCount
    iconGaveUp = flushed.iconGaveUp
  } finally {
    draining = false
  }
  afterBatch(okCount, iconGaveUp)
  if (
    listSnapshotsNeeded(1).length > 0
    && (request !== controlRequest || isControlConnected())
  ) {
    scheduleItemSnapshotRefresh()
  }
}

async function flushBatch(
  batch: SnapshotNeededItem[],
  request: typeof controlRequest,
): Promise<{ okCount: number; iconGaveUp: number }> {
  const params = {
    componentFormat: 'tnbt-json-v1',
    componentMode: 'complete',
    items: batch.map((item) => ({
      key: item.fingerprint,
      id: item.id,
      components: item.components,
    })),
    includeIcon: true,
  }
  let result: unknown
  try {
    result = await request('items.renderSnapshots', params, RPC_TIMEOUT_MS)
    backoffUntil = 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'control_not_connected' || message === 'disconnected') {
      return { okCount: 0, iconGaveUp: 0 }
    }
    backoffUntil = Date.now() + 3000
    return { okCount: 0, iconGaveUp: 0 }
  }

  if (
    !isObject(result)
    || result.componentFormat !== 'tnbt-json-v1'
    || result.componentMode !== 'complete'
    || !Array.isArray(result.snapshots)
  ) {
    return { okCount: 0, iconGaveUp: 0 }
  }
  const body = result as RenderSnapshotsResult
  let needIconRetry = false
  let okCount = 0
  let iconGaveUp = 0
  for (const entry of body.snapshots ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const key = typeof entry.key === 'string' ? entry.key : ''
    if (!key) continue
    if (entry.ok === false) continue
    const display = readItemStackDisplay(entry.display)
    if (!display) continue

    if (display.iconPending) {
      const attempts = (iconPendingAttempts.get(key) ?? 0) + 1
      iconPendingAttempts.set(key, attempts)
      if (attempts >= ICON_PENDING_MAX_ATTEMPTS) {
        // 放弃等图标：清掉 pending，否则表视图会因 iconPending 再次入队
        await putCachedDisplay(key, { ...display, iconPending: false })
        iconPendingAttempts.delete(key)
        okCount += 1
        iconGaveUp += 1
        continue
      }
      await putCachedDisplay(key, display)
      // 仍待图标：不计入「已刷新」，留给后续轮次或达上限后结算
      needIconRetry = true
      const meta = batch.find((item) => item.fingerprint === key)
      if (meta) markSnapshotNeeded(meta)
      continue
    }

    iconPendingAttempts.delete(key)
    await putCachedDisplay(key, display)
    okCount += 1
  }
  if (needIconRetry) {
    backoffUntil = Date.now() + ICON_PENDING_RETRY_MS
  }
  return { okCount, iconGaveUp }
}
