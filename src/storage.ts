const STORAGE_KEY = 'hanshu.draft.v1'

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
