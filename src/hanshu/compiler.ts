import {
  isLocaleKey,
  LOCALE_KEY_TEXT_RE,
} from '../i18n/textMap'
import { findSpanAt, parseLangSpans, type LangSpan } from '../monaco/textSpans'
import {
  BLOCK_END,
  COMMENT_LINE,
  DEFINE_LINE,
  TRAILING_TERMINATOR,
  countEmbedDelimiters,
  isStructuralLine,
  splitHsLines,
} from './hsSyntaxRules'

/**
 * `.hs` → `.hsc` 编译。
 *
 * 规则（与解析器共用 `hsSyntaxRules`，docs/hanshu-syntax.md 是权威）：
 * - **编译前强制全文解析**：用 `parseLangSpans` 的结果判断哪些是本地化文本，
 *   不依赖任何"正在编辑中"的增量状态；**不再二次成键**，正文里的键名原样保留。
 * - 含键名的语句必须在**一行内闭合**（`speaker:abcd1234//`、`-msg:msg//`，闭合符在
 *   行末）；不满足就抛 `HsCompileError` —— 键名还摊在块里时不允许出包。
 * - 键名前后的空格 / 制表符在编译时删掉。
 * - 不再生成 `.lines`：hash → 原文的映射已经被正文里的键名取代。
 */

/** 编译错误：含键名内容没写成"单行 + 行末闭合" */
export class HsCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HsCompileError'
  }
}

/** `name.hs` → `name.hsc` */
export function hscFileNameForHs(hsName: string): string {
  return hsName.replace(/\.hs$/i, '.hsc')
}

/**
 * 为 .hsc 去掉噪音：注释行、空行。
 * 保留顶格 `#define`；不碰 `''''…''''` 内 Python（含其中空行）。
 * 不移动 `@` 注入点 —— 它们是后续内容的位置标记。
 */
export function stripHsComments(hsText: string): string {
  const nl = hsText.includes('\r\n') ? '\r\n' : '\n'
  const lines = hsText.split(/\r?\n/)
  const out: string[] = []
  let inPython = false

  for (const line of lines) {
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      out.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      out.push(line)
      continue
    }

    // 顶格 #define 留给引擎展开；其余 # 行为注释
    if (DEFINE_LINE.test(line)) {
      out.push(line)
      continue
    }
    if (COMMENT_LINE.test(line)) continue
    if (!line.trim()) continue

    out.push(line)
  }

  return out.join(nl)
}

/**
 * 紧凑化（仅 .hsc）：
 * - 去掉块结束符 `//`（含独占一行的）
 * - 把 `speaker:\nbody` 收成 `speaker:body`
 * 语句之间的换行保留（行首 `-` / `@` / `@@` / speaker 仍靠换行分界）。
 */
export function minifyHsForHsc(hsText: string): string {
  const nl = hsText.includes('\r\n') ? '\r\n' : '\n'
  const raw = hsText.split(/\r?\n/)
  const flat: string[] = []
  let inPython = false

  for (const line of raw) {
    const toggles = countEmbedDelimiters(line)
    if (inPython) {
      flat.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      flat.push(line)
      continue
    }

    if (BLOCK_END.test(line)) continue
    flat.push(line.replace(TRAILING_TERMINATOR, ''))
  }

  const out: string[] = []
  inPython = false
  for (let i = 0; i < flat.length; i++) {
    const line = flat[i]!
    const toggles = countEmbedDelimiters(line)

    if (inPython) {
      out.push(line)
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      out.push(line)
      continue
    }

    const open = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/.exec(line)
    if (open) {
      const next = flat[i + 1]
      if (
        next !== undefined &&
        !isStructuralLine(next) &&
        countEmbedDelimiters(next) % 2 === 0
      ) {
        out.push(`${open[1]}:${next}`)
        i++
        continue
      }
    }

    out.push(line)
  }

  return out.join(nl)
}

/** 该片段是不是"已经成键"的本地化文本 */
function isKeyedSpan(span: LangSpan): boolean {
  return isLocaleKey(span.value)
}

/**
 * 校验含键名内容，并把键名前后的空格 / 制表符删掉。
 *
 * 两条硬性要求（对应"每行完整且闭合"）：
 * 1. 键名所在的独白必须是**单行写法**（`speaker:<键>//`，`//` 在同一行行末）；
 *    多行块里摊着一个键名 → 抛错。
 * 2. 正文行里出现的键名必须落在某个已闭合的片段内 → 否则说明它是"没闭合的含键名内容"。
 *
 * 注释行、`#define`、`@` 行与 Python 块内不算正文，不参与校验。
 */
function normalizeKeyedContent(hsText: string): string {
  const spans = parseLangSpans(hsText)
  const keyed = spans.filter(isKeyedSpan)

  // 1) 键名必须收进单行
  for (const span of keyed) {
    // 选项行由 `CHOICE_LINE` 保证单行且行末闭合，不用额外检查
    if (span.kind !== 'dialogue') continue
    if (span.terminator == null) {
      throw new HsCompileError(
        `第 ${span.line} 行：含键名的独白必须写成单行的 \`speaker:<键>//\`（闭合符在行末）`,
      )
    }
  }

  // 2) 正文里的键名必须都在片段内
  const scan = new RegExp(LOCALE_KEY_TEXT_RE.source, 'gi')
  const lines = splitHsLines(hsText)
  let inPython = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const toggles = countEmbedDelimiters(line.text)
    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      continue
    }
    if (COMMENT_LINE.test(line.text) || line.text.startsWith('@')) continue
    if (!line.text.trim()) continue

    scan.lastIndex = 0
    for (let m = scan.exec(line.text); m; m = scan.exec(line.text)) {
      const span = findSpanAt(spans, line.start + m.index)
      if (!span || !isKeyedSpan(span)) {
        throw new HsCompileError(
          `第 ${i + 1} 行：键名必须写在闭合的语句里（\`speaker:<键>//\` 或 \`-文案:回复//\`）`,
        )
      }
    }
  }

  // 3) 键名前后的空格 / 制表符：删掉（不会跨行）
  const drops: Array<{ start: number; end: number }> = []
  for (const span of keyed) {
    let start = span.start
    while (start > 0 && (hsText[start - 1] === ' ' || hsText[start - 1] === '\t')) {
      start--
    }
    let end = span.end
    while (end < hsText.length && (hsText[end] === ' ' || hsText[end] === '\t')) {
      end++
    }
    if (start < span.start) drops.push({ start, end: span.start })
    if (end > span.end) drops.push({ start: span.end, end })
  }
  if (drops.length === 0) return hsText

  drops.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const drop of drops) {
    if (drop.start < cursor) continue
    out += hsText.slice(cursor, drop.start)
    cursor = drop.end
  }
  return out + hsText.slice(cursor)
}

/**
 * 编译入口：`.hs` → `.hsc`。
 * 先全文解析并校验含键名内容（不满足抛 `HsCompileError`），再去噪、去 `//`、收紧。
 */
export function compileHsToHsc(hsText: string): string {
  return minifyHsForHsc(stripHsComments(normalizeKeyedContent(hsText)))
}
