import {
  CHAR_COMMENT_LINE,
  CHAR_ENTRY_LINE,
} from '../char/charSyntax'
import { splitHsLines } from '../hanshu/hsSyntaxRules'

export type CharDiagnostic = {
  kind: 'invalid-char-line' | 'missing-terminator'
  offset: number
}

/**
 * `.char` 诊断：非注释行必须是完整的 `key:msg//`。
 * `key:msg` 缺 `//` → missing-terminator；其它形态 → invalid-char-line。
 */
export function analyzeCharDiagnostics(source: string): CharDiagnostic[] {
  const lines = splitHsLines(source)
  const out: CharDiagnostic[] = []

  for (const line of lines) {
    if (!line.text.trim() || CHAR_COMMENT_LINE.test(line.text)) continue
    if (CHAR_ENTRY_LINE.test(line.text)) continue

    const looksLike =
      /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line.text) &&
      !/\/\/\s*$/.test(line.text)
    if (looksLike) {
      out.push({
        kind: 'missing-terminator',
        offset: line.start + line.text.trimEnd().length,
      })
    } else {
      out.push({ kind: 'invalid-char-line', offset: line.start })
    }
  }

  return out
}
