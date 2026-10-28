/**
 * 礼包 / 商店物品面板的快照状态汇总。
 *
 * 只做汇总，不逐行挂徽章：面板标题右侧显示“已同步 x/y”，并提供统一刷新入口。
 * 数据仍来自同一个指纹缓存，状态口径与 `.item` 编辑器、物品库表视图一致。
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { ItemCatalog, KitItem } from './kit'
import { forceRequestItemSnapshots, getItemSnapshotRevision, subscribeItemSnapshots } from './itemSnapshotCache'
import { snapshotStatusOf } from './itemPresentation'
import { collectKitSnapshotItems } from './itemSnapshotSources'

export function ItemSnapshotPanelStatus({ items, catalog, disabled }: {
  items: readonly KitItem[]
  catalog?: ItemCatalog
  disabled?: boolean
}) {
  const revision = useSyncExternalStore(
    subscribeItemSnapshots,
    getItemSnapshotRevision,
    getItemSnapshotRevision,
  )
  const sources = useMemo(
    () => collectKitSnapshotItems(items, catalog),
    [items, catalog],
  )
  const summary = useMemo(() => {
    void revision
    let fresh = 0
    let stale = 0
    let pending = 0
    let queued = 0
    let none = 0
    for (const item of sources) {
      const status = snapshotStatusOf(item)
      if (status === 'fresh') fresh += 1
      else if (status === 'stale') stale += 1
      else if (status === 'pending') pending += 1
      else if (status === 'queued') queued += 1
      else none += 1
    }
    return { total: sources.length, fresh, stale, pending, queued, none }
  }, [sources, revision])

  if (summary.total === 0) return null

  const label = summary.fresh === summary.total
    ? `快照已同步 ${summary.fresh}/${summary.total}`
    : summary.pending > 0
      ? `快照刷新中 ${summary.fresh}/${summary.total}`
      : summary.queued > 0
        ? `快照待同步 ${summary.fresh}/${summary.total}`
        : `快照待刷新 ${summary.fresh}/${summary.total}`
  const tone = summary.fresh === summary.total
    ? 'is-ok'
    : summary.pending + summary.queued > 0
      ? 'is-pending'
      : 'is-warn'
  const title = [
    `共 ${summary.total} 项`,
    `已同步 ${summary.fresh}`,
    summary.stale > 0 ? `待刷新 ${summary.stale}` : '',
    summary.pending > 0 ? `刷新中 ${summary.pending}` : '',
    summary.queued > 0 ? `待同步 ${summary.queued}` : '',
    summary.none > 0 ? `无快照 ${summary.none}` : '',
  ].filter(Boolean).join(' · ')

  function refresh() {
    if (disabled) return
    forceRequestItemSnapshots(sources)
  }

  return <span className={`item-snapshot-summary ${tone}`} title={title}>
    <span className="item-snapshot-summary-text">{label}</span>
    <button
      type="button"
      className="kit-add item-snapshot-refresh"
      disabled={disabled}
      title="强制重新拉取本面板物品快照；未连接游戏开发服务器时排队"
      onClick={refresh}
    >刷新</button>
  </span>
}
