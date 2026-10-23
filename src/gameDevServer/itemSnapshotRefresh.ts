/**
 * 将 needed 队列经 Control 出站 `items.renderSnapshots` 批量拉取并写入本机快照缓存。
 */

import {
  listSnapshotsNeeded,
  markSnapshotNeeded,
  putCachedDisplay,
  setItemSnapshotRefreshOnline,
  setItemSnapshotRefreshScheduler,
  type SnapshotNeededItem,
} from '../workspaces/progress/itemSnapshotCache'
import { readItemStackDisplay } from '../workspaces/progress/itemstack'
import { controlRequest, isControlConnected } from './controlHub'

/** 与 mod `items.renderSnapshots` 上限对齐；超过则 too_many_items */
export const RENDER_SNAPSHOTS_BATCH = 128
const DRAIN_COOLDOWN_MS = 400
const ICON_PENDING_RETRY_MS = 1500
/** 单条图标等待约 8s；整批留余量 */
const RPC_TIMEOUT_MS = 20000

let started = false
let draining = false
let drainTimer: ReturnType<typeof setTimeout> | null = null
let backoffUntil = 0

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

/**
 * @param force 重连时强制取消已有 timer 并尽快 drain（避免离线空跑 timer 吞掉 onopen 调度）
 */
export function scheduleItemSnapshotRefresh(options?: { force?: boolean }): void {
  if (!started) return
  if (options?.force) clearDrainTimer()
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
  const batch = listSnapshotsNeeded(RENDER_SNAPSHOTS_BATCH)
  if (batch.length === 0) return

  draining = true
  try {
    await flushBatch(batch, request)
  } finally {
    draining = false
  }
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
): Promise<void> {
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
    if (message === 'control_not_connected' || message === 'disconnected') return
    backoffUntil = Date.now() + 3000
    return
  }

  if (!isObject(result) || result.componentFormat !== 'tnbt-json-v1' || result.componentMode !== 'complete' || !Array.isArray(result.snapshots)) return
  const body = result as RenderSnapshotsResult
  let needIconRetry = false
  for (const entry of body.snapshots ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const key = typeof entry.key === 'string' ? entry.key : ''
    if (!key) continue
    if (entry.ok === false) continue
    const display = readItemStackDisplay(entry.display)
    if (!display) continue
    await putCachedDisplay(key, display)
    if (display.iconPending) {
      needIconRetry = true
      const meta = batch.find((item) => item.fingerprint === key)
      if (meta) markSnapshotNeeded(meta)
    }
  }
  if (needIconRetry) {
    backoffUntil = Date.now() + ICON_PENDING_RETRY_MS
  }
}
