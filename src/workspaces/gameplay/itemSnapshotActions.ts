/**
 * 物品展示快照的统一刷新入口。
 *
 * 菜单“刷新当前文档 / 刷新全部”和编辑器面板上的“刷新”按钮都走这里，
 * 不再由 UI 各自判断文档类型。
 */

import { forceRequestItemSnapshots } from './itemSnapshotCache'
import {
  collectDocumentSnapshotItems,
  collectWorkspaceSnapshotItems,
  type SnapshotDocumentLike,
  type SnapshotSourceContext,
} from './itemSnapshotSources'

/** 强制重拉一个文档里的所有物品；返回去重后的排队数量。 */
export function refreshDocumentItemSnapshots(
  doc: SnapshotDocumentLike,
  context?: SnapshotSourceContext,
): number {
  return forceRequestItemSnapshots(collectDocumentSnapshotItems(doc, context))
}

/** 强制重拉一组文档；跨文档按指纹去重后只入队一次。 */
export function refreshDocumentsItemSnapshots(
  documents: readonly SnapshotDocumentLike[],
  context?: SnapshotSourceContext,
): number {
  return forceRequestItemSnapshots(collectWorkspaceSnapshotItems(documents, context))
}
