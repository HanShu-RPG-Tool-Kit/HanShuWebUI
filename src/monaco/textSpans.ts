/**
 * `//` 行终结符作用的「可本地化文本」解析。
 *
 * 粒度（与用户确认的规则一致）：
 * - 对白按块整段：`speaker:正文//` 取冒号后的正文；`speaker:` 开头、单独一行 `//` 结束的
 *   多行块取块体整段（跨行算一个片段；块内若夹了 `#` / `@` 行，则按夹断切成多段）。
 * - 选项拆两个键：`-文案:回复//` 的文案与回复各算一个片段；`---只有文案//` 只算文案。
 * - 不是可本地化文本的不算：`:>>jump//`、系统返回 `--<` / `--<<`、空回复。
 * - `#` 注释行（**行首**才算，可含前导空白，与编译去噪一致）、`@` 注入点、
 *   行首信号（`?` / `!` / `!:` / `:!`）一律跳过。
 *
 * 每个片段还记录「紧随其后、同一行上的 `//`」（`terminator`），渲染时要把这个 `//`
 * 挪到覆盖框外的右下角，避免它落进多行框里面。
 */

import {
  BLOCK_END,
  CHOICE_LINE,
  SPEAKER_LINE,
  TRAILING_TERMINATOR,
  isChoiceJumpReply,
  isDialogueBreakLine,
  isSkippedHsLine,
  matchSystemReturnChoice,
  splitHsLines,
  unescapeHsText,
  type HsLine,
} from '../hanshu/hsSyntaxRules'

export type TextSpanKind = 'dialogue' | 'choice-label' | 'choice-reply'

/** `//` 终结符的绝对范围 */
export type TextTerminator = {
  start: number
  end: number
}

export type TextSpan = {
  kind: TextSpanKind
  /** 绝对 offset（含） */
  start: number
  /** 绝对 offset（不含） */
  end: number
  /** 源文件里的原始文本（含转义） */
  raw: string
  /** 本地化值文本（已反转义，换行统一为 \n） */
  value: string
  /** 1-based 起始行号 */
  line: number
  /** 1-based 结束行号（多行块会大于起始行号） */
  endLine: number
  /**
   * 紧随其后、同一行上的 `//`（中间只有空白）才记在这里。
   * 多行块的 `//` 独占一行、选项文案后面的 `//` 不属于自己 → null。
   * 拥有终结符时，渲染会把 `//` 挪到框外右下角。
   */
  terminator: TextTerminator | null
}

/** 第一个未转义的 `:` */
function findChoiceColon(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++
      continue
    }
    if (body[i] === ':') return i
  }
  return -1
}

type SpanInput = {
  kind: TextSpanKind
  start: number
  end: number
  fromLine: number
  toLine: number
  terminator?: TextTerminator | null
  /**
   * 允许"空值片段"：`test://` 这种**已终结但正文为空**的语句也要成键，
   * 否则它永远拿不到键。选项的空回复仍然不算（"空回复"明确排除）。
   */
  allowEmpty?: boolean
}

function makeSpan(source: string, input: SpanInput): TextSpan | null {
  const { start, end } = input
  const raw = source.slice(start, end)
  const value = unescapeHsText(raw.replace(/\r\n/g, '\n'))
  // 空片段只在 allowEmpty（已终结的空体，如 `test:` + 独占一行的 `//`）时合法
  if (!input.allowEmpty && (end <= start || !raw.trim() || !value.trim())) {
    return null
  }
  return {
    kind: input.kind,
    start,
    end,
    raw,
    value,
    line: input.fromLine,
    endLine: input.toLine,
    terminator: input.terminator ?? null,
  }
}

/** 去掉前后空白后的 [start, end) */
function trimmedRange(
  base: number,
  text: string,
): { start: number; end: number } {
  const lead = text.length - text.trimStart().length
  const tail = text.trimEnd().length
  return { start: base + lead, end: base + tail }
}

/**
 * 解析整份文本里的可本地化片段（按出现顺序）。
 * 渲染与自动成键都走这里，保证「识别」与「替换」用的是同一套规则。
 */
export function parseTextSpans(source: string): TextSpan[] {
  const lines = splitHsLines(source)
  const spans: TextSpan[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (isSkippedHsLine(line.text)) {
      i++
      continue
    }

    // —— 对白 ——
    const speaker = SPEAKER_LINE.exec(line.text)
    if (speaker) {
      const rest = speaker[2]
      const restStart = line.start + speaker[1].length + 1

      if (/^\s*$/.test(rest)) {
        // 多行块：`name:` 独占一行，正文若干行，由**独占一行**的 `//` 收尾
        // （帮助「.hs 语法说明」§1）。正文行尾缀 `//` 不算收尾 → 这样的块不成键，
        // 由诊断在同一行给出"这里该换行"的提示。
        // 结构行（选项 / 新对白）只是"这个块到此为止"的边界：`//` 会向前绑定到离它
        // 最近的结构标识，所以 `test:` 后面直接跟 `-msg:<<msg//` 时，那个 `//` 属于
        // 选项行，属于 `test:` 的正文根本不存在。
        const speakerLine = i + 1
        i++
        const bodyLines: HsLine[] = []
        const bodyIndexes: number[] = []
        /** 是否见到**单独一行**的 `//` —— 没有它就不成键 */
        let ended = false
        while (i < lines.length) {
          const bodyLine = lines[i]
          if (BLOCK_END.test(bodyLine.text)) {
            ended = true
            i++
            break
          }
          // 行级语句（选项 / 新对白 / `@` / 信号）不属于块正文 → 结束这个块
          if (isDialogueBreakLine(bodyLine.text)) {
            break
          }
          bodyLines.push(bodyLine)
          bodyIndexes.push(i)
          i++
        }
        // 没有 `//` → 永久不成键
        if (!ended) continue

        // 按 `#` / `@` 行切段（空行不切）
        const runs: Array<{ from: number; to: number }> = []
        let current: { from: number; to: number } | null = null
        let broken = false
        bodyLines.forEach((bodyLine, idx) => {
          if (!bodyLine.text.trim()) return
          if (isSkippedHsLine(bodyLine.text)) {
            broken = true
            return
          }
          if (!current) {
            current = { from: idx, to: idx }
          } else if (broken) {
            runs.push(current)
            current = { from: idx, to: idx }
          } else {
            current.to = idx
          }
          broken = false
        })
        if (current) runs.push(current)

        // 成键是**就地替换正文**：多行块成键后仍是多行块（`name:` / 键名 / `//` 各占一行），
        // 不收缩成单行 —— 收缩等于替作者重排版面，也和 `parse_hs` 的就地替换行为不一致。
        for (const run of runs) {
          const first = bodyLines[run.from]
          const last = bodyLines[run.to]
          // 正文到该段最后一行的行尾（去掉尾部空白）为止。
          // 多行块的收尾 `//` 独占一行、不属于任何片段，所以这里没有终结符。
          const end = last.start + last.text.trimEnd().length
          const span = makeSpan(source, {
            kind: 'dialogue',
            start: first.start + (first.text.length - first.text.trimStart().length),
            end,
            fromLine: bodyIndexes[run.from] + 1,
            toLine: bodyIndexes[run.to] + 1,
            terminator: null,
          })
          if (span) spans.push(span)
        }

        // 空体但已终结（`test:` + 独占一行的 `//`）：也要产出一个空片段，
        // 否则它永远成不了键；片段是零长度区间，成键时键名插在冒号之后，
        // 但**单独占一行**（见 `keyReplacementFor`），多行块的结构保持不变。
        // 没闭合的空体（`test:` 后面什么都没有）不产出片段：往里插键名等于
        // 把一个没闭合的语句交给编译器，成键反而制造出编译错误。
        if (ended && runs.length === 0) {
          const span = makeSpan(source, {
            kind: 'dialogue',
            start: restStart,
            end: restStart,
            fromLine: speakerLine,
            toLine: speakerLine,
            allowEmpty: true,
          })
          if (span) spans.push(span)
        }
        continue
      }

      const terminator = TRAILING_TERMINATOR.exec(rest)
      if (terminator) {
        const terminatorStart = restStart + terminator.index
        const contentEnd = terminatorStart
        const { start, end } = trimmedRange(
          restStart,
          source.slice(restStart, contentEnd),
        )
        const span = makeSpan(source, {
          kind: 'dialogue',
          start,
          end,
          fromLine: i + 1,
          toLine: i + 1,
          terminator: { start: terminatorStart, end: terminatorStart + 2 },
          // `test://`：已终结但正文为空 → 也要成键
          allowEmpty: true,
        })
        if (span) spans.push(span)
      }
      i++
      continue
    }

    // —— 选项 ——
    // 只认文档里的单行写法（`-文案:回复//` / `---只有文案//`）。
    // 多行选项树属于"未文档化的宽容"，已按决定删除：不再解析。
    // 系统返回：不进本地化
    if (matchSystemReturnChoice(line.text)) {
      i++
      continue
    }

    const choice = CHOICE_LINE.exec(line.text)
    if (choice) {
      const dashes = choice[1]
      const body = choice[2]
      const bodyStart = line.start + dashes.length
      // 惰性匹配到 `//` 为止，所以 body 末尾就是终结符位置
      const terminatorStart = bodyStart + body.length
      const colon = findChoiceColon(body)

      if (colon < 0) {
        const { start, end } = trimmedRange(bodyStart, body)
        const span = makeSpan(source, {
          kind: 'choice-label',
          start,
          end,
          fromLine: i + 1,
          toLine: i + 1,
          terminator: { start: terminatorStart, end: terminatorStart + 2 },
        })
        if (span) spans.push(span)
      } else {
        const labelRaw = body.slice(0, colon)
        const { start: labelStart, end: labelEnd } = trimmedRange(
          bodyStart,
          labelRaw,
        )
        const label = makeSpan(source, {
          kind: 'choice-label',
          start: labelStart,
          end: labelEnd,
          fromLine: i + 1,
          toLine: i + 1,
          // 文案与 `//` 之间还隔着回复，不算拥有终结符
          terminator: null,
        })
        if (label) spans.push(label)

        const reply = body.slice(colon + 1)
        const replyStart = bodyStart + colon + 1
        if (!isChoiceJumpReply(reply)) {
          const isRewind = /^\s*<</.test(reply)
          const replyText = isRewind ? reply.replace(/^\s*<</, '') : reply
          const replyOffset = isRewind
            ? replyStart + (reply.length - replyText.length)
            : replyStart
          const { start, end } = trimmedRange(replyOffset, replyText)
          const span = makeSpan(source, {
            kind: 'choice-reply',
            start,
            end,
            fromLine: i + 1,
            toLine: i + 1,
            terminator: { start: terminatorStart, end: terminatorStart + 2 },
          })
          if (span) spans.push(span)
        }
      }
      i++
      continue
    }

    i++
  }

  return spans.sort((a, b) => a.start - b.start)
}

/** 找出覆盖该 offset 的片段（含起点、不含终点）；没有返回 null */
export function findSpanAt(spans: TextSpan[], offset: number): TextSpan | null {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return span
  }
  return null
}
