/**
 * `.hs` 语法规则的**唯一来源**：解析（`monaco/langTextSpans`）、诊断
 * （`monaco/hsDiagnostics`）与语法着色（`monaco/hanshuLanguage`）都从这里取，
 * 避免同一套规则在多处各写一份、再慢慢漂移。
 *
 * 与 `docs/hanshu-syntax.md` 的对应关系：
 * - 多行对白必须由**独占一行**的 `//` 收尾；正文行尾缀 `//` 不算收尾。
 * - 只有单行写法（`name:正文//`、`-文案:回复//`）才认行尾 `//`。
 * - 「块到此为止」的边界只有选项行（`-`）与新对白行（`name:`）；
 *   `>` / `>>` 属于正文（结构行集合与编译口径保持一致）。
 * - 注释只认行首（可含前导空白）的 `#`，行内 `#` 属于正文。
 */

/** 角色行：`名字:正文` */
export const SPEAKER_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/

/** 注释行：行首（可含前导空白）才是注释，行内 `#` 属于正文；`#define` 也落在这一类 */
export const COMMENT_LINE = /^\s*#/

/** 选项行（文档单行写法）：`-+文案[:回复]//`，必须带行尾 `//` */
export const CHOICE_LINE = /^(-+)([\s\S]*?)\/\/\s*$/

/** 独占一行的块结束符 `//` */
export const BLOCK_END = /^\/\/\s*$/

/** 行尾的块结束符 `//`（只用于单行写法；多行块不认它） */
export const TRAILING_TERMINATOR = /\/\/\s*$/

/** 「这个块到此为止」：选项行 / 新对白行 */
export const STATEMENT_BREAK_RE = /^(-|[a-zA-Z_][a-zA-Z0-9_]*:)/

/** `.hs` 源文件的一行：`start` 是它在原文里的绝对偏移 */
export type HsLine = { text: string; start: number }

/** 按 `\n` 切行并剥掉行尾 `\r`（值文本统一用 `\n`） */
export function splitHsLines(source: string): HsLine[] {
  const out: HsLine[] = []
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

/** 解析与诊断都跳过的行：注释（含 `#define`）与 `@` 注入点 */
export function isSkippedHsLine(text: string): boolean {
  return COMMENT_LINE.test(text) || text.startsWith('@')
}

/** 数一行里 `''''` 围栏的数量（奇偶用来翻转"是否在 Python 块内"） */
export function countEmbedDelimiters(line: string): number {
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

/** HS 转义还原（解析产出的"值"用反转义文本） */
export function unescapeHsText(text: string): string {
  return text
    .replace(/\\>>/g, '>>')
    .replace(/\\<</g, '<<')
    .replace(/\\-/g, '-')
}
