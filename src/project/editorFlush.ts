/**
 * 工程级操作（导出 / 发版）前，把各工作区未落会话的编辑缓冲冲进 `projectSession`。
 * 工作区自行 register；App / 导出动作只调 `flushProjectEditors`。
 */

const flushers = new Set<() => void>()

export function registerProjectEditorFlush(fn: () => void): () => void {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}

/** 同步冲刷；调用方随即读 `getProjectSession().workspace` */
export function flushProjectEditors(): void {
  for (const flush of flushers) flush()
}
