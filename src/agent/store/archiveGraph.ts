/**
 * 归档段谱系与「继承对话」的纯逻辑（不 import PI，可在 Node 里直接验收）。
 *
 * 谱系只有一条边：`SnapshotInfo.parentSnapshotId`。
 * - 同一段继续保存产出的归档，父 = 该段上一次归档；
 * - 从某个归档「继承对话」后新段产出的归档，父 = 被继承的那个归档。
 * 于是「删归档段要连带删掉所有直接/间接引用它的段」就是在这张图上做一次闭包。
 */

import type { SnapshotInfo } from '../contracts'

/** 归档段 id 及其全部后代（含自身）；父指针成环时也不会死循环 */
export function descendantSnapshotIds(
  snapshots: readonly SnapshotInfo[],
  rootId: string,
): Set<string> {
  const doomed = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const snapshot of snapshots) {
      if (doomed.has(snapshot.id)) continue
      if (snapshot.parentSnapshotId && doomed.has(snapshot.parentSnapshotId)) {
        doomed.add(snapshot.id)
        changed = true
      }
    }
  }
  return doomed
}

/** 归档条目里可以被「继承」的部分（结构类型，避免依赖 PI 的类型） */
export type ForkSourceEntry = {
  kind: string
  model?: readonly unknown[]
  data?: unknown
}

/** 可继承的条目种类：对话内容；`pi.compaction` / `pi.reset` 是上下文分界，复制会破坏历史语义，跳过 */
const FORK_KINDS = new Set(['pi.user', 'pi.assistant', 'pi.tool-result', 'pi.system'])

/**
 * 归档条目 → 新会话的 entry 草稿。
 * 丢掉 id / conversationId / byTaskId / head：新段自己分配 id，也不是任何旧任务的产物。
 */
export function forkEntryDrafts(
  entries: readonly ForkSourceEntry[],
): Array<{ kind: string; model?: readonly unknown[]; data?: unknown }> {
  return entries
    .filter((entry) => FORK_KINDS.has(entry.kind))
    .map((entry) => ({
      kind: entry.kind,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    }))
}
