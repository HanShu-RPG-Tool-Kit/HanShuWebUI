/**
 * `.hs` 的**指令行**：顶格 `#` 开头，语义上改变编辑器行为（与 C 的预处理指令同类）。
 * 与注释的差别：注释只是文本；指令会被 `stripHsComments` 当成注释丢掉，不进 `.hsc`。
 */

/** 自动成键的终止指令：本行**及其后**的所有文本都不再自动成键 */
export const STOP_PARSE_DIRECTIVE = '#stopparse'

/**
 * `#stopparse` 出现的行号（1 起）；没有则返回 null。
 * 顶格才算指令（与 `#define` 一致），允许行尾空白；行内 `#` 不算。
 */
export function stopParseLineOf(source: string): number | null {
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === STOP_PARSE_DIRECTIVE) return i + 1
  }
  return null
}

/** 该 1-based 行号是否落在 `#stopparse` 之后（含指令行本身） */
export function isAfterStopParse(source: string, line: number): boolean {
  const stopLine = stopParseLineOf(source)
  return stopLine != null && line >= stopLine
}
