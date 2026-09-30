/**
 * 长文本切分 —— 规范里"文本切分不落盘,适配器按协议已知上限"的落地。
 *
 * 切点必须落在**句末**。在句子中间切开,拼接处会多出一个不自然的停顿或语调断裂,
 * 而这是听感上最刺耳的一类瑕疵 —— 剧本是一句一句念的,不是一段一段截的。
 * 所以顺序是:句子 → 从句 → 硬切(只在单句本身超过上限时才用)。
 *
 * 上限**只填有文档依据的**(见 `spec.ts` 的 `requestCharLimit`):没有已知上限就不切。
 * 补一个猜的数会让长文本在某一段突然失败,而少切一次是零代价的。
 */

export type TextChunk = {
  text: string
  /** 在原文本里的起始下标 —— 出问题时能指回是哪一段 */
  start: number
}

/** 句末:中英文句号问号叹号、省略号,以及换行 */
const SENTENCE_END = /[。！？!?…]+["'”’）)】」』]*|\n+/g

/** 从句末:停顿比句号弱,只在句子超限时才拿来当退路 */
const CLAUSE_END = /[，,、；;：:]+["'”’）)】」』]*/g

function splitKeepingEnds(
  text: string,
  pattern: RegExp,
): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  const re = new RegExp(pattern.source, pattern.flags)
  let start = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const end = match.index + match[0].length
    const piece = text.slice(start, end)
    if (piece) out.push({ text: piece, start })
    start = end
  }
  const tail = text.slice(start)
  if (tail) out.push({ text: tail, start })
  return out
}

/** 贪心装箱：把片段按顺序塞进不超过 `limit` 的桶 */
function pack(
  pieces: readonly { text: string; start: number }[],
  limit: number,
  offset: number,
): TextChunk[] {
  const chunks: TextChunk[] = []
  let buffer = ''
  let bufferStart = 0

  for (const piece of pieces) {
    if (piece.text.length > limit) {
      if (buffer) {
        chunks.push({ text: buffer, start: offset + bufferStart })
        buffer = ''
      }
      chunks.push(...forcedSplit(piece.text, offset + piece.start, limit))
      continue
    }
    if (buffer.length + piece.text.length > limit) {
      chunks.push({ text: buffer, start: offset + bufferStart })
      buffer = piece.text
      bufferStart = piece.start
      continue
    }
    if (!buffer) bufferStart = piece.start
    buffer += piece.text
  }

  if (buffer) chunks.push({ text: buffer, start: offset + bufferStart })
  return chunks
}

/** 单句就超限：先在从句处切，从句还超限才按长度硬切 */
function forcedSplit(text: string, offset: number, limit: number): TextChunk[] {
  const clauses = splitKeepingEnds(text, CLAUSE_END)
  if (clauses.length > 1) {
    return pack(clauses, limit, offset)
  }
  const out: TextChunk[] = []
  for (let i = 0; i < text.length; i += limit) {
    out.push({ text: text.slice(i, i + limit), start: offset + i })
  }
  return out
}

/**
 * 把一段文本切成可以直接逐次送进合成的块。
 *
 * `limit` 省略或 ≤0 表示不切(该协议没有已知上限),此时原样返回一块 ——
 * **不切比切错好**,切分只是为了不撞上限,不是为了整齐。
 */
export function splitTextForSynthesis(text: string, limit?: number): TextChunk[] {
  if (!text) return []
  if (!limit || limit <= 0 || text.length <= limit) {
    return [{ text, start: 0 }]
  }
  return pack(splitKeepingEnds(text, SENTENCE_END), limit, 0)
}
