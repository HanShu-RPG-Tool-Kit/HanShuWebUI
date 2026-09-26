import { normalizeLocaleKey } from '../i18n/langTextMap'
import type { LangSpan } from './langTextSpans'

/**
 * 已成键文本（框）的纯规则：光标导航、删除保护、成键账目结算。
 *
 * 这里只做算术判断，不碰编辑器 / DOM / 映射，方便单测：
 * - 框的原子范围 = 被替换掉的那段正文（键名），`//` 不属于框
 * - 光标不允许停在框内部，整体跳到另一侧
 * - 删除只"蹭到"框的一部分时无响应，完整包含才算明确删除
 * - 撤销 / 重做时按"键名是否还在正文里"结算映射条目
 */

/** 文档里的 [start, end) 区间 */
export type TextRange = { start: number; end: number }

/** 光标移动方向：判断"从哪一侧进入框" */
export type CaretDir = 'left' | 'right'

/** 一次自动成键写进映射的条目（撤销时原样回收 / 重做时放回） */
export type MigrationRecord = { entries: Array<[string, string]> }

/**
 * 框的原子范围：只有被替换掉的那段正文（键名）。
 * `//` 是作者自己敲的语句记号、渲染上也在框外做尾标，不属于框，
 * 光标可以停在它与键名之间，也可以从它外侧删掉它。
 */
export function atomicRegion(span: Pick<LangSpan, 'start' | 'end'>): TextRange {
  return { start: span.start, end: span.end }
}

/** 已成键的框；未成键的原文不设防，用户照样能自由编辑 */
export function keyedRegions(spans: LangSpan[]): TextRange[] {
  const out: TextRange[] = []
  for (const span of spans) {
    if (!normalizeLocaleKey(span.value)) continue
    out.push(atomicRegion(span))
  }
  return out
}

/**
 * 一条语句占的行范围：正文行 + 它的 `//` 所在行。
 * 单独一行的 `//` 落在正文之后一行，也要算进来（否则光标停在 `//` 行上时会被成键）。
 * `nextLineText` 传正文末行的下一行内容；没有下一行时传 null。
 */
export function statementLineRange(
  span: Pick<LangSpan, 'line' | 'endLine' | 'terminator'>,
  nextLineText: string | null,
): { from: number; to: number } {
  if (span.terminator) return { from: span.line, to: span.endLine }
  if (nextLineText != null && /^\s*\/\/\s*$/.test(nextLineText)) {
    return { from: span.line, to: span.endLine + 1 }
  }
  return { from: span.line, to: span.endLine }
}

/** 光标落在某个框内部时该跳到哪一侧；不在框内返回 null */
export function snapTarget(
  regions: TextRange[],
  offset: number,
  dir: CaretDir,
): number | null {
  const region = regions.find((r) => offset > r.start && offset < r.end)
  if (!region) return null
  return dir === 'left' ? region.start : region.end
}

/** 空选区按方向展开成一次删除覆盖的范围（有选区时原样返回） */
export function deletionRange(range: TextRange, forward: boolean): TextRange {
  if (range.start !== range.end) return range
  return forward
    ? { start: range.start, end: range.end + 1 }
    : { start: range.start - 1, end: range.end }
}

/**
 * 删除是否"蹭到"某个框：与框重叠、但没有完整包含它。
 * 完整包含（例如选中整行）算明确的删除意图，放行。
 */
export function deletionHitsKey(
  regions: TextRange[],
  ranges: TextRange[],
): boolean {
  for (const range of ranges) {
    for (const region of regions) {
      const overlaps = range.start < region.end && range.end > region.start
      const covers = range.start <= region.start && range.end >= region.end
      if (overlaps && !covers) return true
    }
  }
  return false
}

/** 撤销：键名已不在正文里 → 这次成键被撤销，条目该回收 */
export function pickUndone(
  records: MigrationRecord[],
  text: string,
): { drop: MigrationRecord[]; keep: MigrationRecord[] } {
  const drop: MigrationRecord[] = []
  const keep: MigrationRecord[] = []
  for (const record of records) {
    if (record.entries.some(([key]) => text.includes(key))) keep.push(record)
    else drop.push(record)
  }
  return { drop, keep }
}

/** 重做：键名又都回到正文里 → 条目该放回 */
export function pickRedone(
  records: MigrationRecord[],
  text: string,
): { restore: MigrationRecord[]; keep: MigrationRecord[] } {
  const restore: MigrationRecord[] = []
  const keep: MigrationRecord[] = []
  for (const record of records) {
    if (record.entries.every(([key]) => text.includes(key))) restore.push(record)
    else keep.push(record)
  }
  return { restore, keep }
}
