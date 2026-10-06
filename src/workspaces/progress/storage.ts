import { ensurePackageSections } from './library'
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
export type FlowWorkspaceState = { documents: FlowDocument[]; folders: FlowFolder[]; activeKey: string | null; openKeys?: string[] }

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
  const openRaw = Array.isArray(state.openKeys) ? state.openKeys.filter((key): key is string => typeof key === 'string') : []
  const isTabPackage = (pkg: FlowPackageId) => pkg === 'gift' || pkg === 'script'
  const openKeys = [...new Set(openRaw.filter((key) => documents.some((document) => document.key === key && isTabPackage(document.package))))]
  const activeDoc = activeKey ? documents.find((document) => document.key === activeKey) : undefined
  if (activeDoc && isTabPackage(activeDoc.package) && !openKeys.includes(activeKey!)) openKeys.push(activeKey!)
  return { documents, folders: typedFolders, activeKey, openKeys }
}

export function loadFlowWorkspace(): { state: FlowWorkspaceState; error: string } {
  try {
    const raw = localStorage.getItem(FLOW_STORAGE_KEY)
    if (raw !== null) return { state: ensurePackageSections(readState(raw)), error: '' }
    const doc = createFlowDocument()
    return { state: ensurePackageSections({ documents: [doc], folders: [], activeKey: doc.key }), error: '' }
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
