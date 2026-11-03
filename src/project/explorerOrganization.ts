import { resourceBaseError } from '../resourceNames'
import { resourceNameKey, resourceTypeForExtension } from '../resourceTypes'
import type { ScriptType } from '../scriptResources/types'
import { sourcePathOf, assertCanonicalSourcePath, getExtension, type SourceFile } from '../workspace'
import type { FlowDocument } from '../workspaces/gameplay/storage'
import {
  DEFAULT_ORGANIZATION_REGISTRY,
  GAMEPLAY_DOMAIN,
  categoryAllowsFolders,
  type OrganizationDomain,
  type OrganizationRegistry,
} from './organizationDomains'

export const EXPLORER_ORGANIZATION_PATH = 'meta/explorer.json'

/** 共享虚拟文件夹。`category` 是业务分类 ID；v1 元数据里同一字段叫 `package`。 */
export type ExplorerFolder = { key: string; name: string; parentId: string | null; category: string }

/** Shared organization only. Tabs, selection and collapsed rows remain personal. */
export type ExplorerOrganization = {
  version: 2
  folders: ExplorerFolder[]
  placements: Record<string, string>
}

export const emptyOrganization = (): ExplorerOrganization => ({ version: 2, folders: [], placements: {} })

/**
 * Validate untrusted project metadata before it can become a tree or a write candidate.
 * Reads v1 (`package`) and v2 (`category`); the result is always v2.
 */
export function parseOrganization(raw: string | null, registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY): ExplorerOrganization {
  if (raw === null) return emptyOrganization()
  const value = JSON.parse(raw) as { version?: unknown; folders?: unknown; placements?: unknown }
  if ((value?.version !== 1 && value?.version !== 2) || !Array.isArray(value.folders) || value.folders.length > 2000 ||
      !value.placements || typeof value.placements !== 'object' || Array.isArray(value.placements)) {
    throw new Error('资源组织元数据格式无效')
  }
  const categoryField = value.version === 1 ? 'package' : 'category'

  const folders = new Map<string, ExplorerFolder>()
  for (const folder of value.folders as Array<Record<string, unknown>>) {
    const category = folder?.[categoryField]
    if (!folder || typeof folder.key !== 'string' || !folder.key || folder.key.length > 128 ||
        folder.key.includes(':') || folders.has(folder.key) ||
        typeof category !== 'string' || !categoryAllowsFolders(registry, category) ||
        typeof folder.name !== 'string' || folder.name !== folder.name.trim() ||
        resourceBaseError(folder.name) !== null ||
        (folder.parentId !== null && typeof folder.parentId !== 'string')) {
      throw new Error('虚拟文件夹无效或重复')
    }
    folders.set(folder.key, { key: folder.key, name: folder.name, parentId: folder.parentId as string | null, category })
  }

  const typeOf = (key: string | null, category: string): ScriptType => {
    const visited = new Set<string>()
    while (key !== null) {
      const section = registry.sections.get(key)
      if (section) {
        if (category !== section.category) throw new Error('文件夹分类不一致')
        return section.scriptType
      }
      if (visited.has(key)) throw new Error('虚拟文件夹存在循环')
      visited.add(key)
      const folder = folders.get(key)
      if (!folder || folder.category !== category) throw new Error('虚拟文件夹父级无效')
      key = folder.parentId
    }
    return 'common'
  }

  const siblings = new Set<string>()
  for (const folder of folders.values()) {
    typeOf(folder.key, folder.category)
    const identity = `${folder.category}/${folder.parentId ?? ''}/${resourceNameKey(folder.name)}`
    if (siblings.has(identity)) throw new Error('存在同级重名文件夹')
    siblings.add(identity)
  }

  const placements: Record<string, string> = {}
  for (const [path, key] of Object.entries(value.placements as Record<string, unknown>)) {
    assertCanonicalSourcePath(path)
    const definition = resourceTypeForExtension(getExtension(path))
    const category = definition && registry.categoryOfType.get(definition.id)
    if (!category || !categoryAllowsFolders(registry, category) || typeof key !== 'string') {
      throw new Error('资源归属无效')
    }
    const type = typeOf(key, category)
    if (definition.id === 'js' && type !== path.split('/')[2]) {
      throw new Error('视图文件夹不能改变脚本类型')
    }
    placements[path] = key
  }
  return { version: 2, folders: [...folders.values()], placements }
}

/** Stable output and semantic comparisons must ignore input JSON formatting/order. */
export function serializeOrganization(value: ExplorerOrganization): string {
  const checked = parseOrganization(JSON.stringify(value))
  checked.folders.sort((a, b) => a.key.localeCompare(b.key))
  checked.placements = Object.fromEntries(Object.entries(checked.placements).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify(checked, null, 2) + '\n'
}

/** 某个域认领的文件夹；其他工作区的文件夹不进入本域视图。 */
export function domainFolders(value: ExplorerOrganization | undefined, domain: OrganizationDomain): ExplorerFolder[] {
  return (value?.folders ?? []).filter(folder => Object.hasOwn(domain.categories, folder.category))
}

/**
 * 用一个域在本窗口的投影替换组织：只替换该域的文件夹与本窗口已投影源路径的归属。
 * 其他域的文件夹、其他窗口尚未保存的归属保持不动；明确删除文件夹时才清除其剩余归属。
 */
export function projectDomainOrganization(
  domain: OrganizationDomain,
  folders: readonly ExplorerFolder[],
  placements: Readonly<Record<string, string>>,
  previous?: { organization: ExplorerOrganization; sourcePaths: readonly string[] },
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): ExplorerOrganization {
  const owned = (folder: ExplorerFolder) => Object.hasOwn(domain.categories, folder.category)
  const nextFolders = [
    ...(previous?.organization.folders ?? []).filter(folder => !owned(folder)),
    ...folders.filter(folder => owned(folder) && !folder.key.startsWith('section:')),
  ]
  const keys = new Set(nextFolders.map(folder => folder.key))
  const nextPlacements: Record<string, string> = { ...previous?.organization.placements }
  // These are the old paths of the documents being edited, including explicit moves/deletions.
  for (const path of previous?.sourcePaths ?? []) delete nextPlacements[path]
  for (const [path, key] of Object.entries(nextPlacements)) {
    if (!keys.has(key) && !registry.sections.has(key)) delete nextPlacements[path]
  }
  Object.assign(nextPlacements, placements)
  return parseOrganization(JSON.stringify({ version: 2, folders: nextFolders, placements: nextPlacements }), registry)
}

/** Replace only this window's source projection; peers may have registered unsaved paths. */
export function organizationFromDocuments(
  documents: FlowDocument[],
  folders: readonly ExplorerFolder[],
  previous?: { organization: ExplorerOrganization; sourcePaths: readonly string[] },
): ExplorerOrganization {
  const sections = DEFAULT_ORGANIZATION_REGISTRY.sections
  const byKey = new Map(folders.map(folder => [folder.key, folder]))
  const scriptKind = (key: string | null): ScriptType => {
    const visited = new Set<string>()
    while (key && !visited.has(key)) {
      visited.add(key)
      if (sections.has(key)) return sections.get(key)!.scriptType
      key = byKey.get(key)?.parentId ?? null
    }
    return 'common'
  }
  const placements: Record<string, string> = {}
  for (const document of documents) {
    if (document.folderId && !sections.has(document.folderId)) {
      placements[sourcePathOf({ name: document.name, srcKind: scriptKind(document.folderId) })] = document.folderId
    }
  }
  return projectDomainOrganization(GAMEPLAY_DOMAIN, folders, placements, previous)
}

/** Source IDs differ between sessions; only the canonical path crosses that boundary. */
export function documentPlacements(sources: SourceFile[], value: ExplorerOrganization): Record<string, string | null> {
  return Object.fromEntries(sources.map(source => [source.id, value.placements[sourcePathOf(source)] ?? null]))
}

export function relocateOrganization(
  value: ExplorerOrganization,
  commands: Array<{ path: string; destination: string | null }>,
): ExplorerOrganization {
  const placements = { ...value.placements }
  for (const { path, destination } of commands) {
    const key = placements[path]
    delete placements[path]
    if (destination && key) placements[destination] = key
  }
  // Outside the explorer, a cross-type script move cannot retain its previous type's folder.
  for (const [path, key] of Object.entries(placements)) {
    try { parseOrganization(JSON.stringify({ ...value, placements: { [path]: key } })) }
    catch { delete placements[path] }
  }
  return { ...value, placements }
}
