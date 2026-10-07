import {
  BLOCK_END,
  CHOICE_LINE,
  SPEAKER_LINE,
  STATEMENT_BREAK_RE,
  TRAILING_TERMINATOR,
  isActionSignalLine,
  isChoiceAttachSignalLine,
  isDialogueBreakLine,
  isSkippedHsLine,
  matchInjectLine,
  matchSystemReturnChoice,
  splitHsLines,
  type HsLine,
} from '../hanshu/hsSyntaxRules'

/**
 * `.hs` 语法诊断（纯分析，不碰编辑器）。
 *
 * 只报结构性问题：
 *
 * | kind | 触发 | 波浪线锚点 | 叠加的虚线符号 |
 * |---|---|---|---|
 * | `missing-terminator`（单行） | 单行语句结尾没有 `//` | 行末 | 闭合符 `//` |
 * | `missing-terminator`（多行） | 多行块没有 `//` 收尾 | 最后一行行末 | 回车 + 闭合符 |
 * | `inline-terminator` | 多行块的 `//` 没有独占一行 | `//` 之前 | 回车 |
 * | `speaker-needs-newline` | 独白块是多行，但 `speaker:` 后面还跟着文本 | 冒号之后 | 回车 |
 * | `duplicate-sys-return` | 同级兄弟里重复的 `--<` 或 `--<<`（第二个起） | 行首 `-` 后 | 回车（占位提示） |
 * | `duplicate-inject` | 工作区内重复的 `@name`（本文件内第二次，或与其它 `.hs` 撞名） | 行首 `@` | 回车（占位提示） |
 *
 * 锚点是"波浪线画在这个 offset 之后"；波浪线离文本一个空格由渲染侧留白，
 * 虚线符号是半透明图形（`.hs-diag-*`，见 App.css）。
 */
export type HsDiagnosticKind =
  | 'missing-terminator'
  | 'inline-terminator'
  | 'speaker-needs-newline'
  | 'duplicate-sys-return'
  | 'duplicate-inject'

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
 * `@` / 信号等行级语句会结束这个块（与解析口径一致）。
 */
function scanCloser(lines: HsLine[], from: number): CloserScan {
  let lastBody = from - 1
  for (let j = from; j < lines.length; j++) {
    const line = lines[j]!
    if (BLOCK_END.test(line.text)) return { kind: 'closed', line: j }
    if (isDialogueBreakLine(line.text)) break
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
 * 选项深度：系统返回或普通 `-…` 行的 `-` 个数；否则 0。
 */
function choiceDepth(text: string): number {
  const sys = matchSystemReturnChoice(text)
  if (sys) return sys.depth
  const m = /^(-+)/.exec(text)
  return m && (CHOICE_LINE.test(text) || /^-/.test(text)) ? m[1]!.length : 0
}

/**
 * 同级兄弟里 `--<` / `--<<` 至多各一个。
 * 兄弟 = 同一父节点下、相同 depth 的选项行（跳过附件与注释）。
 * 从第二个重复项起报 `duplicate-sys-return`。
 */
function diagnoseDuplicateSysReturns(
  lines: HsLine[],
): HsDiagnostic[] {
  const out: HsDiagnostic[] = []
  /** 祖先栈：每层记录该层 depth 与「作为父」的行号 */
  const ancestors: Array<{ depth: number; line: number }> = []
  /**
   * 兄弟桶：key = `${parentLine}@${depth}`（顶层父为 -1）
   * value = 已见的 parent/root 系统返回锚点（第一个合法，其后为重复）
   */
  const buckets = new Map<
    string,
    { parent?: number; root?: number }
  >()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.text.trim()) {
      // 空行打断选项树 → 清空祖先（与树边界一致）
      ancestors.length = 0
      continue
    }
    if (isChoiceAttachSignalLine(line.text) || COMMENT_LINE_SOFT(line.text)) {
      continue
    }
    // 树打断：对白 / @ / ! 等 → 清空
    if (
      SPEAKER_LINE.test(line.text) ||
      line.text.startsWith('@') ||
      isActionSignalLine(line.text)
    ) {
      ancestors.length = 0
      continue
    }

    const depth = choiceDepth(line.text)
    if (depth <= 0) continue

    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1]!.depth >= depth
    ) {
      ancestors.pop()
    }
    const parentLine =
      ancestors.length > 0 ? ancestors[ancestors.length - 1]!.line : -1
    const key = `${parentLine}@${depth}`

    const sys = matchSystemReturnChoice(line.text)
    if (sys) {
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {}
        buckets.set(key, bucket)
      }
      const anchor = line.start + sys.dashes.length
      if (sys.kind === 'parent') {
        if (bucket.parent !== undefined) {
          out.push({
            kind: 'duplicate-sys-return',
            offset: anchor,
            multiline: false,
          })
        } else {
          bucket.parent = anchor
        }
      } else if (bucket.root !== undefined) {
        out.push({
          kind: 'duplicate-sys-return',
          offset: anchor,
          multiline: false,
        })
      } else {
        bucket.root = anchor
      }
    }

    ancestors.push({ depth, line: i })
  }

  return out
}

export type HsDiagnosticsOptions = {
  /**
   * 其它源文件已占用的注入点（小写名 → 占用方逻辑文件名）。
   * 与本文件撞名时，本文件该 `@name` 一律报 `duplicate-inject`。
   */
  foreignInjects?: ReadonlyMap<string, string>
}

/**
 * 注入点名字**工作区全局**唯一（跨 `.hs`；比较时大小写不敏感）。
 * 本文件内第二次起、或与 `foreignInjects` 撞名 → `duplicate-inject`（锚在行首 `@`）。
 */
function diagnoseDuplicateInjects(
  lines: HsLine[],
  foreignInjects?: ReadonlyMap<string, string>,
): HsDiagnostic[] {
  const seen = new Set<string>()
  const out: HsDiagnostic[] = []
  for (const line of lines) {
    const inj = matchInjectLine(line.text)
    if (!inj) continue
    const key = inj.name.toLowerCase()
    if (seen.has(key) || foreignInjects?.has(key)) {
      out.push({
        kind: 'duplicate-inject',
        offset: line.start,
        multiline: false,
      })
    } else {
      seen.add(key)
    }
  }
  return out
}

function COMMENT_LINE_SOFT(text: string): boolean {
  return /^\s*#/.test(text)
}

/**
 * 分析整份文本，返回按 offset 升序的诊断列表。
 * 注释行、`@` 行与信号行不参与对白/选项闭合诊断；系统返回 / 注入点重复另计。
 */
export function analyzeHsDiagnostics(
  source: string,
  options?: HsDiagnosticsOptions,
): HsDiagnostic[] {
  const lines = splitHsLines(source)
  const out: HsDiagnostic[] = []
  const missing = (offset: number, multiline: boolean): HsDiagnostic => ({
    kind: 'missing-terminator',
    offset,
    multiline,
  })

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!
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

    // —— 系统返回：须有行尾 `//`（与普通选项一致）——
    const sys = matchSystemReturnChoice(line.text)
    if (sys) {
      if (!TRAILING_TERMINATOR.test(line.text)) {
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

  out.push(...diagnoseDuplicateSysReturns(lines))
  out.push(...diagnoseDuplicateInjects(lines, options?.foreignInjects))
  return out.sort((a, b) => a.offset - b.offset)
}
