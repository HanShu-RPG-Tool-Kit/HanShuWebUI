import {
  isLocaleKey,
  LOCALE_KEY_TEXT_RE,
} from '../i18n/textMap'
import { findSpanAt, parseTextSpans, type TextSpan } from '../monaco/textSpans'
import {
  BLOCK_END,
  COMMENT_LINE,
  SPEAKER_LINE,
  TRAILING_TERMINATOR,
  isStructuralLine,
  splitHsLines,
  type HsLine,
} from './hsSyntaxRules'

/**
 * `.hs` → `.hsc` 编译。
 *
 * 规则（与解析器共用 `hsSyntaxRules`，应用内帮助「.hs 语法说明」是权威）：
 * - **编译前强制全文解析**：用 `parseTextSpans` 的结果判断哪些是本地化文本，
 *   不依赖任何"正在编辑中"的增量状态；**不再二次成键**，正文里的键名原样保留。
 * - 含键名的语句必须**完整闭合**，形态跟随多行文本的标准规则：
 *   单行 `speaker:<键>//`，或多行块 `speaker:` + `<键>` + 独占一行的 `//`
 *   （成键只换正文、不收缩语句，所以多行块的键名就写在块里）。
 *   没闭合就抛 `HsCompileError`。
 * - 一个多行块**只能有一个键名**（键名必须在块的第一段正文里）：块里夹 `#` 注释会把
 *   正文切成多段，只有第一段能被紧凑化折成 `speaker:<键>`，其余段会掉成裸行 → 抛错。
 * - 键名前后的空格 / 制表符在编译时删掉。
 * - 不再生成 `.lines`：hash → 原文的映射已经被正文里的键名取代。
 */

/** 编译错误：含键名内容没闭合 / 一个多行块里摊了多个键名 */
export class HsCompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HsCompileError'
  }
}

/** `name.hs` → `name.hsc` */
export function hscAssetName(hsName: string): string {
  return hsName.replace(/\.hs$/i, '.hsc')
}

/**
 * 为 .hsc 去掉噪音：注释行、空行。
 * 不移动 `@` 注入点 —— 它们是后续内容的位置标记。
 */
export function stripHsComments(hsText: string): string {
  const nl = hsText.includes('\r\n') ? '\r\n' : '\n'
  const lines = hsText.split(/\r?\n/)
  const out: string[] = []

  for (const line of lines) {
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

  for (const line of raw) {
    if (BLOCK_END.test(line)) continue
    flat.push(line.replace(TRAILING_TERMINATOR, ''))
  }

  const out: string[] = []
  for (let i = 0; i < flat.length; i++) {
    const line = flat[i]!

    const open = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/.exec(line)
    if (open) {
      const next = flat[i + 1]
      if (next !== undefined && !isStructuralLine(next)) {
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
function isKeyedSpan(span: TextSpan): boolean {
  return isLocaleKey(span.value)
}

/** 这一行是「多行块的开块行」吗（顶格 `speaker:` + 空正文） */
function isBlockOpenLine(text: string): boolean {
  const m = SPEAKER_LINE.exec(text)
  return m != null && m[2]!.trim() === ''
}

/**
 * 多行块里，`span` 之前（同一块内）是否已经有正文行。
 * 往上走：空行 / `#` 注释跳过，撞到开块行就是"没有" —— 撞到别的行说明
 * 正文被 `#` 注释切成了好几段。
 */
function hasBodyBefore(lines: HsLine[], span: TextSpan): boolean {
  for (let i = span.line - 2; i >= 0; i--) {
    const text = lines[i]!.text
    if (!text.trim() || COMMENT_LINE.test(text)) continue
    return !isBlockOpenLine(text)
  }
  return false
}

/**
 * 校验含键名内容，并把键名前后的空格 / 制表符删掉。
 *
 * 硬性要求只有一条：**正文里出现的每个键名都必须落在某个已闭合的片段内**。
 * 闭合形态与解析器完全一致：单行 `speaker:<键>//`，或多行块
 * `speaker:` + `<键>` + 独占一行的 `//` —— 多行块里的键名是正常写法，
 * 不再要求 `//` 与键名同一行行末。
 *
 * 另外守住「**一个块只能有一个键**」：块里夹 `#` 注释会把正文切成好几段
 * （每段各成一个片段、各拿一个键），而紧凑化只能把 `speaker:` 后的**第一段**
 * 折成 `speaker:<键>`，多出来的段落会掉成没有语句归属的裸键名 —— 机器按行走，
 * 那几行没人执行、正文永远不显示。这种形状必须报错，不能让坏 `.hsc` 静默出厂。
 *
 * 注释行、`@` 行与信号行不算正文，不参与校验。
 * `#stopparse` 是**仅解析**的控制指令（编辑器自动成键 / `parse_hs`），对编译无效：
 * 它之后照样按键名校验、该报错还是报错。
 */
function normalizeKeyedContent(hsText: string): string {
  const spans = parseTextSpans(hsText)
  const keyed = spans.filter(isKeyedSpan)
  const lines = splitHsLines(hsText)

  // 1) 正文里的键名必须都在片段内（单行 / 多行块的两条闭合路径共用这一条）
  const scan = new RegExp(LOCALE_KEY_TEXT_RE.source, 'gi')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (COMMENT_LINE.test(line.text) || line.text.startsWith('@')) continue
    if (!line.text.trim()) continue

    scan.lastIndex = 0
    for (let m = scan.exec(line.text); m; m = scan.exec(line.text)) {
      const span = findSpanAt(spans, line.start + m.index)
      if (!span || !isKeyedSpan(span)) {
        throw new HsCompileError(
          `第 ${i + 1} 行：键名必须写在闭合的语句里（\`speaker:<键>//\`，或多行块 \`speaker:\` + \`<键>\` + 独占一行的 \`//\`）`,
        )
      }
    }
  }

  // 2) 一个多行块只能有一个键名：键名必须落在块的**第一段正文**里。
  //    块里夹 `#` 注释会把正文切成多段（`narrator:` / 正文 / `# 注释` / 正文 / `//`），
  //    每段各成一个片段、各拿一个键，而紧凑化只折第一段 —— 后面的键名会掉成裸行。
  //    注意：键名前面只有空行 / 注释是正常的（`narrator:` / `# 场景` / `<键>` / `//`）。
  for (const span of keyed) {
    if (span.kind !== 'dialogue' || span.terminator != null) continue
    if (!hasBodyBefore(lines, span)) continue
    throw new HsCompileError(
      `第 ${span.line} 行：一个多行对白块只能有一个键名 —— 块里的 \`#\` 注释把正文切成了好几段，紧凑化只折第一段，后面的段落会掉成没有语句归属的裸键名。请把它拆成两条 \`speaker:\` 语句，或去掉块里的注释`,
    )
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
