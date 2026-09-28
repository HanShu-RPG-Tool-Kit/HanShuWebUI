import {
  BLOCK_END,
  SPEAKER_LINE,
  STATEMENT_BREAK_RE,
  TRAILING_TERMINATOR,
  countEmbedDelimiters,
  isSkippedHsLine,
  splitHsLines,
  type HsLine,
} from '../hanshu/hsSyntaxRules'

/**
 * `.hs` 语法诊断（纯分析，不碰编辑器）。
 *
 * 只报"缺闭合符 / 闭合符位置不对"这一类**结构性**错误：
 *
 * | kind | 触发 | 波浪线锚点 | 叠加的虚线符号 |
 * |---|---|---|---|
 * | `missing-terminator`（单行） | 单行语句结尾没有 `//` | 行末 | 闭合符 `//` |
 * | `missing-terminator`（多行） | 多行块（只有独白；选项树是单行写法）没有 `//` 收尾 | 最后一行行末 | 回车 + 闭合符 |
 * | `inline-terminator` | 多行块的 `//` 没有独占一行 | `//` 之前 | 回车 |
 * | `speaker-needs-newline` | 独白块是多行，但 `speaker:` 后面还跟着文本 | 冒号之后 | 回车 |
 *
 * 锚点是"波浪线画在这个 offset 之后"；波浪线离文本一个空格由渲染侧留白，
 * 虚线符号是半透明图形（`.hs-diag-*`，见 App.css）。
 */
export type HsDiagnosticKind =
  | 'missing-terminator'
  | 'inline-terminator'
  | 'speaker-needs-newline'

export type HsDiagnostic = {
  kind: HsDiagnosticKind
  /** 波浪线锚点（文档 offset） */
  offset: number
  /** 多行情形：需要同时叠加"回车"提示 */
  multiline: boolean
}

/** 往后找收尾符的结果 */
type CloserScan =
  /** 找到独占一行的 `//`（行号） */
  | { kind: 'closed'; line: number }
  /** 先遇到行尾 `//`：它就是"该独占一行"的那个（绝对偏移） */
  | { kind: 'inline'; offset: number }
  /** 读到结构行 / 文件末尾都没收尾（最后一行正文的行号） */
  | { kind: 'open'; lastBody: number }

/**
 * 从 from 行开始往后找多行块的收尾符。
 * 文档 §1：收尾必须是**独占一行**的 `//`；正文行尾缀 `//` 只用来报"这里该换行"。
 * `@` 注入点是行级语句，会结束这个块（与解析口径一致）。
 */
function scanCloser(lines: HsLine[], from: number): CloserScan {
  let lastBody = from - 1
  for (let j = from; j < lines.length; j++) {
    const line = lines[j]!
    if (BLOCK_END.test(line.text)) return { kind: 'closed', line: j }
    if (STATEMENT_BREAK_RE.test(line.text) || line.text.startsWith('@')) break
    const inline = TRAILING_TERMINATOR.exec(line.text)
    if (inline) return { kind: 'inline', offset: line.start + inline.index }
    if (line.text.trim()) lastBody = j
  }
  return { kind: 'open', lastBody }
}

/** 行内去掉尾部空白后的结束偏移 */
function trimmedEnd(line: HsLine): number {
  return line.start + line.text.trimEnd().length
}

/**
 * 分析整份文本，返回按 offset 升序的诊断列表。
 * 注释行、`#define`、`@` 行与 `''''` Python 块内都不诊断（与解析口径一致）。
 */
export function analyzeHsDiagnostics(source: string): HsDiagnostic[] {
  const lines = splitHsLines(source)
  const out: HsDiagnostic[] = []
  const missing = (offset: number, multiline: boolean): HsDiagnostic => ({
    kind: 'missing-terminator',
    offset,
    multiline,
  })

  let inPython = false
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
    const toggles = countEmbedDelimiters(line.text)
    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      i++
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      i++
      continue
    }
    if (isSkippedHsLine(line.text) || !line.text.trim()) {
      i++
      continue
    }

    // —— 独白 ——
    const speaker = SPEAKER_LINE.exec(line.text)
    if (speaker) {
      const rest = speaker[2]
      if (/^\s*$/.test(rest)) {
        // `name:` 独占一行 → 多行块：收尾必须是独占一行的 `//`
        const scan = scanCloser(lines, i + 1)
        if (scan.kind === 'inline') {
          out.push({
            kind: 'inline-terminator',
            offset: scan.offset,
            multiline: true,
          })
          i++
        } else if (scan.kind === 'closed') {
          i = scan.line + 1
        } else {
          const endLine = Math.max(scan.lastBody, i)
          out.push(missing(trimmedEnd(lines[endLine]!), endLine > i))
          i = endLine + 1
        }
        continue
      }

      if (TRAILING_TERMINATOR.test(rest)) {
        // 单行写法 `name:正文//`
        i++
        continue
      }
      // `speaker:` 后面有文本，而后面还接着正文行 → 文档要求 `speaker:` 独占一行
      const next = lines[i + 1]
      const continues =
        next !== undefined &&
        Boolean(next.text.trim()) &&
        !STATEMENT_BREAK_RE.test(next.text) &&
        !BLOCK_END.test(next.text) &&
        !isSkippedHsLine(next.text)
      if (continues) {
        out.push({
          kind: 'speaker-needs-newline',
          offset: line.start + speaker[1].length + 1,
          multiline: true,
        })
      } else {
        out.push(missing(trimmedEnd(line), false))
      }
      i++
      continue
    }

    // —— 选项 ——
    // 文档只承认单行写法（`-文案:回复//` / `---只有文案//`）：没有行尾 `//` 就是缺闭合符。
    if (/^-+/.test(line.text)) {
      if (!TRAILING_TERMINATOR.test(line.text)) {
        out.push(missing(trimmedEnd(line), false))
      }
      i++
      continue
    }

    i++
  }

  return out.sort((a, b) => a.offset - b.offset)
}
