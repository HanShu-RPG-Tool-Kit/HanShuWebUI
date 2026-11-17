/**
 * 注入点与跳转引用的**纯语法扫描**（不含 agent 逻辑）。
 *
 * - 注入点：行首单个 `@` + 标识符（`@name`）；`@@` 是终止符，不算注入点；
 *   名字全局唯一（跨文件），由调用方做重复检查。
 * - 跳转引用：选项里的 `:>>name`（只能出现在选项行，并指向某个 `@name`）。
 *
 * 行首有前导空格的 `@` 不是注入点（结构只认行首）；`#` 注释行整行跳过。
 */
import { splitHsLines } from './hsSyntaxRules'

export type InjectDefinition = {
  name: string
  /** 1 起的行号 */
  line: number
}

export type JumpTarget = InjectDefinition

const INJECT_DEFINITION = /^@([A-Za-z_][A-Za-z0-9_]*)\s*$/
const JUMP_REFERENCE = /:>>\s*([A-Za-z_][A-Za-z0-9_]*)/g

/** 收集本文件里的 `@name` 注入点定义（行号 1 起） */
export function collectInjectDefinitions(content: string): InjectDefinition[] {
  const out: InjectDefinition[] = []
  const lines = splitHsLines(content)
  for (let index = 0; index < lines.length; index += 1) {
    const definition = INJECT_DEFINITION.exec(lines[index]!.text)
    if (!definition) continue
    out.push({ name: definition[1]!, line: index + 1 })
  }
  return out
}

/** 收集本文件里的 `:>>name` 跳转引用（行号 1 起；注释行跳过） */
export function collectJumpTargets(content: string): JumpTarget[] {
  const out: JumpTarget[] = []
  const lines = splitHsLines(content)
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!.text
    if (text.trimStart().startsWith('#')) continue
    JUMP_REFERENCE.lastIndex = 0
    for (let match = JUMP_REFERENCE.exec(text); match; match = JUMP_REFERENCE.exec(text)) {
      out.push({ name: match[1]!, line: index + 1 })
    }
  }
  return out
}
