import { normalizeLocaleKey } from '../i18n/textMap'
import type { TextSpan } from './textSpans'

/**
 * 已成键文本（框）的纯规则：光标导航、删除保护、成键账目结算。
 *
 * 这里只做算术判断，不碰编辑器 / DOM / 映射，方便单测：
 * - 框的原子范围 = 被替换掉的那段正文（键名），`//` 不属于框
 * - 光标**贴着框**（框内 / 两侧框沿）就算落到框上：外面那点位置由编辑框接管，
 *   从编辑框里往外挪时按 `exitCaretOffset` 预判到框外一步
 * - 光标不允许停在框内部（打不开编辑框时兜底），整体跳到另一侧
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
export function atomicRegion(span: Pick<TextSpan, 'start' | 'end'>): TextRange {
  return { start: span.start, end: span.end }
}

/** 已成键的框；未成键的原文不设防，用户照样能自由编辑 */
export function collectKeyedRegions(spans: TextSpan[]): TextRange[] {
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
  span: Pick<TextSpan, 'line' | 'endLine' | 'terminator'>,
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

/**
 * 光标"贴上"了哪个框 —— **含两侧框沿**，与 `snapTarget` 的严格内部判定刻意不同。
 *
 * 为什么要含框沿：框沿上的那个位置在视觉上就压在框边（框左沿 = 框里第一个字符之前，
 * 框右沿 = 最后一个字符之后），用户在正文里根本停不到"框里面"，
 * 只能停在框沿上 —— 所以框沿就是"要进编辑框"的信号。
 * `fraction` 是它在框里的比例（0 = 左沿，1 = 右沿），用来把文档列换算成编辑框里的横向位置。
 */
export function hitCaretBox(
  regions: TextRange[],
  offset: number,
): { region: TextRange; fraction: number } | null {
  for (const region of regions) {
    if (offset < region.start || offset > region.end) continue
    const length = region.end - region.start
    return {
      region,
      fraction: length > 0 ? (offset - region.start) / length : 0,
    }
  }
  return null
}

/**
 * 从编辑框里"再往外挪一步"的预判落点：左 = 框左沿再往左一个字符，右 = 框右沿再往右一个字符。
 *
 * 这一步是**必须**的：框沿本身是进框信号（见 `hitCaretBox`），
 * 出框若落回框沿，同一拍就会被重新吸进框里，用户永远挪不出编辑框。
 * 于是向外多跨一个字符 —— `test:KEY|//` 按左键出框落到 `tes|t:KEY//`，
 * 恰好就是"把光标从框里挪到框外的下一格"。
 * 调用方负责夹到 [0, 文档长度]。
 */
export function exitCaretOffset(region: TextRange, dir: CaretDir): number {
  return dir === 'left' ? region.start - 1 : region.end + 1
}

/** 文本里第 index 个插入位置所在的行号（0 起；`\n` 前算上一行） */
export function lineIndexOfOffset(text: string, index: number): number {
  const stop = Math.max(0, Math.min(index, text.length))
  let line = 0
  for (let i = 0; i < stop; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

/** 文本里第 line 行首的插入位置（越界夹到最后一行，与 `lineIndexOfOffset` 同界） */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 0) return 0
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    seen++
    if (seen === line) return i + 1
  }
  // 越界：夹到最后一行。文本末尾的 `\n` 之后还有个空行，所以是最后一个换行的下一格
  const lastNewline = text.lastIndexOf('\n')
  return lastNewline === -1 ? 0 : lastNewline + 1
}

/** 插入位置夹到 [0, length]（框沿再往外一步可能越界，越界就退回框沿） */
export function clampOffset(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length))
}

/**
 * 从编辑框向上 / 下出框时，Monaco 光标该预判到哪一行（1 起）。
 * 返回 null = 外面没有行了（框在文档首行还往上、在末行还往下），
 * 调用方要把这一按当无事发生、编辑框留着 —— 否则框会白关一次，光标却没动。
 * 多行值的中间行翻行归输入框自己，只有"首行向上 / 末行向下"会走到这里。
 */
export function exitLineFor(
  span: Pick<TextSpan, 'line' | 'endLine'>,
  direction: 'up' | 'down',
  lineCount: number,
): number | null {
  const line = direction === 'up' ? span.line - 1 : span.endLine + 1
  return line < 1 || line > lineCount ? null : line
}

/**
 * 一行里被渲染成"槽位"的东西（键名的框、尾标 `//`）。
 * `left` / `width` 一律相对**行首文字的左沿**（px），由调用方按真实矩形量好。
 */
export type LineSlot = {
  /** 槽位覆盖的文档范围（左闭右开）：键名是 8 位原文，尾标是那 2 个 `/` */
  start: number
  end: number
  /** 相对行首文字左沿的像素范围 */
  left: number
  width: number
}

/**
 * 一行文本里，横向像素 x 最靠近哪条字符边界（返回行内下标）。
 * 宽度一律用 `widthOf` 实测 —— 中文 / 等宽混排按"列数"算会错位。
 */
export function indexAtX(
  text: string,
  x: number,
  widthOf: (text: string) => number,
): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i <= text.length; i++) {
    const distance = Math.abs(widthOf(text.slice(0, i)) - x)
    if (distance >= bestDistance) continue
    bestDistance = distance
    best = i
  }
  return best
}

/**
 * 目标行上「横向像素 → 文档 offset」。
 *
 * 槽位这一套让原文的**列数**和屏幕上的**宽度**对不上了：键名那 8 个字符被渲染成
 * 一个宽度等于译文实测宽度的槽位，尾标 `//` 亦然。所以横向换算不能按"列号 × 字符宽"
 * 推（Monaco 在 GPU 渲染的行上正是走 `viewLinesGpu.getPositionAtCoordinate`，
 * 拿原文逐字累加宽度反推列号 —— 槽位那一段的落点就一路偏），
 * 只能：普通文字段用实测宽度累加，槽位段用它的真实矩形按比例折算回 offset。
 *
 * 落在槽位里按**比例**取：这条语句的原文整体是一个原子单位，落进哪一格就取哪一格
 * —— 于是"上下出去时刚好压在邻行的键名框上"能直接对上框内对应的字缝，
 * 且与 `caretIndexInBox`（offset → 框内位置的换算）互为逆运算，来回挪不会漂。
 *
 * @param lineStart 目标行第 1 列的绝对 offset
 * @param lineText  目标行的原文（不含换行）
 * @param x         横向像素，相对行首文字的左沿
 * @param slots     该行上的槽位（顺序随意，内部按像素排序）
 * @param widthOf   实测宽度（调用方接 DOM 量测器）
 */
export function offsetAtLineX(
  lineStart: number,
  lineText: string,
  x: number,
  slots: readonly LineSlot[],
  widthOf: (text: string) => number,
): number {
  const lineEnd = lineStart + lineText.length
  const ordered = [...slots].sort((a, b) => a.left - b.left)
  let cursor = lineStart
  let left = 0

  /** 走一段普通文本（框与框之间、行首行尾那些字）：命中就给出 offset */
  const walkPlain = (end: number): number | null => {
    if (end <= cursor) return null
    // 落在行首文字左边（例如点在行号 / 装订线那侧）就当行首
    if (x < left) return cursor
    const text = lineText.slice(cursor - lineStart, end - lineStart)
    const width = widthOf(text)
    if (x < left + width) return cursor + indexAtX(text, x - left, widthOf)
    left += width
    cursor = end
    return null
  }

  for (const slot of ordered) {
    const hit = walkPlain(slot.start)
    if (hit != null) return hit
    // 落在槽位左沿及左边：取槽位起点（零宽槽位就只有这一个落点）
    if (x <= slot.left) return slot.start
    if (slot.width > 0) {
      if (x <= slot.left + slot.width) {
        const span = slot.end - slot.start
        const fraction = (x - slot.left) / slot.width
        return slot.start + Math.max(0, Math.min(span, Math.round(fraction * span)))
      }
      // 以真实矩形为准重新对齐（普通段的累加宽度可能有测量误差）
      left = slot.left + slot.width
    }
    cursor = slot.end
  }
  return walkPlain(lineEnd) ?? lineEnd
}

/**
 * `offsetAtLineX` 的正向孪生：这一行上的文档 offset → 相对行首文字左沿的像素 x。
 *
 * 上下键的落点要用它：Monaco 的上下移动按**列号**走（GPU 渲染的行更是拿原文逐字
 * 累加宽度反推列），而键名那 8 个字符在屏幕上是一个宽度等于译文实测宽度的槽位 ——
 * 从上一行第 3 列按下来，光标落在隐藏键名的第 3 格 = **框宽的 3/8**，预判到的译文
 * 位置就被放大成好几个字，来回挪也回不来。所以纵向挪移前先取当前光标的**实测像素 x**，
 * 再用同一个 x 在目标行上找落点（见 `slotAtX`）。
 *
 * 尺子与 `offsetAtLineX` 完全同一把：普通文字段用 `widthOf` 累加，槽位段按真实矩形
 * 线性折算回像素，槽位之后再以真实矩形重新对齐 —— 两个方向互为逆运算，来回挪不漂。
 *
 * @param lineStart 本行第 1 列的绝对 offset
 * @param lineText  本行原文（不含换行）
 * @param offset    文档 offset（越界夹到本行首尾）
 * @param slots     本行上的槽位（顺序随意，内部按像素排序）
 * @param widthOf   实测宽度（调用方接 DOM 量测器）
 */
export function lineXForOffset(
  lineStart: number,
  lineText: string,
  offset: number,
  slots: readonly LineSlot[],
  widthOf: (text: string) => number,
): number {
  const lineEnd = lineStart + lineText.length
  const target = Math.max(lineStart, Math.min(offset, lineEnd))
  const ordered = [...slots].sort((a, b) => a.left - b.left)
  let cursor = lineStart
  let left = 0

  for (const slot of ordered) {
    if (target <= slot.start) break
    // 槽位之前的普通文字：从 cursor 累加到槽位左沿
    left += widthOf(lineText.slice(cursor - lineStart, slot.start - lineStart))
    cursor = slot.start
    if (target <= slot.end) {
      const span = slot.end - slot.start
      const fraction = span > 0 ? (target - slot.start) / span : 0
      return slot.left + fraction * slot.width
    }
    // 以真实矩形为准重新对齐（普通段的累加宽度可能有测量误差）
    left = slot.left + slot.width
    cursor = slot.end
  }
  return left + widthOf(lineText.slice(cursor - lineStart, target - lineStart))
}

/**
 * 横向像素 x 落在哪个槽位里；不在任何槽位里返回 null。
 * 左右都算"在槽位里"—— 框沿在视觉上就压在框边，与 `hitCaretBox` 含两侧框沿的口径一致
 * （量不到矩形的槽位在 `slotOf` 那层就被剔掉了，不会走到这里；零宽槽位只有恰好压在
 * 左沿上才算命中）。
 */
export function slotAtX(
  slots: readonly LineSlot[],
  x: number,
): LineSlot | null {
  for (const slot of slots) {
    if (x < slot.left || x > slot.left + slot.width) continue
    return slot
  }
  return null
}

/**
 * 纵向进入多行值的框时，落在这个框的第几个显示行（0 起）。
 *
 * 框的显示行从它的**首行**向下排（多行值靠 view zone 撑开，见 textEditor.render）：
 * - 从框**下面**上来（`fromBelow`，或目标行已经掉在框的末行之下）→ 末行
 * - 从框**上面**下来 / 就落在框首行上 → 首行
 * - 落在框自身的多行范围里（多行原文被折成键名的情形）→ 按行差取，夹在范围内
 *
 * 这条规则与 `exitLineFor` 正好互逆：从首行向上出框落到框首行的上一行，再按下来
 * 还是首行；从末行向下出框落到框末行的下一行，再按上来还是末行 —— 同一个位置的
 * 进和出用同一条行规则，用户报的"进出的行偏移量不对等、不可逆"就是这么消掉的。
 */
export function boxLineAt(
  span: Pick<TextSpan, 'line' | 'endLine'>,
  targetLine: number,
  displayLineCount: number,
  fromBelow = false,
): number {
  const last = Math.max(1, displayLineCount) - 1
  if (fromBelow || targetLine > span.endLine) return last
  if (targetLine < span.line) return 0
  return Math.max(0, Math.min(last, targetLine - span.line))
}

/**
 * 出框的实际落点 + 是否需要屏蔽"回吸"。
 * 框贴着文档头 / 尾时，"再往外一步"越界了 —— 外面没地方去，只能停在框沿，
 * 而框沿是进框信号：这一格必须屏蔽，否则出框的那一拍又被吞回编辑框里。
 */
export function exitCaretTarget(
  region: TextRange,
  dir: CaretDir,
  length: number,
): { offset: number; guard: boolean } {
  const raw = exitCaretOffset(region, dir)
  const offset = clampOffset(raw, length)
  return { offset, guard: offset !== raw }
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
export function isDeletionHittingKey(
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

/**
 * 成键时该把哪一段正文换成键名。
 *
 * 成键**只换正文、不动语句结构** —— 多行块成键后仍是多行块
 * （`name:` / 键名 / 独占一行的 `//` 各占一行），不再收缩成 `name:<键>//`：
 * 收缩等于替作者重排版面（注释、空行、光标位置一起被吞），
 * 也让「自动成键」与 Agent 的 `parse_hs`（一直是就地替换）行为不一致。
 *
 * 于是只有两种替换：
 * - 普通片段（含单行 `name:正文//`、多行块里**有正文**的那一段）：正文整体换成键名；
 * - 多行块的**空体**（`name:` + 空正文 + 独占一行 `//`，片段是零长度的）：
 *   正文里没有可替换的地方，键名必须单独占一行，所以从冒号后一路换到该行行末
 *   （顺带吃掉尾随空白），换成「换行 + 键名」。
 *
 * @param lineEndOf 该行行末（换行符前）的绝对 offset；只有空体分支会用到
 */
export function keyReplacementFor(
  span: Pick<TextSpan, 'kind' | 'start' | 'end' | 'terminator' | 'line'>,
  key: string,
  eol: string,
  lineEndOf: (line: number) => number,
): { start: number; end: number; text: string } {
  const emptyMultilineBody =
    span.kind === 'dialogue' && span.terminator == null && span.start === span.end
  if (!emptyMultilineBody) return { start: span.start, end: span.end, text: key }
  return {
    start: span.start,
    end: Math.max(span.end, lineEndOf(span.line)),
    text: `${eol}${key}`,
  }
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

/** 按下点的记账（见 isPressEcho）：`at` 是按下那一刻的毫秒时间戳 */
export type PressEcho = { x: number; y: number; at: number }

/** 按下与抬起算"同一处 / 同一按"的坐标容差（px）：按下与抬起之间手会抖 */
export const PRESS_ECHO_TOLERANCE_PX = 4
/**
 * 按下与抬起算"同一按"的时限（ms）。
 *
 * 取值偏大（不是"典型点击时长"）：真正的兜底是"下一次 pointerdown 就作废上次记账"，
 * 这里只是防止记账在极端情况下（抬起发生在窗口外、没收到 mouseup）永远留着。
 */
export const PRESS_ECHO_WINDOW_MS = 2000

/** 两点算不算"同一处"（按下与抬起的手抖容差） */
export function isSameSpot(
  from: { x: number; y: number },
  x: number,
  y: number,
): boolean {
  return (
    Math.abs(x - from.x) < PRESS_ECHO_TOLERANCE_PX &&
    Math.abs(y - from.y) < PRESS_ECHO_TOLERANCE_PX
  )
}

/**
 * 这一下是不是"某一按的余波"（同一处、时限内）。
 *
 * 编辑框级切换是**在按下这一按里**做的（点另一个框 → 提交当前这份 → 切过去），
 * 同一按后面还跟着 click：提交引起的重排已经让同一坐标底下换了条，
 * 再按坐标开一次框就会出现"点了 B 却开出 C"，所以要吃掉。
 * 新的一次按下（pointerdown 会作废记账）自然失效。
 */
export function isPressEcho(
  echo: PressEcho | null,
  x: number,
  y: number,
  now: number,
): boolean {
  if (!echo) return false
  if (now - echo.at >= PRESS_ECHO_WINDOW_MS) return false
  return isSameSpot(echo, x, y)
}
