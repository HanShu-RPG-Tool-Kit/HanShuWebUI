import { randomId } from '../project/crypto'
import {
  parseOrganization,
  type ExplorerFolder,
  type ExplorerOrganization,
} from '../project/explorerOrganization'
import {
  DEFAULT_ORGANIZATION_REGISTRY,
  categoryAllowsFolders,
  type OrganizationRegistry,
} from '../project/organizationDomains'
import { resourceBaseError } from '../resourceNames'
import { resourceNameKey } from '../resourceTypes'

/**
 * 共享虚拟文件夹的纯函数操作。只改组织元数据，不创建 / 搬动 / 删除磁盘文件；
 * 结果都经 `parseOrganization` 复核，调用方再经文件事务提交 `meta/explorer.json`。
 */

const validated = (value: ExplorerOrganization, registry: OrganizationRegistry) =>
  parseOrganization(JSON.stringify(value), registry)

function requireFolderName(
  value: ExplorerOrganization,
  category: string,
  parentId: string | null,
  raw: string,
  except?: string,
): string {
  const name = raw.trim()
  const error = resourceBaseError(name)
  if (error) throw new Error(error)
  const key = resourceNameKey(name)
  if (value.folders.some(folder => folder.key !== except && folder.category === category &&
      folder.parentId === parentId && resourceNameKey(folder.name) === key)) {
    throw new Error('此位置已有同名文件夹。')
  }
  return name
}

function requireParent(value: ExplorerOrganization, category: string, parentId: string | null, registry: OrganizationRegistry) {
  if (!categoryAllowsFolders(registry, category)) throw new Error('该分类暂不支持文件夹。')
  if (parentId === null) return
  const section = registry.sections.get(parentId)
  if (section) {
    if (section.category !== category) throw new Error('目标文件夹不在当前分类中。')
    return
  }
  const parent = value.folders.find(folder => folder.key === parentId)
  if (!parent || parent.category !== category) throw new Error('目标文件夹不在当前分类中。')
}

export function folderSubtree(value: ExplorerOrganization, key: string): Set<string> {
  const keys = new Set<string>()
  const queue = [key]
  while (queue.length) {
    const current = queue.pop()!
    if (keys.has(current)) continue
    keys.add(current)
    for (const folder of value.folders) if (folder.parentId === current) queue.push(folder.key)
  }
  return keys
}

export function addVirtualFolder(
  value: ExplorerOrganization,
  category: string,
  parentId: string | null,
  rawName: string,
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): { organization: ExplorerOrganization; folder: ExplorerFolder } {
  requireParent(value, category, parentId, registry)
  const name = requireFolderName(value, category, parentId, rawName)
  const folder: ExplorerFolder = { key: randomId(), name, parentId, category }
  return { organization: validated({ ...value, folders: [...value.folders, folder] }, registry), folder }
}

export function renameVirtualFolder(
  value: ExplorerOrganization,
  key: string,
  rawName: string,
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): ExplorerOrganization {
  const folder = value.folders.find(item => item.key === key)
  if (!folder) throw new Error('文件夹不存在。')
  const name = requireFolderName(value, folder.category, folder.parentId, rawName, key)
  if (name === folder.name) return value
  return validated({ ...value, folders: value.folders.map(item => item.key === key ? { ...item, name } : item) }, registry)
}

/** 文件夹只能在本分类内移动；不能移进自身子树。 */
export function moveVirtualFolder(
  value: ExplorerOrganization,
  key: string,
  parentId: string | null,
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): ExplorerOrganization {
  const folder = value.folders.find(item => item.key === key)
  if (!folder) throw new Error('文件夹不存在。')
  if (folder.parentId === parentId) return value
  if (parentId !== null && folderSubtree(value, key).has(parentId)) throw new Error('不能移动到自身或自己的子文件夹。')
  requireParent(value, folder.category, parentId, registry)
  requireFolderName(value, folder.category, parentId, folder.name, key)
  return validated({ ...value, folders: value.folders.map(item => item.key === key ? { ...item, parentId } : item) }, registry)
}

/** 删除文件夹及其子文件夹；其中的源文件回到分类根，不删除任何源文件。 */
export function removeVirtualFolder(
  value: ExplorerOrganization,
  key: string,
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): ExplorerOrganization {
  const removed = folderSubtree(value, key)
  return validated({
    ...value,
    folders: value.folders.filter(folder => !removed.has(folder.key)),
    placements: Object.fromEntries(Object.entries(value.placements).filter(([, folder]) => !removed.has(folder))),
  }, registry)
}

/** 把一个规范工程路径放进文件夹；`null` 回到分类根。分类与类型一致性由协议复核。 */
export function placeSource(
  value: ExplorerOrganization,
  path: string,
  folderKey: string | null,
  registry: OrganizationRegistry = DEFAULT_ORGANIZATION_REGISTRY,
): ExplorerOrganization {
  if ((value.placements[path] ?? null) === folderKey) return value
  const placements = { ...value.placements }
  if (folderKey === null) delete placements[path]
  else placements[path] = folderKey
  return validated({ ...value, placements }, registry)
}
