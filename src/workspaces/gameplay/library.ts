import {resourceBaseError} from '../../resourceNames'
import {GAMEPLAY_CATEGORIES, RESOURCE_TYPES, categoryExtensions, resourceNameKey} from '../../resourceTypes'
import {SCRIPT_TYPES,SCRIPT_TYPE_NAMES,scriptSection,scriptTypeFromSection,type ScriptType} from '../../scriptResources/types'
import { randomId } from '../../project/crypto'
import { stampDocument, type FlowFolder, type FlowPackageId, type FlowWorkspaceState } from './storage'
import {
  isQuestFileName,
  isQuestViewKey,
  QUEST_EXT,
  questAuthorKindOf,
  type QuestAuthorKind,
} from './questKind'

export type FlowEntry =
  | { kind: 'package'; package: FlowPackageId }
  | { kind: 'folder' | 'document'; key: string }

export type FlowSectionDef = {
  id: string
  name: string
  /** 内置二级分类的父级；省略即挂在分类根 */
  parentId?: string
  /** 视图而非目录：不落 state.folders，也不可创建/移动/删除 */
  virtual?: boolean
}

export const FLOW_PACKAGE_ORDER = Object.keys(GAMEPLAY_CATEGORIES) as FlowPackageId[]
export const FLOW_PACKAGE_NAMES = Object.fromEntries(Object.entries(GAMEPLAY_CATEGORIES).map(([id,def])=>[id,def.name])) as Record<FlowPackageId,string>
/** 顶层分类下的内置二级分类（稳定键、不可重命名/移动/删除）。任务的单/多进度是视图，不走这里。 */
export const FLOW_PACKAGE_SECTIONS: Partial<Record<FlowPackageId, FlowSectionDef[]>> = {
  script: SCRIPT_TYPES.map(type=>({id:scriptSection(type),name:SCRIPT_TYPE_NAMES[type]})),
  level: [
    { id: 'templates', name: '地图模板' },
    { id: 'navigator', name: '导航器' },
    { id: 'static-nav', name: '静态导航器', parentId: 'navigator', virtual: true },
    { id: 'dynamic-nav', name: '动态导航器', parentId: 'navigator' },
  ],
}
/** @deprecated 使用 packageAllowsQuest */
export const packageAllowsFlows = (id: FlowPackageId) => id === 'quest'
export const packageAllowsScripts = (id: FlowPackageId) => id === 'script'
export const packageAllowsShops = (id: FlowPackageId) => id === 'shop'
export const isShopDocument = (document: { package: FlowPackageId; name: string }) => document.package === 'shop' || document.name.toLowerCase().endsWith('.shop')
export const packageAllowsKits = (id: FlowPackageId) => id === 'gift'
/** @deprecated 使用 packageAllowsQuest */
export const packageAllowsProgress = (id: FlowPackageId) => id === 'quest'
export const packageAllowsQuest = (id: FlowPackageId) => id === 'quest'
/** 地图分类：模板、静态导航视图与动态导航目录都在这里。 */
export const packageAllowsLevel = (id: FlowPackageId) => id === 'level'
export const packageAllowsEntities = (id: FlowPackageId) => id === 'entities'
export const packageAllowsItems = (id: FlowPackageId) => id === 'items'
export const packageAllowsDocuments = (id: FlowPackageId) => categoryExtensions(id).length > 0

export const packageAcceptsImportFile = (id:FlowPackageId,name:string) =>
  (GAMEPLAY_CATEGORIES[id].imports as readonly string[]).some(ext=>name.toLowerCase().endsWith(ext))
type CategoryResourceType = (typeof GAMEPLAY_CATEGORIES)[FlowPackageId]['types'][number]
export type PackageDocumentExt = Extract<(typeof RESOURCE_TYPES)[number],{id:CategoryResourceType}>['ext']
/** First format is the default for new documents, not the only permitted format. */
export const packageDocumentExt = (id:FlowPackageId):PackageDocumentExt|null =>
  categoryExtensions(id)[0] as PackageDocumentExt ?? null

/** 「物品库」虚拟表视图（稳定键，不落盘） */
export const ITEM_LIBRARY_TABLE_KEY = 'builtin:item-library-table'
export const ENTITY_LIBRARY_TABLE_KEY = 'builtin:entity-library-table'
export const isEntityLibraryTableKey = (key:string) => key === ENTITY_LIBRARY_TABLE_KEY
export const isLibraryTableKey = (key:string) => key === ITEM_LIBRARY_TABLE_KEY || isEntityLibraryTableKey(key)
export const isItemLibraryTableKey = (key: string) => key === ITEM_LIBRARY_TABLE_KEY

/** 静态导航器：模板内声明的导航点的只读视图（不是目录）。 */
export const LEVEL_STATIC_VIEW_KEY = 'level-view:static-nav'
export const isLevelStaticViewKey = (key: string) => key === LEVEL_STATIC_VIEW_KEY
export const levelStaticTemplateKey = (documentKey: string) => `level-static:template:${documentKey}`
export const levelStaticPointKey = (documentKey: string, navId: string) => `level-static:point:${documentKey}:${navId}`
export function parseLevelStaticPointKey(key: string): { documentKey: string; navId: string } | null {
  if (!key.startsWith('level-static:point:')) return null
  const rest = key.slice('level-static:point:'.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  return { documentKey: rest.slice(0, colon), navId: rest.slice(colon + 1) }
}
export function parseLevelStaticTemplateKey(key: string): string | null {
  return key.startsWith('level-static:template:') ? key.slice('level-static:template:'.length) : null
}
export const isLevelStaticKey = (key: string) => key.startsWith('level-static:')

export const isScriptDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'script' || document.name.toLowerCase().endsWith('.py')
export const isKitDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'gift' || document.name.toLowerCase().endsWith('.kit')
/** 任意任务文档（单进度 / 多进度）。 */
export const isQuestDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'quest' || isQuestFileName(document.name)
/** 单进度任务（表单）；按正文 format 判定。 */
export const isSimpleQuestDocument = (document: { package: FlowPackageId; name: string; source?: string }) =>
  isQuestDocument(document) && questAuthorKindOf(document) === 'simple'
/** 多进度任务（树图）。 */
export const isMultiQuestDocument = (document: { package: FlowPackageId; name: string; source?: string }) =>
  isQuestDocument(document) && questAuthorKindOf(document) === 'multi'
/** @deprecated 使用 isSimpleQuestDocument */
export const isProgressDocument = isSimpleQuestDocument
/** 地图模板：一个 `.level` 文件包含 regions + 静态导航器。 */
export const isLevelDocument = (document: { package: FlowPackageId; name: string }) =>
  document.package === 'level' && document.name.toLowerCase().endsWith('.level')
/** 动态导航器：独立 `.nav` 文件，编译时原样注入 level 字段。 */
export const isNavigationDocument = (document: { package: FlowPackageId; name: string }) =>
  document.name.toLowerCase().endsWith('.nav')
export const isEntityDocument = (document: {key?:string;package: FlowPackageId;name:string}) => !isLibraryTableKey(document.key??'') && (document.package === 'entities' || document.name.toLowerCase().endsWith('.entity'))
export const isItemDocument = (document: { key?: string; package: FlowPackageId; name: string }) => {
  if (document.key && isLibraryTableKey(document.key)) return false
  return document.package === 'items' || document.name.toLowerCase().endsWith('.item')
}
export function documentExtOf(document:{package:FlowPackageId;name:string}):PackageDocumentExt {
  const ext=categoryExtensions(document.package).find(ext=>document.name.toLowerCase().endsWith(ext))
  if(!ext)throw new Error(`文件类型与分类不一致：${document.name}`)
  return ext as PackageDocumentExt
}

export function questKindOfDocument(document: { package: FlowPackageId; name: string; source?: string }): QuestAuthorKind | null {
  return isQuestDocument(document) ? questAuthorKindOf(document) : null
}
export const packageEntry = (id: FlowPackageId): FlowEntry => ({ kind: 'package', package: id })
export const sectionFolderKey = (pkg: FlowPackageId, sectionId: string) => `section:${pkg}:${sectionId}`
export const isSectionFolder = (key: string) => key.startsWith('section:')

/** Virtual builtins are grouped by the same script type as project files. */
export const builtinScriptFolderKey=(type:ScriptType)=>`builtin:folder:script:${type}`
export const builtinScriptDocumentKey=(type:ScriptType,name:string)=>`builtin:script:${type}:${name}`
export const isBuiltinScriptDocumentKey=(key:string)=>key.startsWith('builtin:script:')
export const isBuiltinScriptFolder=(key:string)=>key.startsWith('builtin:folder:script:')
export function scriptTypeInFolder(state:Pick<FlowWorkspaceState,'folders'>,parent:string|null):ScriptType{
 const visited=new Set<string>()
 while(parent&&!visited.has(parent)){visited.add(parent);const section=parseSectionFolderKey(parent);if(section?.package==='script')return scriptTypeFromSection(section.sectionId);parent=state.folders.find(f=>f.key===parent)?.parentId??null}
 return 'common'
}
/** 资源树只读项：内置二级分类、虚拟内置文件夹与脚本、物品库表视图 */
export const isReadonlyExplorerKey = (key: string) =>
  isSectionFolder(key) || isQuestViewKey(key) || isBuiltinScriptFolder(key) || isBuiltinScriptDocumentKey(key) || isLibraryTableKey(key) || isLevelStaticViewKey(key) || isLevelStaticKey(key)

export function sectionDefs(pkg: FlowPackageId): FlowSectionDef[] {
  return FLOW_PACKAGE_SECTIONS[pkg] ?? []
}

/** 沿父链找所属的内置二级分类 id（用户文件夹里也能判断）。 */
export function folderSectionId(state: Pick<FlowWorkspaceState, 'folders'>, folderId: string | null): string | null {
  let current = folderId
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    const parsed = parseSectionFolderKey(current)
    if (parsed) return parsed.sectionId
    current = state.folders.find((folder) => folder.key === current)?.parentId ?? null
  }
  return null
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
    const parentId = def.parentId ? sectionFolderKey(parsed.package, def.parentId) : null
    if (folder.name === def.name && folder.parentId === parentId && folder.package === parsed.package) return folder
    changed = true
    return { ...folder, name: def.name, parentId, package: parsed.package }
  })
  for (const pkg of FLOW_PACKAGE_ORDER) {
    for (const section of sectionDefs(pkg)) {
      if (section.virtual) continue
      const key = sectionFolderKey(pkg, section.id)
      if (byKey.has(key)) continue
      changed = true
      const parentId = section.parentId ? sectionFolderKey(pkg, section.parentId) : null
      folders.push({ key, name: section.name, parentId, package: pkg })
    }
  }
  return changed ? { ...state, folders } : state
}

export const entryId = (entry: FlowEntry) => entry.kind === 'package' ? `package:${entry.package}` : `${entry.kind}:${entry.key}`

export function entryPackage(state: FlowWorkspaceState, entry: FlowEntry): FlowPackageId {
  if (entry.kind === 'package') return entry.package
  if (entry.kind === 'folder') {
    if (isQuestViewKey(entry.key)) return 'quest'
    if (isLevelStaticViewKey(entry.key) || isLevelStaticKey(entry.key)) return 'level'
    return state.folders.find((folder) => folder.key === entry.key)?.package ?? 'quest'
  }
  if (isLevelStaticKey(entry.key)) return 'level'
  return state.documents.find((document) => document.key === entry.key)?.package ?? 'quest'
}

export function entryFolder(state: FlowWorkspaceState, entry: FlowEntry): string | null {
  if (entry.kind === 'package') return null
  if (entry.kind === 'folder') {
    if (isLevelStaticViewKey(entry.key)) return sectionFolderKey('level', 'navigator')
    if (isLevelStaticKey(entry.key)) {
      const point = parseLevelStaticPointKey(entry.key)
      if (point) return levelStaticTemplateKey(point.documentKey)
      return LEVEL_STATIC_VIEW_KEY
    }
    return entry.key
  }
  if (isLevelStaticKey(entry.key)) {
    const point = parseLevelStaticPointKey(entry.key)
    return point ? levelStaticTemplateKey(point.documentKey) : LEVEL_STATIC_VIEW_KEY
  }
  return state.documents.find((document) => document.key === entry.key)?.folderId ?? null
}

export function resourceName(value: string, documentExt: boolean | PackageDocumentExt = false) {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name)) throw new Error('请输入有效名称，不可包含路径分隔符或特殊字符。')
  if (!documentExt) { const error=resourceBaseError(name);if(error)throw new Error(error);return name }
  const ext = documentExt === true ? QUEST_EXT : documentExt
  const lower = name.toLowerCase()
  const previousExtension=[...RESOURCE_TYPES.map(type=>type.ext),'.json','.itemstack'].find(known=>lower.endsWith(known))
  const base=previousExtension?name.slice(0,-previousExtension.length):name
  const error=resourceBaseError(base);if(error)throw new Error(error)
  if (lower.endsWith(ext)) return name
  return `${base}${ext}`
}

function requireFolder(state: FlowWorkspaceState, parent: string | null) {
  if (parent !== null && !state.folders.some((folder) => folder.key === parent)) throw new Error('目标文件夹不存在。')
  if (parent !== null && isBuiltinScriptFolder(parent)) throw new Error('内置文件夹为只读，不能在此创建或移入资源。')
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
  const same = (other: string) => resourceNameKey(other) === resourceNameKey(name)
  if (kind === 'document' && pkg === 'level' && name.includes('$')) {
    throw new Error('地图资源名不能包含 $（导出 ID 用它分隔模板与子项）。')
  }
  if (kind === 'folder') {
    if (state.folders.some((folder) => folder.key !== except && folder.package === pkg && folder.parentId === parent && same(folder.name))) {
      throw new Error('此位置已有同名文件夹。')
    }
    return
  }
  if (state.documents.some((document) => document.key !== except && document.package === pkg && !isBuiltinScriptDocumentKey(document.key) && (pkg!=='script'||scriptTypeInFolder(state,document.folderId??null)===scriptTypeInFolder(state,parent)) && same(document.name))) {
    throw new Error('此分类中已有同名文件。')
  }
}

export function uniqueDocumentName(state: FlowWorkspaceState, name: string, pkg: FlowPackageId, parent: string | null, extOverride?: PackageDocumentExt) {
  const ext = extOverride ?? packageDocumentExt(pkg)
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
  const folder = { key: randomId(), name, parentId, package: pkg }
  return { state: { ...state, folders: [...state.folders, folder] }, folder }
}

export function renameFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, value: string): FlowWorkspaceState {
  if (entry.kind === 'package') return state
  if (entry.kind === 'folder' && isSectionFolder(entry.key)) throw new Error('内置二级分类不可重命名。')
  if (entry.kind === 'folder' && isBuiltinScriptFolder(entry.key)) throw new Error('内置文件夹不可重命名。')
  if (entry.kind === 'document' && isBuiltinScriptDocumentKey(entry.key)) throw new Error('内置脚本为只读，不可重命名。')
  if (entry.kind === 'document' && isLibraryTableKey(entry.key)) throw new Error('资源库表视图为只读，不可重命名。')
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
  if (entry.kind === 'folder' && isBuiltinScriptFolder(entry.key)) return false
  if (entry.kind === 'document' && isBuiltinScriptDocumentKey(entry.key)) return false
  if (entry.kind === 'document' && isLibraryTableKey(entry.key)) return false
  if (parent !== null && isBuiltinScriptFolder(parent)) return false
  if (parent !== null) {
    const folder = state.folders.find((item) => item.key === parent)
    if (!folder || folder.package !== pkg) return false
  }
  if (entry.kind === 'document') {
    const document = state.documents.find((item) => item.key === entry.key)
    if (!document) return false
    if (isLevelDocument(document)) return pkg === 'level' && folderSectionId(state, parent) === 'templates'
    if (isNavigationDocument(document)) return pkg === 'level' && folderSectionId(state, parent) === 'dynamic-nav'
    if (isKitDocument(document)) return packageAllowsKits(pkg)
    if (isProgressDocument(document)) return packageAllowsProgress(pkg)
    if (isEntityDocument(document)) return packageAllowsEntities(pkg)
    if (isItemDocument(document)) return packageAllowsItems(pkg)
    if (isScriptDocument(document)) return packageAllowsScripts(pkg)
    return packageAllowsFlows(pkg)
  }
  if (!state.folders.some((folder) => folder.key === entry.key && folder.package === pkg)) return false
  let ancestor = parent
  while (ancestor !== null) {
    if (ancestor === entry.key) return false
    ancestor = state.folders.find((folder) => folder.key === ancestor)?.parentId ?? null
  }
  return true
}

function folderSubtreeKeys(state: FlowWorkspaceState, folderKey: string): Set<string> {
  const queue = [folderKey]
  const folderKeys = new Set<string>()
  while (queue.length) {
    const key = queue.pop()!
    folderKeys.add(key)
    for (const child of state.folders) if (child.parentId === key) queue.push(child.key)
  }
  return folderKeys
}

function retargetPackageSubtree(state: FlowWorkspaceState, folderKeys: ReadonlySet<string>, pkg: FlowPackageId): FlowWorkspaceState {
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
    if (document && isLevelDocument(document) && !(pkg === 'level' && folderSectionId(state, parent) === 'templates')) throw new Error('地图模板只能放在「地图模板」分类中。')
    if (document && isNavigationDocument(document) && !(pkg === 'level' && folderSectionId(state, parent) === 'dynamic-nav')) throw new Error('动态导航点只能放在「动态导航器」分类中。')
    if (document && isKitDocument(document) && !packageAllowsKits(pkg)) throw new Error('礼包只能放在「礼包」分类中。')
    if (document && isProgressDocument(document) && !packageAllowsProgress(pkg)) throw new Error('进度只能放在「进度」分类中。')
    if(document && isEntityDocument(document) && !packageAllowsEntities(pkg)) throw new Error('实体只能放在实体库中。')
    if (document && isItemDocument(document) && !packageAllowsItems(pkg)) throw new Error('物品只能放在「物品库」分类中。')
    if (document && isScriptDocument(document) && !packageAllowsScripts(pkg)) throw new Error('脚本只能放在「脚本」分类中。')
    if (document && !isKitDocument(document) && !isProgressDocument(document) && !isNavigationDocument(document) && !isItemDocument(document) && !isEntityDocument(document) && !isScriptDocument(document) && !packageAllowsFlows(pkg)) throw new Error('流程只能放在「故事流程」分类中。')
  }
  const name = entry.kind === 'folder' ? state.folders.find((folder) => folder.key === entry.key)!.name : state.documents.find((document) => document.key === entry.key)!.name
  requireAvailableName(state, name, pkg, parent, entry.key, entry.kind === 'folder' ? 'folder' : 'document')
  if (entry.kind === 'folder') {
    const movedFolderKeys = folderSubtreeKeys(state, entry.key)
    const next = {
      ...state,
      folders: state.folders.map((folder) => folder.key === entry.key ? { ...folder, parentId: parent, package: pkg } : folder),
    }
    const moved = retargetPackageSubtree(next, movedFolderKeys, pkg)
    for (const doc of moved.documents) {
      if (!doc.folderId || !movedFolderKeys.has(doc.folderId) || isBuiltinScriptDocumentKey(doc.key) || isLibraryTableKey(doc.key)) continue
      requireAvailableName(moved, doc.name, doc.package, doc.folderId, doc.key)
    }
    return moved
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

/** 「物品库 / 物品库表视图」虚拟文档（稳定键，不落盘）。 */
export function itemLibraryTableDocument() {
  return stampDocument({
    key: ITEM_LIBRARY_TABLE_KEY,
    name: '物品库表视图',
    source: '',
    package: 'items',
    folderId: null,
  }, false)
}

/** 把虚拟表视图叠进工作区（不落盘）；资源树同级会排在文件夹之前。 */
export function withLibraryTables(state: FlowWorkspaceState): FlowWorkspaceState {
  const missing=[itemLibraryTableDocument(),stampDocument({key:ENTITY_LIBRARY_TABLE_KEY,name:'实体库表视图',source:'',package:'entities',folderId:null},false)].filter(d=>!state.documents.some(existing=>existing.key===d.key))
  return missing.length?{...state,documents:[...missing,...state.documents]}:state
}
export function stripLibraryTables(state: FlowWorkspaceState): FlowWorkspaceState {
  return {...state,documents:state.documents.filter(document=>!isLibraryTableKey(document.key))}
}
