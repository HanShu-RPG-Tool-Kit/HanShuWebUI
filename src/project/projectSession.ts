/**
 * 跨工作区共享的「当前工程」会话：剧本与进度读写同一 Workspace / 绑定目录。
 * Virtual Cache 不再作为正式编辑态；未绑定工程时 binding 为 null、packages 为空。
 */

import { useSyncExternalStore } from 'react'
import type { BoundProject } from './projectFs'
import {
  emptyWorkspace,
  type SourceFile,
  type Workspace,
} from '../workspace'
import { getExtension } from '../workspace'
import type { FlowDocument, FlowPackageId, FlowWorkspaceState } from '../workspaces/progress/storage'
import { stampDocument } from '../workspaces/progress/storage'

export const PROGRESS_UI_STORAGE_KEY = 'hanshu.progressUi.v1'
/** 旧整库草稿；迁入工程后删除 */
export const LEGACY_PROGRESS_WORKSPACE_KEY = 'hanshu.progressWorkspace.v1'

/** 进度工作区认领的源文件后缀（含目标定义用的 .py） */
export const PROGRESS_SOURCE_EXTS = new Set([
  '.progress',
  '.hflow',
  '.nav',
  '.kit',
  '.py',
])

/** 剧本资源树展示的 kind（不含进度专属目录） */
export const SCRIPT_EXPLORER_KINDS = new Set([
  'hanshu',
  'character',
  'scripts',
  'meta',
  'root',
])

type Session = {
  workspace: Workspace
  binding: BoundProject | null
}

let session: Session = {
  workspace: emptyWorkspace(),
  binding: null,
}

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getProjectSession(): Session {
  return session
}

export function subscribeProjectSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function setProjectSession(next: Partial<Session>) {
  session = {
    workspace: next.workspace ?? session.workspace,
    binding: next.binding !== undefined ? next.binding : session.binding,
  }
  emit()
}

export function useProjectSession(): Session {
  return useSyncExternalStore(subscribeProjectSession, getProjectSession, getProjectSession)
}

export function packageIdOfExt(ext: string): FlowPackageId | null {
  switch (ext.toLowerCase()) {
    case '.progress': return 'progress'
    case '.hflow': return 'story'
    case '.nav': return 'navigator'
    case '.kit': return 'gift'
    case '.py': return 'script'
    default: return null
  }
}

export function isProgressSourceName(name: string): boolean {
  return PROGRESS_SOURCE_EXTS.has(getExtension(name))
}

/** 文档在资源树中的文件夹归属（仅视图；磁盘/lang 仍按文件名扁平）。 */
export type ProgressDocumentFolders = Record<string, string | null>

export function sourcesToProgressDocuments(
  sources: SourceFile[],
  documentFolders?: ProgressDocumentFolders,
): FlowDocument[] {
  const docs: FlowDocument[] = []
  for (const source of sources) {
    const pkg = packageIdOfExt(getExtension(source.name))
    if (!pkg) continue
    const folderId = documentFolders?.[source.id]
    docs.push(stampDocument({
      key: source.id,
      name: source.name,
      source: source.content,
      package: pkg,
      folderId: typeof folderId === 'string' ? folderId : null,
      createdAt: undefined,
      updatedAt: new Date(source.updatedAt).toISOString(),
    }))
  }
  return docs
}

export function applyProgressDocumentsToWorkspace(
  workspace: Workspace,
  documents: FlowDocument[],
): Workspace {
  const pkg = workspace.packages[0]
  if (!pkg) return workspace
  const kept = pkg.scripts.filter((item) => !isProgressSourceName(item.name))
  const nextSources: SourceFile[] = [
    ...kept,
    ...documents.map((doc) => ({
      id: doc.key,
      name: doc.name,
      content: doc.source,
      updatedAt: doc.updatedAt ? Date.parse(doc.updatedAt) || Date.now() : Date.now(),
    })),
  ]
  return {
    ...workspace,
    packages: [{ ...pkg, scripts: nextSources }],
  }
}

export type ProgressUiState = Pick<FlowWorkspaceState, 'openKeys' | 'activeKey' | 'pinnedKeys' | 'split' | 'folders'> & {
  /** documentKey → folderId；缺省或 null 表示分类根 */
  documentFolders?: ProgressDocumentFolders
}

const EMPTY_PROGRESS_UI: ProgressUiState = {
  openKeys: [],
  activeKey: null,
  pinnedKeys: [],
  folders: [],
  documentFolders: {},
}

function readDocumentFolders(value: unknown): ProgressDocumentFolders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: ProgressDocumentFolders = {}
  for (const [key, folderId] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue
    out[key] = typeof folderId === 'string' && folderId ? folderId : null
  }
  return out
}

export function documentFoldersFromDocuments(documents: FlowDocument[]): ProgressDocumentFolders {
  const out: ProgressDocumentFolders = {}
  for (const doc of documents) {
    out[doc.key] = doc.folderId ?? null
  }
  return out
}

export function loadProgressUiState(): ProgressUiState {
  try {
    const raw = localStorage.getItem(PROGRESS_UI_STORAGE_KEY)
    if (!raw) return { ...EMPTY_PROGRESS_UI }
    const data = JSON.parse(raw) as ProgressUiState
    return {
      openKeys: Array.isArray(data.openKeys) ? data.openKeys : [],
      activeKey: data.activeKey ?? null,
      pinnedKeys: Array.isArray(data.pinnedKeys) ? data.pinnedKeys : [],
      split: data.split,
      folders: Array.isArray(data.folders) ? data.folders : [],
      documentFolders: readDocumentFolders(data.documentFolders),
    }
  } catch {
    return { ...EMPTY_PROGRESS_UI }
  }
}

export function saveProgressUiState(state: ProgressUiState) {
  localStorage.setItem(PROGRESS_UI_STORAGE_KEY, JSON.stringify(state))
}

/** 把旧 progressWorkspace.v1 文档并入工程源文件（按文件名去重），然后删除旧键。 */
export function consumeLegacyProgressWorkspace(workspace: Workspace): Workspace {
  try {
    const raw = localStorage.getItem(LEGACY_PROGRESS_WORKSPACE_KEY)
    if (!raw) return workspace
    const data = JSON.parse(raw) as { documents?: FlowDocument[] }
    const documents = Array.isArray(data.documents) ? data.documents : []
    if (!documents.length) {
      localStorage.removeItem(LEGACY_PROGRESS_WORKSPACE_KEY)
      return workspace
    }
    const pkg = workspace.packages[0]
    if (!pkg) return workspace
    const existing = new Set(pkg.scripts.map((item) => item.name.toLowerCase()))
    const added: SourceFile[] = []
    for (const doc of documents) {
      if (!doc?.name || !PROGRESS_SOURCE_EXTS.has(getExtension(doc.name))) continue
      if (existing.has(doc.name.toLowerCase())) continue
      existing.add(doc.name.toLowerCase())
      added.push({
        id: doc.key || `src_${Math.random().toString(36).slice(2, 9)}`,
        name: doc.name,
        content: typeof doc.source === 'string' ? doc.source : '',
        updatedAt: Date.now(),
      })
    }
    localStorage.removeItem(LEGACY_PROGRESS_WORKSPACE_KEY)
    if (!added.length) return workspace
    return {
      ...workspace,
      packages: [{ ...pkg, scripts: [...pkg.scripts, ...added] }],
    }
  } catch {
    return workspace
  }
}

export function ensureProgressPlaceholderFolders(
  folders: FlowWorkspaceState['folders'],
): FlowWorkspaceState['folders'] {
  return folders
}
