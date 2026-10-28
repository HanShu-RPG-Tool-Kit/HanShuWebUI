import { resourceBaseError } from '../resourceNames'
import { GAMEPLAY_CATEGORIES, resourceNameKey, resourceTypeForExtension } from '../resourceTypes'
import { scriptTypeFromSection, type ScriptType } from '../scriptResources/types'
import { FLOW_PACKAGE_SECTIONS } from '../workspaces/gameplay/sections'
import { sourcePathOf, assertCanonicalSourcePath, getExtension, type SourceFile } from '../workspace'
import type { FlowFolder, FlowDocument } from '../workspaces/gameplay/storage'

export const EXPLORER_ORGANIZATION_PATH = 'meta/explorer.json'

/** Shared organization only. Tabs, selection and collapsed rows remain personal. */
export type ExplorerOrganization = {
  version: 1
  folders: FlowFolder[]
  placements: Record<string, string>
}

export const emptyOrganization = (): ExplorerOrganization => ({ version: 1, folders: [], placements: {} })
const sections = new Map<string, { category: string; scriptType: ScriptType }>(Object.entries(FLOW_PACKAGE_SECTIONS).flatMap(([category, definitions]) =>
  definitions.filter(section => !section.virtual).map(section => [
    `section:${category}:${section.id}`,
    { category, scriptType: category === 'script' ? scriptTypeFromSection(section.id) : 'common' as ScriptType },
  ] as const),
))

/** Validate untrusted project metadata before it can become a tree or a write candidate. */
export function parseOrganization(raw: string | null): ExplorerOrganization {
  if (raw === null) return emptyOrganization()
  const value = JSON.parse(raw) as ExplorerOrganization
  if (value?.version !== 1 || !Array.isArray(value.folders) || value.folders.length > 2000 ||
      !value.placements || typeof value.placements !== 'object' || Array.isArray(value.placements)) {
    throw new Error('资源组织元数据格式无效')
  }

  const folders = new Map<string, FlowFolder>()
  for (const folder of value.folders) {
    if (!folder || typeof folder.key !== 'string' || !folder.key || folder.key.length > 128 ||
        folder.key.includes(':') || folders.has(folder.key) ||
        !Object.hasOwn(GAMEPLAY_CATEGORIES, folder.package) ||
        typeof folder.name !== 'string' || folder.name !== folder.name.trim() ||
        resourceBaseError(folder.name) !== null ||
        (folder.parentId !== null && typeof folder.parentId !== 'string')) {
      throw new Error('虚拟文件夹无效或重复')
    }
    folders.set(folder.key, {
      key: folder.key, name: folder.name, parentId: folder.parentId, package: folder.package,
    })
  }

  const typeOf = (key: string | null, category: string): ScriptType => {
    const visited = new Set<string>()
    while (key !== null) {
      if (sections.has(key)) {
        const section = sections.get(key)!
        if (category !== section.category) throw new Error('文件夹分类不一致')
        return section.scriptType
      }
      if (visited.has(key)) throw new Error('虚拟文件夹存在循环')
      visited.add(key)
      const folder = folders.get(key)
      if (!folder || folder.package !== category) throw new Error('虚拟文件夹父级无效')
      key = folder.parentId
    }
    return 'common'
  }

  const siblings = new Set<string>()
  for (const folder of folders.values()) {
    typeOf(folder.key, folder.package)
    const identity = `${folder.package}/${folder.parentId ?? ''}/${resourceNameKey(folder.name)}`
    if (siblings.has(identity)) throw new Error('存在同级重名文件夹')
    siblings.add(identity)
  }

  const placements: Record<string, string> = {}
  for (const [path, key] of Object.entries(value.placements)) {
    assertCanonicalSourcePath(path)
    const definition = resourceTypeForExtension(getExtension(path))
    if (!definition || !Object.hasOwn(GAMEPLAY_CATEGORIES, definition.category) || typeof key !== 'string') {
      throw new Error('资源归属无效')
    }
    const type = typeOf(key, definition.category)
    if (definition.category === 'script' && type !== path.split('/')[2]) {
      throw new Error('视图文件夹不能改变脚本类型')
    }
    placements[path] = key
  }
  return { version: 1, folders: [...folders.values()], placements }
}

/** Stable output and semantic comparisons must ignore input JSON formatting/order. */
export function serializeOrganization(value: ExplorerOrganization): string {
  const checked = parseOrganization(JSON.stringify(value))
  checked.folders.sort((a, b) => a.key.localeCompare(b.key))
  checked.placements = Object.fromEntries(Object.entries(checked.placements).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify(checked, null, 2) + '\n'
}

/** Replace only this window's source projection; peers may have registered unsaved paths. */
export function organizationFromDocuments(
  documents: FlowDocument[],
  folders: FlowFolder[],
  previous?: { organization: ExplorerOrganization; sourcePaths: readonly string[] },
): ExplorerOrganization {
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
  const placements: Record<string, string> = { ...previous?.organization.placements }
  // These are the old paths of the documents being edited, including explicit moves/deletions.
  for (const path of previous?.sourcePaths ?? []) delete placements[path]
  // Removing a folder explicitly also removes its unprojected placements.
  for (const [path, key] of Object.entries(placements)) {
    if (!byKey.has(key) && !sections.has(key)) delete placements[path]
  }
  for (const document of documents) {
    if (document.folderId && !sections.has(document.folderId)) {
      placements[sourcePathOf({ name: document.name, srcKind: scriptKind(document.folderId) })] = document.folderId
    }
  }
  return parseOrganization(JSON.stringify({
    version: 1, folders: folders.filter(folder => !folder.key.startsWith('section:')), placements,
  }))
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
