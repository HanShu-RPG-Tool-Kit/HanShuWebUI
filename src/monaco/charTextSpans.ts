/**
 * `.char` 可本地化片段：仅 `key:msg//` 的冒号后正文。
 * 产出与 `parseTextSpans` 相同的 `TextSpan`，便于复用成键 / 覆盖层 / 录音棚。
 */

import {
  CHAR_COMMENT_LINE,
  CHAR_ENTRY_LINE,
} from '../char/charSyntax'
import { splitHsLines, unescapeHsText } from '../hanshu/hsSyntaxRules'
import type { TextSpan } from './textSpans'

export function parseCharTextSpans(source: string): TextSpan[] {
  const lines = splitHsLines(source)
  const spans: TextSpan[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.text.trim() || CHAR_COMMENT_LINE.test(line.text)) continue

    const m = CHAR_ENTRY_LINE.exec(line.text)
    if (!m) continue

    const keyPart = m[1]!
    const body = m[2]!
    const bodyStart = line.start + keyPart.length + 1
    const terminatorStart = bodyStart + body.length
    const lead = body.length - body.trimStart().length
    const trimEnd = body.trimEnd()
    const start = bodyStart + lead
    const end = bodyStart + trimEnd.length
    const raw = source.slice(start, end)
    const value = unescapeHsText(raw.replace(/\r\n/g, '\n'))

    spans.push({
      kind: 'dialogue',
      start,
      end,
      raw,
      value,
      line: i + 1,
      endLine: i + 1,
      terminator: { start: terminatorStart, end: terminatorStart + 2 },
    })
  }

  return spans
}
