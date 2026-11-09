/**
 * 源文件里的**本地化键位**扫描。
 *
 * 判定与编辑器完全同源：键是某个可本地化槽位的**整段内容**，例如
 * `narrator:7f3a91c2//`、`-0b41d5ee:a7c3e812//`、`--c1d2e3f4//` 里的 8 位十六进制，
 * 以及多行块里**单独占一行**的键名（`narrator:` / `7f3a91c2` / `//`）。
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

/** 形似键但格式不对的正文片段（P10：大写 / 长度不对的十六进制） */
export type SuspectKeySpan = {
  /** 1-based 行号 */
  line: number
  /** 片段文本（已 trim） */
  text: string
  /** 英文原因（agent lint 之外的调用方可直接用） */
  reason: string
}

/** 严格合法键：8 位小写十六进制（与 agentOps.LANG_KEY_PATTERN 同口径） */
const STRICT_KEY = /^[0-9a-f]{8}$/
/** 形似键：6–10 位十六进制（任意大小写） */
const HEX_LIKE = /^[0-9a-fA-F]{6,10}$/
const HAS_UPPER_HEX = /[A-F]/

/**
 * 扫描「形似键但格式不对」的可本地化文本片段（P10）。
 *
 * 典型误写：`narrator:7F3A91C2//`（大写）、`narrator:7F3A91C//`（长度不对）。
 * 只认**整段可本地化文本**，因此纯小写数字台词（`narrator:123456//`）不会误报；
 * `#stopparse` 之后不参与本地化，那里也不检查。
 */
export function suspectKeySpans(source: string): SuspectKeySpan[] {
  const stopLine = stopParseLineOf(source)
  const out: SuspectKeySpan[] = []
  const seen = new Set<string>()
  for (const span of parseTextSpans(source)) {
    if (stopLine != null && span.endLine >= stopLine) continue
    const text = span.value.trim()
    if (!text || STRICT_KEY.test(text)) continue
    let reason = ''
    if (/^[0-9a-fA-F]{8}$/.test(text)) {
      reason = '8 hex digits but not lowercase'
    } else if (HEX_LIKE.test(text) && HAS_UPPER_HEX.test(text)) {
      reason = 'hex-looking text but not an 8-digit lowercase key'
    }
    if (!reason) continue
    const id = `${span.line}:${text}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ line: span.line, text, reason })
  }
  return out
}

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
