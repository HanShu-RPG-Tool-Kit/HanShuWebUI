import {
  AUDIOVISUAL_CATEGORIES,
  GAMEPLAY_CATEGORIES,
  STAGEPLAY_CATEGORIES,
  type ResourceTypeId,
} from '../resourceTypes'
import { scriptTypeFromSection, type ScriptType } from '../scriptResources/types'
import { FLOW_PACKAGE_SECTIONS } from '../workspaces/gameplay/sections'

export type OrganizationCategory = { name: string; types: readonly ResourceTypeId[] }
export type OrganizationSection = { category: string; scriptType: ScriptType }

/**
 * 一个工作区在共享组织 `meta/explorer.json` 里认领的分类表。
 *
 * 分类 ID 在全部域之间唯一，资源类型也只能属于一个分类：归属校验按文件扩展名找到唯一分类，
 * 再要求整条文件夹父链落在同一分类内。
 */
export type OrganizationDomain = {
  id: 'gameplay' | 'audiovisual' | 'stageplay'
  categories: Readonly<Record<string, OrganizationCategory>>
  /** 是否允许用户创建共享虚拟文件夹；关闭时该域分类出现文件夹即视为无效元数据。 */
  virtualFolders: boolean
  /** 可作为共享父级的固定分类键（`section:<分类>:<id>`）；视图类固定项不在此列。 */
  sections: ReadonlyMap<string, OrganizationSection>
}

const gameplaySections = new Map<string, OrganizationSection>(
  Object.entries(FLOW_PACKAGE_SECTIONS).flatMap(([category, definitions]) =>
    (definitions ?? []).filter(section => !section.virtual).map(section => [
      `section:${category}:${section.id}`,
      { category, scriptType: category === 'script' ? scriptTypeFromSection(section.id) : 'common' as ScriptType },
    ] as const),
  ),
)

export const GAMEPLAY_DOMAIN: OrganizationDomain = {
  id: 'gameplay', categories: GAMEPLAY_CATEGORIES, virtualFolders: true, sections: gameplaySections,
}
export const AUDIOVISUAL_DOMAIN: OrganizationDomain = {
  id: 'audiovisual', categories: AUDIOVISUAL_CATEGORIES, virtualFolders: true, sections: new Map(),
}
/** 剧本分类与其他域同一协议：共享虚拟文件夹只整理归属，磁盘路径仍由类型决定。 */
export const STAGEPLAY_DOMAIN: OrganizationDomain = {
  id: 'stageplay', categories: STAGEPLAY_CATEGORIES, virtualFolders: true, sections: new Map(),
}

export const ORGANIZATION_DOMAINS: readonly OrganizationDomain[] = [GAMEPLAY_DOMAIN, AUDIOVISUAL_DOMAIN, STAGEPLAY_DOMAIN]

export type OrganizationRegistry = {
  domains: readonly OrganizationDomain[]
  domainOfCategory: ReadonlyMap<string, OrganizationDomain>
  categoryOfType: ReadonlyMap<ResourceTypeId, string>
  sections: ReadonlyMap<string, OrganizationSection>
}

export function organizationRegistry(domains: readonly OrganizationDomain[]): OrganizationRegistry {
  const domainOfCategory = new Map<string, OrganizationDomain>()
  const categoryOfType = new Map<ResourceTypeId, string>()
  const sections = new Map<string, OrganizationSection>()
  for (const domain of domains) {
    for (const [category, definition] of Object.entries(domain.categories)) {
      if (domainOfCategory.has(category)) throw new Error(`资源分类 ID 重复：${category}`)
      domainOfCategory.set(category, domain)
      for (const type of definition.types) {
        if (categoryOfType.has(type)) throw new Error(`资源类型 ${type} 同时属于多个分类`)
        categoryOfType.set(type, category)
      }
    }
    for (const [key, section] of domain.sections) {
      if (!Object.hasOwn(domain.categories, section.category)) throw new Error(`固定分类 ${key} 不属于 ${domain.id}`)
      sections.set(key, section)
    }
  }
  return { domains, domainOfCategory, categoryOfType, sections }
}

export const DEFAULT_ORGANIZATION_REGISTRY = organizationRegistry(ORGANIZATION_DOMAINS)

/** 该分类能否建共享虚拟文件夹：域启用且分类已有原生格式（占位分类不建夹）。 */
export function categoryAllowsFolders(registry: OrganizationRegistry, category: string): boolean {
  const domain = registry.domainOfCategory.get(category)
  return Boolean(domain?.virtualFolders && domain.categories[category]!.types.length > 0)
}
