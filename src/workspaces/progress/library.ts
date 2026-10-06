import type { FlowFolder, FlowPackageId, FlowWorkspaceState } from './storage'

export type FlowEntry =
  | { kind: 'package'; package: FlowPackageId }
  | { kind: 'folder' | 'document'; key: string }

export type FlowSectionDef = { id: string; name: string }

export const FLOW_PACKAGE_ORDER: FlowPackageId[] = ['script', 'progress', 'story', 'actor', 'reputation', 'region', 'navigator', 'shop', 'gift']
export const FLOW_PACKAGE_NAMES: Record<FlowPackageId, string> = {
  script: '脚本',
  progress: '进度',
  story: '故事流程',
  actor: '演员',
  reputation: '声誉',
  region: '区域',
  navigator: '导航器',
  shop: '商店',
  gift: '礼包',
}
/** 顶层分类下的内置二级分类（稳定键、不可重命名/移动/删除） */
export const FLOW_PACKAGE_SECTIONS: Partial<Record<FlowPackageId, FlowSectionDef[]>> = {
  script: [{ id: 'goal-def', name: '目标定义' }],
}
export const packageAllowsFlows = (id: FlowPackageId) => id === 'story'
export const packageAllowsScripts = (id: FlowPackageId) => id === 'script'
export const packageAllowsKits = (id: FlowPackageId) => id === 'gift'
export const packageAllowsProgress = (id: FlowPackageId) => id === 'progress'
export const packageAllowsNavigation = (id: FlowPackageId) => id === 'navigator'
export const packageAllowsDocuments = (id: FlowPackageId) =>
  packageAllowsFlows(id) || packageAllowsScripts(id) || packageAllowsKits(id) || packageAllowsProgress(id) || packageAllowsNavigation(id)
export const packageAcceptsImportFile = (id: FlowPackageId, fileName: string) => {
  const lower = fileName.toLowerCase()
  if (id === 'script') return lower.endsWith('.py')
  if (id === 'gift') return lower.endsWith('.kit')
  if (id === 'progress') return lower.endsWith('.progress')
  if (id === 'navigator') return lower.endsWith('.nav') || lower.endsWith('.json')
  if (id === 'story') return lower.endsWith('.hflow') || lower.endsWith('.json')
  return false
}
export type PackageDocumentExt = '.hflow' | '.py' | '.kit' | '.progress' | '.nav'
export const packageDocumentExt = (id: FlowPackageId): PackageDocumentExt | null =>
  id === 'story' ? '.hflow'
    : id === 'script' ? '.py'
      : id === 'gift' ? '.kit'
        : id === 'progress' ? '.progress'
          : id === 'navigator' ? '.nav'
            : null
export const isScriptDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'script' || document.name.toLowerCase().endsWith('.py')
export const isKitDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'gift' || document.name.toLowerCase().endsWith('.kit')
export const isProgressDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'progress' || document.name.toLowerCase().endsWith('.progress')
export const isNavigationDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'navigator' || document.name.toLowerCase().endsWith('.nav')
export function documentExtOf(document: { package: FlowPackageId; name: string }): PackageDocumentExt {
  return packageDocumentExt(document.package)
    ?? (isNavigationDocument(document) ? '.nav'
      : isProgressDocument(document) ? '.progress'
        : isKitDocument(document) ? '.kit'
          : isScriptDocument(document) ? '.py'
            : '.hflow')
}
export const packageEntry = (id: FlowPackageId): FlowEntry => ({ kind: 'package', package: id })
export const sectionFolderKey = (pkg: FlowPackageId, sectionId: string) => `section:${pkg}:${sectionId}`
export const isSectionFolder = (key: string) => key.startsWith('section:')

/** 「目标定义 / 内置」虚拟文件夹（稳定键，不落盘） */
export const BUILTIN_GOAL_FOLDER_KEY = 'builtin:folder:script:goal-def'
export const builtinGoalDocumentKey = (name: string) => `builtin:goal:${name}`
export const isBuiltinGoalFolder = (key: string) => key === BUILTIN_GOAL_FOLDER_KEY
export const isBuiltinGoalDocumentKey = (key: string) => key.startsWith('builtin:goal:')
/** 资源树只读项：内置二级分类、虚拟内置文件夹与脚本 */
export const isReadonlyExplorerKey = (key: string) =>
  isSectionFolder(key) || isBuiltinGoalFolder(key) || isBuiltinGoalDocumentKey(key)

export function sectionDefs(pkg: FlowPackageId): FlowSectionDef[] {
  return FLOW_PACKAGE_SECTIONS[pkg] ?? []
}

export function parseSectionFolderKey(key: string): { package: FlowPackageId; sectionId: string } | null {
  if (!isSectionFolder(key)) return null
  const rest = key.slice('section:'.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const pkg = rest.slice(0, colon)
  const sectionId = rest.slice(colon + 1)
  if (!(FLOW_PACKAGE_ORDER as string[]).includes(pkg) || !sectionId) return null
  const def = sectionDefs(pkg as FlowPackageId).find((item) => item.id === sectionId)
  return def ? { package: pkg as FlowPackageId, sectionId } : null
}

export function ensurePackageSections(state: FlowWorkspaceState): FlowWorkspaceState {
  const byKey = new Map(state.folders.map((folder) => [folder.key, folder]))
  let changed = false
  const folders: FlowFolder[] = state.folders.map((folder) => {
    const parsed = parseSectionFolderKey(folder.key)
    if (!parsed) return folder
    const def = sectionDefs(parsed.package).find((item) => item.id === parsed.sectionId)!
    if (folder.name === def.name && folder.parentId === null && folder.package === parsed.package) return folder
    changed = true
    return { ...folder, name: def.name, parentId: null, package: parsed.package }
  })
  for (const pkg of FLOW_PACKAGE_ORDER) {
    for (const section of sectionDefs(pkg)) {
      const key = sectionFolderKey(pkg, section.id)
      if (byKey.has(key)) continue
      changed = true
      folders.push({ key, name: section.name, parentId: null, package: pkg })
    }
  }
  return changed ? { ...state, folders } : state
}

export const entryId = (entry: FlowEntry) => entry.kind === 'package' ? `package:${entry.package}` : `${entry.kind}:${entry.key}`

export function entryPackage(state: FlowWorkspaceState, entry: FlowEntry): FlowPackageId {
  if (entry.kind === 'package') return entry.package
  if (entry.kind === 'folder') return state.folders.find((folder) => folder.key === entry.key)?.package ?? 'story'
  return state.documents.find((document) => document.key === entry.key)?.package ?? 'story'
}

export function entryFolder(state: FlowWorkspaceState, entry: FlowEntry): string | null {
  if (entry.kind === 'package') return null
  if (entry.kind === 'folder') return entry.key
  return state.documents.find((document) => document.key === entry.key)?.folderId ?? null
}

export function resourceName(value: string, documentExt: boolean | PackageDocumentExt = false) {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name)) throw new Error('请输入有效名称，不可包含路径分隔符或特殊字符。')
  if (!documentExt) return name
  const ext = documentExt === true ? '.hflow' : documentExt
  const lower = name.toLowerCase()
  if (lower.endsWith(ext)) return name
  if (/\.(hflow|py|json|kit|progress|nav)$/i.test(name)) return name.replace(/\.(hflow|py|json|kit|progress|nav)$/i, ext)
  return `${name}${ext}`
}

function requireFolder(state: FlowWorkspaceState, parent: string | null) {
  if (parent !== null && !state.folders.some((folder) => folder.key === parent)) throw new Error('目标文件夹不存在。')
  if (parent !== null && isBuiltinGoalFolder(parent)) throw new Error('内置文件夹为只读，不能在此创建或移入资源。')
}

/** 文件夹：同级唯一；文档：同一分类内全局唯一（与所在文件夹无关，便于磁盘/lang 扁平映射）。 */
export function requireAvailableName(
  state: FlowWorkspaceState,
  name: string,
  pkg: FlowPackageId,
  parent: string | null,
  except?: string,
  kind: 'folder' | 'document' = 'document',
) {
  requireFolder(state, parent)
  if (parent !== null) {
    const folder = state.folders.find((item) => item.key === parent)
    if (!folder || folder.package !== pkg) throw new Error('目标文件夹不在当前分类中。')
  }
  const same = (other: string) => other.normalize('NFC').toLocaleLowerCase() === name.normalize('NFC').toLocaleLowerCase()
  if (kind === 'folder') {
    if (state.folders.some((folder) => folder.key !== except && folder.package === pkg && folder.parentId === parent && same(folder.name))) {
      throw new Error('此位置已有同名文件夹。')
    }
    return
  }
  if (state.documents.some((document) => document.key !== except && document.package === pkg && same(document.name))) {
    throw new Error('此分类中已有同名文件。')
  }
}

export function uniqueDocumentName(state: FlowWorkspaceState, name: string, pkg: FlowPackageId, parent: string | null) {
  const ext = packageDocumentExt(pkg)
  if (!ext) throw new Error('此分类不支持文件。')
  const normalized = resourceName(name, ext), stem = normalized.slice(0, -ext.length)
  let candidate = normalized, index = 2
  for (;;) {
    try { requireAvailableName(state, candidate, pkg, parent, undefined, 'document'); return candidate }
    catch (error) { requireFolder(state, parent); if (!(error instanceof Error) || !error.message.includes('同名')) throw error }
    candidate = `${stem} (${index++})${ext}`
  }
}

export function addFlowFolder(state: FlowWorkspaceState, value: string, pkg: FlowPackageId, parentId: string | null) {
  const name = resourceName(value)
  requireAvailableName(state, name, pkg, parentId, undefined, 'folder')
  const folder = { key: crypto.randomUUID(), name, parentId, package: pkg }
  return { state: { ...state, folders: [...state.folders, folder] }, folder }
}

export function renameFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, value: string): FlowWorkspaceState {
  if (entry.kind === 'package') return state
  if (entry.kind === 'folder' && isSectionFolder(entry.key)) throw new Error('内置二级分类不可重命名。')
  if (entry.kind === 'folder' && isBuiltinGoalFolder(entry.key)) throw new Error('内置文件夹不可重命名。')
  if (entry.kind === 'document' && isBuiltinGoalDocumentKey(entry.key)) throw new Error('内置脚本为只读，不可重命名。')
  const item = entry.kind === 'folder' ? state.folders.find((folder) => folder.key === entry.key) : state.documents.find((document) => document.key === entry.key)
  if (!item) throw new Error('资源不存在。')
  const ext = entry.kind === 'document' ? documentExtOf(item as { package: FlowPackageId; name: string }) : false
  const name = resourceName(value, ext)
  const pkg = item.package
  const parent = entry.kind === 'folder' ? state.folders.find((folder) => folder.key === entry.key)!.parentId : state.documents.find((document) => document.key === entry.key)!.folderId ?? null
  requireAvailableName(state, name, pkg, parent, entry.key, entry.kind === 'folder' ? 'folder' : 'document')
  return entry.kind === 'folder'
    ? { ...state, folders: state.folders.map((folder) => folder.key === entry.key ? { ...folder, name } : folder) }
    : { ...state, documents: state.documents.map((document) => document.key === entry.key ? { ...document, name } : document) }
}

export function canMoveFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, pkg: FlowPackageId, parent: string | null) {
  if (entry.kind === 'package') return false
  if (entry.kind === 'folder' && isSectionFolder(entry.key)) return false
  if (entry.kind === 'folder' && isBuiltinGoalFolder(entry.key)) return false
  if (entry.kind === 'document' && isBuiltinGoalDocumentKey(entry.key)) return false
  if (parent !== null && isBuiltinGoalFolder(parent)) return false
  if (parent !== null) {
    const folder = state.folders.find((item) => item.key === parent)
    if (!folder || folder.package !== pkg) return false
  }
  if (entry.kind === 'document') {
    const document = state.documents.find((item) => item.key === entry.key)
    if (!document) return false
    if (isKitDocument(document)) return packageAllowsKits(pkg)
    if (isProgressDocument(document)) return packageAllowsProgress(pkg)
    if (isNavigationDocument(document)) return packageAllowsNavigation(pkg)
    if (isScriptDocument(document)) return packageAllowsScripts(pkg)
    return packageAllowsFlows(pkg)
  }
  if (!state.folders.some((folder) => folder.key === entry.key)) return false
  let ancestor = parent
  while (ancestor !== null) {
    if (ancestor === entry.key) return false
    ancestor = state.folders.find((folder) => folder.key === ancestor)?.parentId ?? null
  }
  return true
}

function retargetPackageSubtree(state: FlowWorkspaceState, folderKey: string, pkg: FlowPackageId): FlowWorkspaceState {
  const queue = [folderKey]
  const folderKeys = new Set<string>()
  while (queue.length) {
    const key = queue.pop()!
    folderKeys.add(key)
    for (const child of state.folders) if (child.parentId === key) queue.push(child.key)
  }
  return {
    ...state,
    folders: state.folders.map((folder) => folderKeys.has(folder.key) ? { ...folder, package: pkg } : folder),
    documents: state.documents.map((document) => document.folderId && folderKeys.has(document.folderId) ? { ...document, package: pkg } : document),
  }
}

export function moveFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, pkg: FlowPackageId, parent: string | null): FlowWorkspaceState {
  if (!canMoveFlowEntry(state, entry, pkg, parent) || entry.kind === 'package') throw new Error('不能移动到自身或自己的子文件夹。')
  if (entry.kind === 'document') {
    const document = state.documents.find((item) => item.key === entry.key)
    if (document && isKitDocument(document) && !packageAllowsKits(pkg)) throw new Error('礼包只能放在「礼包」分类中。')
    if (document && isProgressDocument(document) && !packageAllowsProgress(pkg)) throw new Error('进度只能放在「进度」分类中。')
    if (document && isNavigationDocument(document) && !packageAllowsNavigation(pkg)) throw new Error('导航点只能放在「导航器」分类中。')
    if (document && isScriptDocument(document) && !packageAllowsScripts(pkg)) throw new Error('脚本只能放在「脚本」分类中。')
    if (document && !isKitDocument(document) && !isProgressDocument(document) && !isNavigationDocument(document) && !isScriptDocument(document) && !packageAllowsFlows(pkg)) throw new Error('流程只能放在「故事流程」分类中。')
  }
  const name = entry.kind === 'folder' ? state.folders.find((folder) => folder.key === entry.key)!.name : state.documents.find((document) => document.key === entry.key)!.name
  requireAvailableName(state, name, pkg, parent, entry.key, entry.kind === 'folder' ? 'folder' : 'document')
  if (entry.kind === 'folder') {
    const next = {
      ...state,
      folders: state.folders.map((folder) => folder.key === entry.key ? { ...folder, parentId: parent, package: pkg } : folder),
    }
    return retargetPackageSubtree(next, entry.key, pkg)
  }
  return {
    ...state,
    documents: state.documents.map((document) => document.key === entry.key ? { ...document, folderId: parent, package: pkg } : document),
  }
}

export const isFolderEmpty = (state: FlowWorkspaceState, key: string) => !state.folders.some((folder) => folder.parentId === key) && !state.documents.some((document) => document.folderId === key)

export function folderPath(state: FlowWorkspaceState, pkg: FlowPackageId, key: string | null): string {
  const parts: string[] = []
  let current = key
  while (current !== null) {
    const folder = state.folders.find((item) => item.key === current)
    if (!folder) break
    parts.unshift(folder.name)
    current = folder.parentId
  }
  return [FLOW_PACKAGE_NAMES[pkg], ...parts].join(' / ')
}
