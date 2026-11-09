/**
 * 会话存储的库名（文档 §9「存储落地」）。
 *
 * 三个库都只在本机 IndexedDB：
 *   活跃段库     `hanshu.agent.session.<windowId>.<scope>` —— 每窗口一个，跨窗口互不可见（§11 第 4 条）
 *   归档段库     `hanshu.agent.archive.<scope>`            —— 按工程 scope 分区，同 scope 的所有窗口可读
 *   撤销日志库   `hanshu.agent.undo.<scope>`               —— 活跃段级待处理回滚（D3/D4，刷新后可继续回滚）
 *
 * 为什么必须清洗字符：scope 可能是 S 的 projectId 之外的工程 id，windowId 也会被注入；
 * 库名里带 `/`、`:`、空白会污染排查与导出，统一压成 `_`。
 *
 * ⚠️ 不复用 `src/assets/idb.ts` 的 `runtime:${randomId()}::` 命名：那是页面实例隔离、刷新即弃的缓存
 * （§9「不要复用」），语义完全不同。
 */

/** 活跃段库：一个窗口在一个工程下的活跃会话库 */
export function segmentDbName(windowId: string, scope: string): string {
  return `hanshu.agent.session.${safePart(windowId)}.${safePart(scope)}`
}

/** 归档段库：一个工程 scope 一个不可变归档库 */
export function archiveDbName(scope: string): string {
  return `hanshu.agent.archive.${safePart(scope)}`
}

/**
 * 活跃段撤销日志库（阶段 5，D3/D4）：按工程 scope 分区，同一浏览器同 scope 的窗口共用一个库；
 * 库内的 key 再按 windowId + segmentId 区分（`undoJournalKey`）。
 */
export function undoJournalDbName(scope: string): string {
  return `hanshu.agent.undo.${safePart(scope)}`
}

/** 只留 `[A-Za-z0-9._-]`；空串回退 `unknown`，否则库名会退化成 `hanshu.agent.archive.` 这种残缺形式 */
function safePart(part: string): string {
  const cleaned = part.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.length === 0 ? 'unknown' : cleaned
}
