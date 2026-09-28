import type { FlowWorkspaceState } from './storage'

export type FlowEntry = { kind: 'root' } | { kind: 'folder' | 'document'; key: string }
export const entryId = (entry: FlowEntry) => entry.kind === 'root' ? 'root' : `${entry.kind}:${entry.key}`
export const entryFolder = (state: FlowWorkspaceState, entry: FlowEntry): string | null => entry.kind === 'root' ? null : entry.kind === 'folder' ? entry.key : state.documents.find((d) => d.key === entry.key)?.folderId ?? null

export function resourceName(value: string, document = false) {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32) || /[. ]$/.test(name)) throw new Error('请输入有效名称，不可包含路径分隔符或特殊字符。')
  return document && !name.toLowerCase().endsWith('.hflow') ? `${name}.hflow` : name
}
function requireFolder(state: FlowWorkspaceState, parent: string | null) {
  if (parent !== null && !state.folders.some((f) => f.key === parent)) throw new Error('目标文件夹不存在。')
}
export function requireAvailableName(state: FlowWorkspaceState, name: string, parent: string | null, except?: string) {
  requireFolder(state, parent)
  const same = (other: string) => other.normalize('NFC').toLocaleLowerCase() === name.normalize('NFC').toLocaleLowerCase()
  if (state.folders.some((f) => f.key !== except && f.parentId === parent && same(f.name)) || state.documents.some((d) => d.key !== except && (d.folderId ?? null) === parent && same(d.name))) throw new Error('此文件夹中已有同名资源。')
}
export function uniqueDocumentName(state: FlowWorkspaceState, name: string, parent: string | null) {
  const normalized = resourceName(name, true), stem = normalized.slice(0, -6)
  let candidate = normalized, index = 2
  for (;;) {
    try { requireAvailableName(state, candidate, parent); return candidate }
    catch (error) { requireFolder(state, parent); if (!(error instanceof Error) || !error.message.includes('同名')) throw error }
    candidate = `${stem} (${index++}).hflow`
  }
}
export function addFlowFolder(state: FlowWorkspaceState, value: string, parentId: string | null) {
  const name = resourceName(value)
  requireAvailableName(state, name, parentId)
  const folder = { key: crypto.randomUUID(), name, parentId }
  return { state: { ...state, folders: [...state.folders, folder] }, folder }
}
export function renameFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, value: string): FlowWorkspaceState {
  if (entry.kind === 'root') return state
  const item = entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key) : state.documents.find((d) => d.key === entry.key)
  if (!item) throw new Error('资源不存在。')
  const name = resourceName(value, entry.kind === 'document')
  const parent = entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key)!.parentId : state.documents.find((d) => d.key === entry.key)!.folderId ?? null
  requireAvailableName(state, name, parent, entry.key)
  return entry.kind === 'folder' ? { ...state, folders: state.folders.map((f) => f.key === entry.key ? { ...f, name } : f) } : { ...state, documents: state.documents.map((d) => d.key === entry.key ? { ...d, name } : d) }
}
export function canMoveFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, parent: string | null) {
  if (entry.kind === 'root' || (parent !== null && !state.folders.some((f) => f.key === parent))) return false
  if (entry.kind === 'document') return state.documents.some((d) => d.key === entry.key)
  if (!state.folders.some((f) => f.key === entry.key)) return false
  let ancestor = parent
  while (ancestor !== null) {
    if (ancestor === entry.key) return false
    ancestor = state.folders.find((f) => f.key === ancestor)?.parentId ?? null
  }
  return true
}
export function moveFlowEntry(state: FlowWorkspaceState, entry: FlowEntry, parent: string | null): FlowWorkspaceState {
  if (!canMoveFlowEntry(state, entry, parent) || entry.kind === 'root') throw new Error('不能移动到自身或自己的子文件夹。')
  const name = entry.kind === 'folder' ? state.folders.find((f) => f.key === entry.key)!.name : state.documents.find((d) => d.key === entry.key)!.name
  requireAvailableName(state, name, parent, entry.key)
  return entry.kind === 'folder' ? { ...state, folders: state.folders.map((f) => f.key === entry.key ? { ...f, parentId: parent } : f) } : { ...state, documents: state.documents.map((d) => d.key === entry.key ? { ...d, folderId: parent } : d) }
}
export const isFolderEmpty = (state: FlowWorkspaceState, key: string) => !state.folders.some((f) => f.parentId === key) && !state.documents.some((d) => d.folderId === key)
export function folderPath(state: FlowWorkspaceState, key: string | null): string {
  const parts: string[] = []
  while (key !== null) { const folder = state.folders.find((f) => f.key === key); if (!folder) break; parts.unshift(folder.name); key = folder.parentId }
  return ['进度流程', ...parts].join(' / ')
}
