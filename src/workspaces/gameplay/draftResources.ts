import { getExtension } from '../../workspace'

/**
 * 游戏性里可标「草稿」并跳过 PAK 编译的格式。
 * 不含脚本（本身就是源码）、任务分类虚入口、表视图等。
 */
export const GAMEPLAY_DRAFT_EXTENSIONS = [
  '.quest',
  '.actor',
  '.shop',
  '.kit',
  '.item',
  '.entity',
  '.rep',
  '.level',
  '.nav',
] as const

/** 与草稿同一批：表单编辑的 JSON 文档，适合资源管理器「查看源码」。 */
export const GAMEPLAY_VIEW_SOURCE_EXTENSIONS = GAMEPLAY_DRAFT_EXTENSIONS

export function supportsGameplayDraft(name: string): boolean {
  const ext = getExtension(name).toLowerCase()
  return (GAMEPLAY_DRAFT_EXTENSIONS as readonly string[]).includes(ext)
}

export function supportsGameplayViewSource(name: string): boolean {
  const ext = getExtension(name).toLowerCase()
  return (GAMEPLAY_VIEW_SOURCE_EXTENSIONS as readonly string[]).includes(ext)
}
