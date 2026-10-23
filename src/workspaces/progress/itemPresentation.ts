/**
 * 缓存驱动的物品展示：同步 present + React hook；miss/stale 时登记 needed。
 */

import { useSyncExternalStore } from 'react'
import {
  getCachedDisplaySync,
  getItemSnapshotRevision,
  isCachedSnapshotFresh,
  isItemSnapshotRefreshOnline,
  isSnapshotNeeded,
  markSnapshotNeeded,
  scheduleItemSnapshotRefresh,
  subscribeItemSnapshots,
} from './itemSnapshotCache'
import { itemFingerprint, type ItemStackDisplay } from './itemstack'
import { presentItem, type ItemPresentation } from './itemTooltip'

export type ItemLikeForPresentation = {
  id: string
  count?: number
  components: Record<string, unknown>
  /** 仅迁移/导入瞬时；正式路径应走缓存 */
  display?: ItemStackDisplay
}

/** 只读展示，不登记 needed（表视图 buildRows 用，避免渲染期 bump） */
export function peekItemPresentation(item: ItemLikeForPresentation): ItemPresentation {
  const cached = getCachedDisplaySync(itemFingerprint(item))
  return presentItem({
    id: item.id,
    count: item.count,
    components: item.components,
    display: cached,
  })
}

export function presentItemFromCache(item: ItemLikeForPresentation): ItemPresentation {
  const fp = itemFingerprint(item)
  const cached = getCachedDisplaySync(fp)
  const presentation = peekItemPresentation(item)
  if (!isCachedSnapshotFresh(item) || cached?.iconPending) {
    // 推迟到渲染外，避免 useSyncExternalStore 订阅方在 render 里被 bump 打成死循环
    queueMicrotask(() => {
      markSnapshotNeeded(item)
      scheduleItemSnapshotRefresh()
    })
  }
  return presentation
}

export function snapshotStatusOf(item: {
  id: string
  components: Record<string, unknown>
}): 'none' | 'fresh' | 'stale' | 'pending' | 'queued' {
  const fp = itemFingerprint(item)
  const cached = getCachedDisplaySync(fp)
  if (cached?.iconPending) {
    return isItemSnapshotRefreshOnline() ? 'pending' : 'queued'
  }
  if (cached && cached.snapshotOf === fp) return 'fresh'
  if (cached && cached.snapshotOf !== fp) return 'stale'
  if (isSnapshotNeeded(fp)) {
    // 离线只是排队，不要一直显示「刷新中」
    return isItemSnapshotRefreshOnline() ? 'pending' : 'queued'
  }
  return 'none'
}

export function useItemPresentation(item: ItemLikeForPresentation): ItemPresentation {
  useSyncExternalStore(
    subscribeItemSnapshots,
    getItemSnapshotRevision,
    getItemSnapshotRevision,
  )
  return presentItemFromCache(item)
}

export function useItemSnapshotStatus(item: {
  id: string
  components: Record<string, unknown>
}): 'none' | 'fresh' | 'stale' | 'pending' | 'queued' {
  useSyncExternalStore(
    subscribeItemSnapshots,
    getItemSnapshotRevision,
    getItemSnapshotRevision,
  )
  return snapshotStatusOf(item)
}
