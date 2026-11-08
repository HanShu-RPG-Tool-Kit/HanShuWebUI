/**
 * `unparse_hs` / 语言文本写回正文时的**安全判定**（纯语法层，不含 agent 逻辑）。
 *
 * 背景：`.hs`/`.char` 的正文有结构字符（行尾 `//`、选项文案的 `:`、行首 `?`/`!`/`@`/`#`/`*`）。
 * `escapeHsText` 只负责 `>>`/`<<`/`-` 的转义；剩下的字符写回正文会拆坏语句结构，
 * 因此逆解析遇到它们时应当**不内联**（交给调用方报告并让作者用 edit_source 处理），
 * 而不是写出一份语法被切碎的正文。
 *
 * 这个模块只做判断，不改文本：写回动作由 `agentOps.unparseSourceText` 执行。
 */

/** 文本在正文里所处的位置：对白正文 / 选项文案 / 选项回复 */
export type InlineContext = 'dialogue' | 'optionText' | 'optionReply'

export type UnsafeInlineReason =
  /** 含 `//`：单行语句会被提前终结 */
  | 'line-terminator'
  /** 选项文案/回复里含 `:`：会把选项的"文案:回复"切错位 */
  | 'option-colon'
  /** 行首是结构字符（`?` `!` `@` `#` `*` `:`） */
  | 'leading-structure'
  /** 含换行：属于多行文本，不能内联回单行语句 */
  | 'line-break'
  /** 空串：逆解析成空正文会改变语句形态 */
  | 'empty'

/**
 * 返回不能安全内联回正文的原因；`null` 表示可以内联（`>>`/`<<`/`-` 由调用方先转义）。
 * 注意：`-` 在任意位置都由 `escapeHsText` 转义，所以这里不报。
 */
export function unsafeInlineReason(
  text: string,
  context: InlineContext,
): UnsafeInlineReason | null {
  if (text.length === 0) return 'empty'
  if (text.includes('\n') || text.includes('\r')) return 'line-break'
  if (text.includes('//')) return 'line-terminator'
  if (context !== 'dialogue' && text.includes(':')) return 'option-colon'
  if (/^[?!@#*:]/.test(text)) return 'leading-structure'
  return null
}

/** 语言文本值的风险（写译文时给 warning 用；比 unsafeInlineReason 更细） */
export type LangValueRisk = UnsafeInlineReason | 'leading-space' | 'trailing-space'

/**
 * 评估一条译文写进 `.lang` 之后、将来被 `unparse_hs` 写回正文的潜在风险。
 * 只用于**警告**，不阻止写入（译文本身合法，风险在于"之后能否安全还原成正文"）。
 */
export function assessLangValueRisks(
  text: string,
  context: InlineContext,
): LangValueRisk[] {
  const risks: LangValueRisk[] = []
  const unsafe = unsafeInlineReason(text, context)
  if (unsafe) risks.push(unsafe)
  if (/^\s/.test(text)) risks.push('leading-space')
  if (/\s$/.test(text)) risks.push('trailing-space')
  return risks
}
