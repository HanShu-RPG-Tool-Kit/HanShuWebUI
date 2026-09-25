/**
 * `//` 行终结符作用的「可本地化文本」解析。
 *
 * 粒度（与用户确认的规则一致）：
 * - 对白按块整段：`speaker:正文//` 取冒号后的正文；`speaker:` 开头、单独一行 `//` 结束的
 *   多行块取块体整段（跨行算一个片段；块内若夹了 `#` / `@` 行，则按夹断切成多段）。
 * - 选项拆两个键：`-文案:回复//` 的文案与回复各算一个片段；`---只有文案//` 只算文案。
 * - 不是可本地化文本的不算：`:>>func//`、`:>jump//`、空回复。
 * - `#` 注释行、`@` 注入点、`''''…''''` Python 块内的内容一律跳过。
 *
 * 每个片段还记录「紧随其后、同一行上的 `//`」（`terminator`），渲染时要把这个 `//`
 * 挪到覆盖框外的右下角，避免它落进多行框里面。
 */

export type LangSpanKind = 'dialogue' | 'choice-label' | 'choice-reply'

/** `//` 终结符的绝对范围 */
export type LangTerminator = {
  start: number
  end: number
}

export type LangSpan = {
  kind: LangSpanKind
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
  terminator: LangTerminator | null
}

const SPEAKER_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/
const CHOICE_LINE = /^(-+)([\s\S]*?)\/\/\s*$/
const BLOCK_END = /^\/\/\s*$/
const TRAILING_TERMINATOR = /\/\/\s*$/

/** HS 转义还原（与 .lines 编译一致） */
export function unescapeHsText(text: string): string {
  return text
    .replace(/\\>>/g, '>>')
    .replace(/\\<</g, '<<')
    .replace(/\\-/g, '-')
}

function countEmbedDelimiters(line: string): number {
  let n = 0
  let i = 0
  while (i < line.length) {
    if (line.startsWith("''''", i)) {
      n++
      i += 4
    } else {
      i++
    }
  }
  return n
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

type Line = { text: string; start: number }

function splitLines(source: string): Line[] {
  const out: Line[] = []
  let start = 0
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === '\n') {
      let text = source.slice(start, i)
      if (text.endsWith('\r')) text = text.slice(0, -1)
      out.push({ text, start })
      start = i + 1
    }
  }
  return out
}

type SpanInput = {
  kind: LangSpanKind
  start: number
  end: number
  fromLine: number
  toLine: number
  terminator?: LangTerminator | null
}

function makeSpan(source: string, input: SpanInput): LangSpan | null {
  const { start, end } = input
  if (end <= start) return null
  const raw = source.slice(start, end)
  if (!raw.trim()) return null
  const value = unescapeHsText(raw.replace(/\r\n/g, '\n'))
  if (!value.trim()) return null
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
export function parseLangSpans(source: string): LangSpan[] {
  const lines = splitLines(source)
  const spans: LangSpan[] = []
  let inPython = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
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

    if (line.text.startsWith('#') || line.text.startsWith('@')) {
      i++
      continue
    }

    // —— 对白 ——
    const speaker = SPEAKER_LINE.exec(line.text)
    if (speaker) {
      const rest = speaker[2]
      const restStart = line.start + speaker[1].length + 1

      if (/^\s*$/.test(rest)) {
        // 多行块：从这一行往下吃到单独一行的 `//`
        i++
        const bodyLines: Line[] = []
        const bodyIndexes: number[] = []
        while (i < lines.length && !BLOCK_END.test(lines[i].text)) {
          const bodyLine = lines[i]
          const t = countEmbedDelimiters(bodyLine.text)
          if (t % 2 === 1) inPython = !inPython
          if (!inPython) {
            bodyLines.push(bodyLine)
            bodyIndexes.push(i)
          }
          i++
        }
        if (i < lines.length && BLOCK_END.test(lines[i].text)) i++

        // 按 `#` / `@` 行切段（空行不切）
        const runs: Array<{ from: number; to: number }> = []
        let current: { from: number; to: number } | null = null
        let broken = false
        bodyLines.forEach((bodyLine, idx) => {
          if (!bodyLine.text.trim()) return
          if (bodyLine.text.startsWith('#') || bodyLine.text.startsWith('@')) {
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

        for (const run of runs) {
          const first = bodyLines[run.from]
          const last = bodyLines[run.to]
          const span = makeSpan(source, {
            kind: 'dialogue',
            start: first.start + (first.text.length - first.text.trimStart().length),
            end: last.start + last.text.trimEnd().length,
            fromLine: bodyIndexes[run.from] + 1,
            toLine: bodyIndexes[run.to] + 1,
            // 多行块的 `//` 独占一行，不属于这个片段
            terminator: null,
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
        })
        if (span) spans.push(span)
      }
      i++
      continue
    }

    // —— 选项 ——
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
        const isCall = /^\s*>>/.test(reply)
        const isJump = /^\s*>[a-zA-Z_][a-zA-Z0-9_]*\s*$/.test(reply)
        if (!isCall && !isJump) {
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
export function findSpanAt(spans: LangSpan[], offset: number): LangSpan | null {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return span
  }
  return null
}
