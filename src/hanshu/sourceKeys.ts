/**
 * 源文件里的**本地化键位**扫描。
 *
 * 判定与编辑器完全同源：键是某个可本地化槽位的**整段内容**，例如
 * `narrator:7f3a91c2//`、`-0b41d5ee:a7c3e812//`、`--c1d2e3f4//` 里的 8 位十六进制。
 *
 * 因此这里复用 `parseTextSpans`，**不要**自己按行猜键的位置 ——
 * 早先按行猜的写法（要求键紧跟 `//` 且在行末）会因为真实写法是 `speaker:键//`
 * 而一条都认不出来，导致 agent 的 list_lang_keys / write_lang 全部报「没有任何键」。
 */

import { normalizeLocaleKey } from '../i18n/textMap'
import { parseCharTextSpans } from '../monaco/charTextSpans'
import { parseTextSpans, type TextSpan } from '../monaco/textSpans'
import { getExtension } from '../workspace'
import { stopParseLineOf } from './directives'

export type SourceKeyEntry = { key: string; line: number }

function spansForSource(source: string, sourceName?: string): TextSpan[] {
  if (sourceName && getExtension(sourceName) === '.char') {
    return parseCharTextSpans(source)
  }
  return parseTextSpans(source)
}

/**
 * 源文件里出现的键（按出现顺序，重复只留首次）。
 * `#stopparse` 之后不参与本地化，那里的键一律不计入。
 * @param sourceName 可选；`.char` 时走角色卡解析。
 */
export function collectSourceKeys(
  source: string,
  sourceName?: string,
): SourceKeyEntry[] {
  const stopLine = stopParseLineOf(source)
  const out: SourceKeyEntry[] = []
  const seen = new Set<string>()
  for (const span of spansForSource(source, sourceName)) {
    if (stopLine != null && span.endLine >= stopLine) continue
    const key = normalizeLocaleKey(span.value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ key, line: span.line })
  }
  return out
}
