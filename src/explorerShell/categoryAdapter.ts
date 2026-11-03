import { sourceIconKind, type ExplorerIconKind } from '../explorerIcons'
import {
  DEFAULT_ORGANIZATION_REGISTRY,
  categoryAllowsFolders,
  type OrganizationRegistry,
} from '../project/organizationDomains'
import { RESOURCE_TYPES, type ResourceTypeId } from '../resourceTypes'
import { getExtension, sourcePathOf, type SourceFile } from '../workspace'

/** 工作区分类表的最小形状：`GAMEPLAY_CATEGORIES` / `AUDIOVISUAL_CATEGORIES` / `STAGEPLAY_CATEGORIES`。 */
export type CategoryTable = Readonly<Record<string, {
  name: string
  icon?: string
  types: readonly ResourceTypeId[]
}>>

export type ShellCategory = {
  id: string
  name: string
  icon: ExplorerIconKind
  /** 原生格式扩展名；为空表示占位分类，只显示提示。 */
  extensions: readonly string[]
  /** 能否建共享虚拟文件夹（由组织协议决定，不由界面猜）。 */
  folders: boolean
  /** 新建入口文案；省略即该分类不能新建。 */
  createLabel?: string
}

export type ShellFile = {
  id: string
  name: string
  /** 规范工程相对路径；共享归属只认它。 */
  path: string
  category: string
  icon: ExplorerIconKind
  /** 去掉原生扩展名后的可改名部分 */
  base: string
  detached?: boolean
}

export function categoriesFromTable(
  table: CategoryTable,
  options: {
    createLabel?: (id: string) => string | undefined
    registry?: OrganizationRegistry
  } = {},
): ShellCategory[] {
  const registry = options.registry ?? DEFAULT_ORGANIZATION_REGISTRY
  return Object.entries(table).map(([id, definition]) => ({
    id,
    name: definition.name,
    icon: (definition.icon ?? 'folder') as ExplorerIconKind,
    extensions: definition.types.map(type => RESOURCE_TYPES.find(item => item.id === type)!.ext),
    folders: categoryAllowsFolders(registry, id),
    createLabel: options.createLabel?.(id),
  }))
}

/** 按扩展名把源文件分进分类；不属于任一分类的源文件不进入这棵树。 */
export function filesForCategories(sources: readonly SourceFile[], categories: readonly ShellCategory[]): ShellFile[] {
  const byExt = new Map(categories.flatMap(category => category.extensions.map(ext => [ext, category.id] as const)))
  return sources.flatMap(source => {
    const ext = getExtension(source.name)
    const category = byExt.get(ext)
    if (!category) return []
    return [{
      id: source.id,
      name: source.name,
      path: sourcePathOf(source),
      category,
      icon: sourceIconKind(source),
      base: source.name.slice(0, source.name.length - ext.length),
      detached: source.detached,
    }]
  })
}
