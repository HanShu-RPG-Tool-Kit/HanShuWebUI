import { ensurePackageSections } from './library'
import { normalizeGroups } from './editorGroups'
import { createFlow, isObject, parseFlow } from './model'
import { parseJsonValue } from '../../utils/strictJson'

export const FLOW_STORAGE_KEY = 'hanshu.progressWorkspace.v1'
export type FlowPackageId = 'script' | 'progress' | 'story' | 'actor' | 'reputation' | 'region' | 'navigator' | 'shop' | 'gift'
export type FlowDocument = {
  key: string
  name: string
  source: string
  package: FlowPackageId
  folderId?: string | null
  createdAt?: string
  updatedAt?: string
}
export type FlowFolder = { key: string; name: string; parentId: string | null; package: FlowPackageId }
export type FlowSplitDirection = 'horizontal' | 'vertical'

/** 编辑组：一条页条及其当前页。 */
export type FlowEditorGroup = { openKeys: string[]; activeKey: string | null; pinnedKeys: string[] }

/** 第二个编辑组（右侧 / 下方）；`focus` 为当前焦点组，0 为根上的主组。 */
export type FlowEditorSplit = {
  group: FlowEditorGroup
  /** horizontal = 左右，vertical = 上下 */
  direction: FlowSplitDirection
  /** 主组占比 0.2–0.8 */
  ratio: number
  focus: 0 | 1
}

export type FlowWorkspaceState = {
  documents: FlowDocument[]
  folders: FlowFolder[]
  /** 主组（左侧 / 上侧）当前页 */
  activeKey: string | null
  /** 主组页条，顺序即显示顺序；含流程 / 脚本 / 礼包。 */
  openKeys?: string[]
  /** 主组固定页；关闭操作会跳过，须先取消固定。 */
  pinnedKeys?: string[]
  split?: FlowEditorSplit | null
}

const PACKAGE_IDS = new Set<FlowPackageId>(['script', 'progress', 'story', 'actor', 'reputation', 'region', 'navigator', 'shop', 'gift'])
const readPackage = (value: unknown): FlowPackageId => typeof value === 'string' && PACKAGE_IDS.has(value as FlowPackageId) ? value as FlowPackageId : 'story'

export function stampDocument(document: FlowDocument, touch = true): FlowDocument {
  const now = new Date().toISOString()
  return { ...document, createdAt: document.createdAt ?? now, updatedAt: touch ? now : document.updatedAt ?? document.createdAt ?? now }
}

export const createFlowDocument = (flow = createFlow(), pkg: FlowPackageId = 'story'): FlowDocument => stampDocument({
  key: crypto.randomUUID(),
  name: `${(flow.entry.title.text.trim() || flow.id).replace(/[\\/:*?"<>|]/g, '_')}.hflow`,
  source: JSON.stringify(flow, null, 2),
  package: pkg,
})

function readState(raw: string): FlowWorkspaceState {
  const state = parseJsonValue(raw)
  if (!isObject(state) || !Array.isArray(state.documents) || !state.documents.every((d) => isObject(d) && typeof d.key === 'string' && typeof d.name === 'string' && typeof d.source === 'string')) throw new Error('本地草稿库结构不正确')
  const documents = (state.documents as FlowDocument[]).map((document) => {
    const createdAt = typeof document.createdAt === 'string' ? document.createdAt : undefined
    const updatedAt = typeof document.updatedAt === 'string' ? document.updatedAt : undefined
    return { ...document, package: readPackage(document.package), createdAt, updatedAt }
  })
  if (new Set(documents.map((d) => d.key)).size !== documents.length) throw new Error('草稿标识重复')
  const folders = state.folders ?? []
  if (!Array.isArray(folders) || !folders.every((f) => isObject(f) && typeof f.key === 'string' && typeof f.name === 'string' && (f.parentId === null || typeof f.parentId === 'string'))) throw new Error('文件夹结构不正确')
  const typedFolders = (folders as FlowFolder[]).map((folder) => ({ ...folder, package: readPackage(folder.package) }))
  const parents = new Map(typedFolders.map((f) => [f.key, f.parentId]))
  if (parents.size !== folders.length || documents.some((d) => parents.has(d.key))) throw new Error('资源标识重复')
  for (const folder of typedFolders) {
    const seen = new Set([folder.key])
    let parent = folder.parentId
    while (parent !== null) {
      if (!parents.has(parent) || seen.has(parent)) throw new Error('文件夹父级不存在或形成循环')
      seen.add(parent); parent = parents.get(parent)!
    }
  }
  for (const folder of typedFolders) {
    if (folder.parentId !== null) {
      const parent = typedFolders.find((item) => item.key === folder.parentId)
      if (!parent || parent.package !== folder.package) throw new Error('文件夹分类不一致')
    }
  }
  if (documents.some((d) => d.folderId !== undefined && d.folderId !== null && (typeof d.folderId !== 'string' || !parents.has(d.folderId)))) throw new Error('流程所在文件夹不存在')
  if (documents.some((d) => {
    if (d.folderId === undefined || d.folderId === null) return false
    const folder = typedFolders.find((item) => item.key === d.folderId)
    return !folder || folder.package !== d.package
  })) throw new Error('流程分类与文件夹不一致')
  const activeKey = documents.some((d) => d.key === state.activeKey) ? state.activeKey as string : documents[0]?.key ?? null
  const docKeys = new Set(documents.map((document) => document.key))
  const openRaw = Array.isArray(state.openKeys) ? state.openKeys.filter((key): key is string => typeof key === 'string') : []
  const openKeys = [...new Set(openRaw.filter((key) => docKeys.has(key)))]
  if (activeKey && !openKeys.includes(activeKey)) openKeys.push(activeKey)
  const pinnedRaw = Array.isArray(state.pinnedKeys) ? state.pinnedKeys.filter((key): key is string => typeof key === 'string') : []
  const pinnedKeys = [...new Set(pinnedRaw.filter((key) => openKeys.includes(key)))]
  return normalizeGroups({ documents, folders: typedFolders, activeKey, openKeys, pinnedKeys, split: readSplit(state) })
}

const readStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function readSplit(state: Record<string, unknown>): FlowEditorSplit | null {
  const raw = state.split
  if (isObject(raw) && isObject(raw.group)) {
    return {
      group: {
        openKeys: readStrings(raw.group.openKeys),
        activeKey: typeof raw.group.activeKey === 'string' ? raw.group.activeKey : null,
        pinnedKeys: readStrings(raw.group.pinnedKeys),
      },
      direction: raw.direction === 'vertical' ? 'vertical' : 'horizontal',
      ratio: typeof raw.ratio === 'number' ? raw.ratio : 0.5,
      focus: raw.focus === 1 ? 1 : 0,
    }
  }
  // 早期草稿只记了副格的单个文档
  if (typeof state.splitKey === 'string') {
    return {
      group: { openKeys: [state.splitKey], activeKey: state.splitKey, pinnedKeys: [] },
      direction: state.splitDirection === 'vertical' ? 'vertical' : 'horizontal',
      ratio: typeof state.splitRatio === 'number' ? state.splitRatio : 0.5,
      focus: state.splitFocus === 'secondary' ? 1 : 0,
    }
  }
  return null
}

export function loadFlowWorkspace(): { state: FlowWorkspaceState; error: string } {
  try {
    const raw = localStorage.getItem(FLOW_STORAGE_KEY)
    if (raw !== null) return { state: ensurePackageSections(readState(raw)), error: '' }
    const doc = createFlowDocument()
    return { state: ensurePackageSections({ documents: [doc], folders: [], activeKey: doc.key, openKeys: [doc.key], pinnedKeys: [] }), error: '' }
  } catch (error) { return { state: ensurePackageSections({ documents: [], folders: [], activeKey: null }), error: `无法读取草稿；原始存储未覆盖。${String(error)}` } }
}
export function saveFlowWorkspace(state: FlowWorkspaceState) { localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(state)) }
export function importFlowDocument(name: string, source: string, pkg: FlowPackageId = 'story'): FlowDocument {
  const flow = parseFlow(source.replace(/^\uFEFF/, ''))
  return { ...createFlowDocument(flow, pkg), name: name.replace(/\.(hflow|json)$/i, '') + '.hflow' }
}
export function downloadFlowFile(name: string, data: string | Blob) {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: 'application/json;charset=utf-8' }) : data)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name.replace(/[\\/:*?"<>|]/g, '_')
  document.body.append(anchor); anchor.click(); anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
