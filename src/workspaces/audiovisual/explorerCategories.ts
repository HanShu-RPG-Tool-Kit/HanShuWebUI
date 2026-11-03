import { categoriesFromTable, filesForCategories } from '../../explorerShell/categoryAdapter'
import { AUDIOVISUAL_CATEGORIES } from '../../resourceTypes'
import type { SourceFile } from '../../workspace'

/** 视听分类适配器：新建入口按分类登记；占位分类无格式，也不建共享文件夹（协议拒绝）。 */
const CREATE_LABELS: Partial<Record<keyof typeof AUDIOVISUAL_CATEGORIES, string>> = {
  bossbar: '新建 BOSS 血条',
}

export const AUDIOVISUAL_EXPLORER_CATEGORIES = categoriesFromTable(AUDIOVISUAL_CATEGORIES, {
  createLabel: (id) => CREATE_LABELS[id as keyof typeof AUDIOVISUAL_CATEGORIES],
})

export function audiovisualSources(sources: readonly SourceFile[]): SourceFile[] {
  const ids = new Set(filesForCategories(sources, AUDIOVISUAL_EXPLORER_CATEGORIES).map((file) => file.id))
  return sources.filter((source) => ids.has(source.id))
}
