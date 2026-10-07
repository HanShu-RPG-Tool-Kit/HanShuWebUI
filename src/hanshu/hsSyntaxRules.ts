/**
 * `.hs` 语法规则的**唯一来源**：解析（`monaco/textSpans`）、诊断
 * （`monaco/hsDiagnostics`）与语法着色（`monaco/hanshuLanguage`）都从这里取，
 * 避免同一套规则在多处各写一份、再慢慢漂移。
 *
 * 与应用内帮助「.hs 语法说明」的对应关系：
 * - 多行对白必须由**独占一行**的 `//` 收尾；正文行尾缀 `//` 不算收尾。
 * - 只有单行写法（`name:正文//`、`-文案:回复//`）才认行尾 `//`。
 * - 「块到此为止」的边界：选项行、新对白行、信号行、`@` / `@@`。
 * - 注释只认行首（可含前导空白）的 `#`，行内 `#` 属于正文。
 * - 信号 / 选项 / 注入等结构只认**行首**（无前导空白）。
 */

/** 角色行：`名字:正文` */
export const SPEAKER_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/

/** 注释行：行首（可含前导空白）才是注释，行内 `#` 属于正文 */
export const COMMENT_LINE = /^\s*#/

/** 选项行（文档单行写法）：`-+文案[:回复]//`，必须带行尾 `//` */
export const CHOICE_LINE = /^(-+)([\s\S]*?)\/\/\s*$/

/**
 * 系统返回选项：`--<`（回上级）/ `--<<`（回整树根）。
 * `-` 个数必须 ≥ 2；可带行尾 `//`（`.hs`），也可无（`.hsc` / 未闭合）。
 * 匹配时先认 `<<` 再认 `<`。
 */
export const SYSTEM_RETURN_LINE = /^(-{2,})(<<|<)(?:\/\/\s*)?$/

export type SystemReturnKind = 'parent' | 'root'

export type SystemReturnChoice = {
  depth: number
  kind: SystemReturnKind
  dashes: string
}

/** 系统返回选项行；不是则 null */
export function matchSystemReturnChoice(
  text: string,
): SystemReturnChoice | null {
  const m = SYSTEM_RETURN_LINE.exec(text)
  if (!m) return null
  return {
    depth: m[1]!.length,
    kind: m[2] === '<<' ? 'root' : 'parent',
    dashes: m[1]!,
  }
}

/**
 * 注入点：行首单个 `@` + 非空白后缀（如 `@dialog`）。
 * **不是**终止符 `@@…`（第二个字符不能是 `@`）。
 * 名字在**工作区跨文件**全局唯一（见诊断 `duplicate-inject` / 接线 `hsInject`）。
 */
export const INJECT_LINE = /^@([^\s@]\S*)\s*$/

export type InjectLine = {
  /** `@` 之后的名字 */
  name: string
}

/** 注入点行；不是则 null */
export function matchInjectLine(text: string): InjectLine | null {
  const m = INJECT_LINE.exec(text)
  if (!m) return null
  return { name: m[1]! }
}

/** 选项回复里的跳转目标：`>>name` → `name`；否则 null */
export function choiceJumpTarget(reply: string): string | null {
  const m = /^\s*>>([a-zA-Z_][a-zA-Z0-9_]*)\s*$/.exec(reply)
  return m ? m[1]! : null
}

/** 选项 body 里第一个未转义的 `:` */
export function findChoiceColon(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++
      continue
    }
    if (body[i] === ':') return i
  }
  return -1
}

/** 收集源文件中的注入点名（出现顺序；可含本文件内重复） */
export function collectHsInjectNames(source: string): string[] {
  const out: string[] = []
  for (const line of splitHsLines(source)) {
    const inj = matchInjectLine(line.text)
    if (inj) out.push(inj.name)
  }
  return out
}

/** 收集选项 `:>>name` 跳转目标（可跨文件解析到 `hsInject`） */
export function collectHsInjectJumps(source: string): string[] {
  const out: string[] = []
  for (const line of splitHsLines(source)) {
    const choice = CHOICE_LINE.exec(line.text)
    if (!choice) continue
    const body = choice[2]!
    const colon = findChoiceColon(body)
    if (colon < 0) continue
    const target = choiceJumpTarget(body.slice(colon + 1))
    if (target) out.push(target)
  }
  return out
}

/** 独占一行的块结束符 `//` */
export const BLOCK_END = /^\/\/\s*$/

/** 行尾的块结束符 `//`（只用于单行写法；多行块不认它） */
export const TRAILING_TERMINATOR = /\/\/\s*$/

/** 信号 id：字母/数字/下划线/点 */
export const SIGNAL_ID = '[a-zA-Z_][a-zA-Z0-9_.]*'

/** 条件信号：`?id args...`（约束下一选项行） */
export const COND_SIGNAL_LINE = new RegExp(
  `^\\?(${SIGNAL_ID})(?:\\s+(\\S.*))?$`,
)

/** 选项行为信号：`!:id args...`（约束下一选项行的「选项」侧） */
export const OPT_SIGNAL_LINE = new RegExp(
  `^!:(${SIGNAL_ID})(?:\\s+(\\S.*))?$`,
)

/** 答复行为信号：`:!id args...`（约束下一选项行的「答复」侧） */
export const REPLY_SIGNAL_LINE = new RegExp(
  `^:!(${SIGNAL_ID})(?:\\s+(\\S.*))?$`,
)

/**
 * 独立行为信号：`!id args...`（行级可执行语句；会打断选项树）。
 * 必须在 `!:` 之后匹配。
 */
export const ACTION_SIGNAL_LINE = new RegExp(
  `^!(${SIGNAL_ID})(?:\\s+(\\S.*))?$`,
)

export type HsSignalKind = 'cond' | 'action' | 'opt' | 'reply'

export type HsSignalLine = {
  kind: HsSignalKind
  id: string
  /** 参数原文（不含前导空白）；无参数时为空串 */
  args: string
}

/** 行首信号（`?` / `!` / `!:` / `:!`）；不是则 null */
export function matchHsSignalLine(text: string): HsSignalLine | null {
  let m = OPT_SIGNAL_LINE.exec(text)
  if (m) return { kind: 'opt', id: m[1]!, args: (m[2] ?? '').trimEnd() }
  m = REPLY_SIGNAL_LINE.exec(text)
  if (m) return { kind: 'reply', id: m[1]!, args: (m[2] ?? '').trimEnd() }
  m = COND_SIGNAL_LINE.exec(text)
  if (m) return { kind: 'cond', id: m[1]!, args: (m[2] ?? '').trimEnd() }
  m = ACTION_SIGNAL_LINE.exec(text)
  if (m) return { kind: 'action', id: m[1]!, args: (m[2] ?? '').trimEnd() }
  return null
}

/** 选项前置附件：`?` / `!:` / `:!`（不打断选项树） */
export function isChoiceAttachSignalLine(text: string): boolean {
  const sig = matchHsSignalLine(text)
  return sig != null && sig.kind !== 'action'
}

/** 独立行为信号行（打断选项树） */
export function isActionSignalLine(text: string): boolean {
  return matchHsSignalLine(text)?.kind === 'action'
}

/** 任意行首信号 */
export function isHsSignalLine(text: string): boolean {
  return matchHsSignalLine(text) != null
}

/** 选项回复是否为跳转：`>>name` */
export function isChoiceJumpReply(reply: string): boolean {
  return /^\s*>>[a-zA-Z_][a-zA-Z0-9_]*\s*$/.test(reply)
}

/** 「这个块到此为止」：选项行 / 新对白行 */
export const STATEMENT_BREAK_RE = /^(-|[a-zA-Z_][a-zA-Z0-9_]*:)/

/**
 * 对白块正文边界：结构语句会结束当前块。
 * 含选项、新对白、`@` / `@@`、全部信号行。
 */
export function isDialogueBreakLine(text: string): boolean {
  return (
    STATEMENT_BREAK_RE.test(text) ||
    text.startsWith('@') ||
    isHsSignalLine(text)
  )
}

/**
 * 结构行（编译紧凑化用）：`#` / `@` / `-` / 信号 / `speaker:` 形。
 * 解析器把 `#` / `@` / 信号当跳过或行级语句，编译则要在这里认出它们，
 * 避免把下一行折上来。
 */
export const STRUCTURAL_LINE_RE =
  /^(#|@|-|\?|!:|:!|![a-zA-Z_]|[a-zA-Z_][a-zA-Z0-9_]*:)/

export function isStructuralLine(line: string): boolean {
  return STRUCTURAL_LINE_RE.test(line) || isHsSignalLine(line)
}

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

/** 解析与诊断都跳过的行：注释、`@` 注入/终止、信号行 */
export function isSkippedHsLine(text: string): boolean {
  return COMMENT_LINE.test(text) || text.startsWith('@') || isHsSignalLine(text)
}

/**
 * 拆信号参数（供驱动器 / 诊断用）：空白分词，`"…"` 可含空格，`\"` 转义。
 * `.hs` 本身不解释参数语义。
 */
export function splitSignalArgs(args: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < args.length) {
    while (i < args.length && /\s/.test(args[i]!)) i++
    if (i >= args.length) break
    if (args[i] === '"') {
      i++
      let buf = ''
      while (i < args.length) {
        if (args[i] === '\\' && i + 1 < args.length) {
          buf += args[i + 1]
          i += 2
          continue
        }
        if (args[i] === '"') {
          i++
          break
        }
        buf += args[i]
        i++
      }
      out.push(buf)
      continue
    }
    let start = i
    while (i < args.length && !/\s/.test(args[i]!)) i++
    out.push(args.slice(start, i))
  }
  return out
}

/** HS 转义还原（解析产出的"值"用反转义文本） */
export function unescapeHsText(text: string): string {
  return text
    .replace(/\\>>/g, '>>')
    .replace(/\\<</g, '<<')
    .replace(/\\-/g, '-')
}

/**
 * HS 转义（**逆解析**把映射文本写回正文时用）：把会被语法吃掉的首字符转义。
 * 与 `unescapeHsText` 互为逆操作，顺序也必须一致（先 `>>`/`<<`，再 `-`）。
 */
export function escapeHsText(text: string): string {
  return text
    .replace(/>>/g, '\\>>')
    .replace(/<</g, '\\<<')
    .replace(/-/g, '\\-')
}
