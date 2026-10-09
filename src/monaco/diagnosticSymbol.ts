import type { CharDiagnostic } from './charDiagnostics'
import type { HsDiagnostic } from './hsDiagnostics'

/**
 * 诊断 → after-content 叠加符号的**唯一映射**（图形样式在 App.css 的 `.hs-diag-*`）。
 *
 * | 诊断 | 叠加符号 |
 * |---|---|
 * | `missing-terminator`（单行） | 闭合符 `//` |
 * | `missing-terminator`（多行） | 回车 + 闭合符 `//` |
 * | `inline-terminator` / `speaker-needs-newline` | 回车 `↵` |
 * | `duplicate-sys-return` / `duplicate-inject` | 冲突符（两个方框重叠 + 中央中空感叹号） |
 *
 * 「重复」既不是缺闭合符、也不是缺换行，所以**不能**沿用 `//`：
 * 画 `//` 等于让作者去补一个收尾符，而真正的问题是撞名。
 * 冲突图形本体见 `hs-diag-conflict.svg`（`hs-diag-conflict` 的 `::before` 背景图）。
 */
export type DiagnosticSymbolClass =
  | 'hs-diag-close'
  | 'hs-diag-enter'
  | 'hs-diag-enter-close'
  | 'hs-diag-conflict'

export function diagnosticSymbolClass(
  diag: HsDiagnostic | CharDiagnostic,
): DiagnosticSymbolClass {
  if (diag.kind === 'missing-terminator') {
    // `.char` 的 missing-terminator 不带 multiline：单行缺 `//` 只叠闭合符
    return 'multiline' in diag && diag.multiline
      ? 'hs-diag-enter-close'
      : 'hs-diag-close'
  }
  if (diag.kind === 'duplicate-sys-return' || diag.kind === 'duplicate-inject') {
    return 'hs-diag-conflict'
  }
  return 'hs-diag-enter'
}