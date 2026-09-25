import { DEFAULT_LOCALE_TAG, formatLocaleTag } from './i18n/locales'

const STORAGE_KEY = 'hanshu.draft.v1'
const LOCALE_KEY = 'hanshu.locale'

export type Draft = {
  script: string
  updatedAt: number
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<Draft>
    if (typeof data.script !== 'string') return null
    return {
      script: data.script,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

/** 只记忆正文；备选角色不持久化 */
export function saveDraft(script: string): void {
  const draft: Draft = {
    script,
    updatedAt: Date.now(),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
}

export function clearDraft(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** 当前语言标签（标题栏语言选择），未设置或非法时回落到默认语言 */
export function loadLocale(): string {
  try {
    return formatLocaleTag(localStorage.getItem(LOCALE_KEY) ?? '') || DEFAULT_LOCALE_TAG
  } catch {
    return DEFAULT_LOCALE_TAG
  }
}

export function saveLocale(tag: string): void {
  const formatted = formatLocaleTag(tag)
  if (!formatted) return
  try {
    localStorage.setItem(LOCALE_KEY, formatted)
  } catch {
    /* 隐私模式等场景下静默失败 */
  }
}
