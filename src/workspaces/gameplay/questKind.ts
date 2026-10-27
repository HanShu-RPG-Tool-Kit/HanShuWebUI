/** 任务（.quest）作者态：单进度表单 vs 多进度树图；引擎导出时归一为 .questc。 */

export const QUEST_EXT = '.quest' as const

/** 作者态 format（磁盘后缀一律 .quest） */
export const SIMPLE_QUEST_FORMAT = 'hanshu.progress' as const
export const MULTI_QUEST_FORMAT = 'hanshu.progress-tree' as const

export type QuestAuthorKind = 'simple' | 'multi'

/** 资源树虚拟二级视图（不落盘、不进 folders 状态） */
export const QUEST_VIEW_SIMPLE = 'view:quest:simple'
export const QUEST_VIEW_MULTI = 'view:quest:multi'
export const QUEST_VIEW_NAMES: Record<string, string> = {
  [QUEST_VIEW_SIMPLE]: '单进度任务',
  [QUEST_VIEW_MULTI]: '多进度任务',
}

export function isQuestViewKey(key: string): boolean {
  return key === QUEST_VIEW_SIMPLE || key === QUEST_VIEW_MULTI
}

export function questViewKind(key: string): QuestAuthorKind | null {
  if (key === QUEST_VIEW_SIMPLE) return 'simple'
  if (key === QUEST_VIEW_MULTI) return 'multi'
  return null
}

export function questViewKey(kind: QuestAuthorKind): string {
  return kind === 'simple' ? QUEST_VIEW_SIMPLE : QUEST_VIEW_MULTI
}

export function isQuestFileName(name: string): boolean {
  return name.toLowerCase().endsWith(QUEST_EXT)
}

/** 从 JSON 正文快速判断作者态；无法识别时返回 null。 */
export function questAuthorKindFromSource(source: string): QuestAuthorKind | null {
  if (/["']format["']\s*:\s*["']hanshu\.progress-tree["']/.test(source)) return 'multi'
  if (/["']format["']\s*:\s*["']hanshu\.progress["']/.test(source)) return 'simple'
  return null
}

/** 判定文档作者态：看正文 format；未知当作单进度（表单修复更安全）。 */
export function questAuthorKindOf(document: { name: string; source?: string }): QuestAuthorKind {
  if (typeof document.source === 'string') {
    const fromSource = questAuthorKindFromSource(document.source)
    if (fromSource) return fromSource
  }
  return 'simple'
}

export function normalizeQuestFileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return `未命名${QUEST_EXT}`
  if (/\.(quest|json)$/i.test(trimmed)) {
    return trimmed.replace(/\.(quest|json)$/i, QUEST_EXT)
  }
  return `${trimmed}${QUEST_EXT}`
}
