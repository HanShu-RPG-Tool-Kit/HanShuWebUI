import { categoriesFromTable, filesForCategories } from '../../explorerShell/categoryAdapter'
import { stageplayNewFileTypes, type NewFileType } from '../../newFileTypes'
import { STAGEPLAY_CATEGORIES, resourceTypeForExtension } from '../../resourceTypes'
import {
  STAGEPLAY_WORKSPACE_GROUP_ORDER,
  isStageplayExplorerSource,
  sourceKindOf,
  type SourceFile,
} from '../../workspace'

/**
 * 剧本分类适配器：分类即 `STAGEPLAY_CATEGORIES`，顺序与物理分组 `STAGEPLAY_WORKSPACE_GROUP_ORDER` 一致。
 * 共享虚拟文件夹由组织协议决定（`STAGEPLAY_DOMAIN.virtualFolders`），磁盘路径仍由资源类型决定。
 */
const CREATE_LABELS: Record<keyof typeof STAGEPLAY_CATEGORIES, string> = {
  hanshu: '新建汉书剧本',
  character: '新建角色卡',
  meta: '新建创作资料…',
}

export const STAGEPLAY_EXPLORER_CATEGORIES = categoriesFromTable(
  Object.fromEntries(STAGEPLAY_WORKSPACE_GROUP_ORDER.map((id) => [id, STAGEPLAY_CATEGORIES[id]])),
  { createLabel: (id) => CREATE_LABELS[id as keyof typeof STAGEPLAY_CATEGORIES] },
)

/** 剧本树里的分类文件；游戏性 / 视听文件不进入。 */
export function stageplaySources(sources: readonly SourceFile[]): SourceFile[] {
  return sources.filter(
    (source) => isStageplayExplorerSource(source) && sourceKindOf(source.name, source.srcKind) !== 'root',
  )
}

export function stageplayShellFiles(sources: readonly SourceFile[]) {
  return filesForCategories(stageplaySources(sources), STAGEPLAY_EXPLORER_CATEGORIES)
}

/** 历史遗留在工程根、不属于任何剧本分类的源文件（如旧 `.voice` / `.lang`）；只读列出，不能建夹。 */
export function stageplayLooseSources(sources: readonly SourceFile[]): SourceFile[] {
  return sources.filter(
    (source) => isStageplayExplorerSource(source) && sourceKindOf(source.name, source.srcKind) === 'root',
  )
}

/** 某分类下可新建的剧本类型（`+剧` 菜单的子集）。 */
export function stageplayTypesForCategory(category: string): NewFileType[] {
  return stageplayNewFileTypes().filter((type) => resourceTypeForExtension(type.ext)?.category === category)
}

/** 新建类型落在哪个剧本分类。 */
export function stageplayCategoryOfType(type: NewFileType): string | null {
  return resourceTypeForExtension(type.ext)?.category ?? null
}
