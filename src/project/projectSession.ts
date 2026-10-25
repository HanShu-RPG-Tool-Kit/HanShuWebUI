import {EXPLORER_ORGANIZATION_PATH,serializeOrganization,parseOrganization} from './explorerOrganization'
import {resourceTypeForExtension,GAMEPLAY_CATEGORIES,categoryExtensions,type GameplayCategoryId} from '../resourceTypes'
import {scriptType,scriptSection} from '../scriptResources/types'
/**
 * 跨工作区共享的「当前工程」会话：剧本与进度读写同一 Workspace / 绑定目录。
 * Virtual Cache 不再作为正式编辑态；未绑定工程时 binding 为 null、packages 为空。
 */

import { useSyncExternalStore } from 'react'
import { rememberProjectDraft } from './drafts'
import type { BoundProject } from './projectFs'
import {
  emptyWorkspace,
  type SourceFile,
  type Workspace,
} from '../workspace'
import { getExtension } from '../workspace'
import { sourcePathOf } from '../workspace'
import { assetCacheEpoch } from '../assets/idb'
import {scriptTypeInFolder} from '../workspaces/gameplay/library'
import { sectionFolderKey } from '../workspaces/gameplay/library'
import type {
  FlowDocument,
  FlowFolder,
  FlowPackageId,
  FlowWorkspaceState,
} from '../workspaces/gameplay/storage'
import { stampDocument } from '../workspaces/gameplay/storage'

export const PROGRESS_UI_STORAGE_KEY = 'hanshu.gameplayUi.v2'
/** 旧整库草稿；迁入工程后删除 */
export const LEGACY_PROGRESS_WORKSPACE_KEY = 'hanshu.progressWorkspace.v1'

/** 进度工作区认领的源文件后缀（含目标定义用的 .py） */
export const PROGRESS_SOURCE_EXTS = new Set(
  (Object.keys(GAMEPLAY_CATEGORIES) as GameplayCategoryId[]).flatMap(categoryExtensions),
)

/** 剧本资源树展示的 kind（不含进度专属目录） */
export const SCRIPT_EXPLORER_KINDS = new Set([
  'hanshu',
  'character',
  'script',
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
  const previousWorkspace = session.workspace
  session = {
    workspace: next.workspace ?? session.workspace,
    binding: next.binding !== undefined ? next.binding : session.binding,
  }
  if (next.workspace && session.binding) rememberProjectDraft(session.workspace)
  const client = session.binding?.handle.client
  if (client) {
    client.transactions.setDirtyPaths(session.workspace.packages.flatMap(p => [
      ...p.scripts.filter(s => !s.detached && s.content !== client.texts.get(sourcePathOf(s))).map(sourcePathOf),
      ...p.assets.filter(a => client.assetEpochs.get(a.path) !== assetCacheEpoch(p.id, a.path)).map(a => a.path),
      ...(p.name !== session.binding?.manifest.name ? ['project.json'] : []),
      ...(p.explorer&&serializeOrganization(p.explorer)!==serializeOrganization(parseOrganization(client.texts.get(EXPLORER_ORGANIZATION_PATH)??null))?[EXPLORER_ORGANIZATION_PATH]:[]),
    ]))
    if (next.workspace && next.workspace !== previousWorkspace) client.transactions.changed()
  }
  emit()
}

export function useProjectSession(): Session {
  return useSyncExternalStore(subscribeProjectSession, getProjectSession, getProjectSession)
}

export function packageIdOfExt(ext: string): FlowPackageId | null {
  const category=resourceTypeForExtension(ext)?.category
  return category && PROGRESS_SOURCE_EXTS.has(ext.toLowerCase()) ? category as FlowPackageId : null
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
    const fromUi = documentFolders?.[source.id]
    const folderId =
      typeof fromUi === 'string' && fromUi
        ? fromUi
        : getExtension(source.name)==='.py'
          ? sectionFolderKey('script',scriptSection(scriptType(source.srcKind)))
          : null
    docs.push(stampDocument({
      key: source.id, detached:source.detached,
      name: source.name,
      source: source.content,
      package: pkg,
      folderId,
      createdAt: undefined,
      updatedAt: new Date(source.updatedAt).toISOString(),
    }))
  }
  return docs
}

export function applyProgressDocumentsToWorkspace(
  workspace: Workspace,
  documents: FlowDocument[],
  folders: FlowFolder[] = [],
): Workspace {
  const pkg = workspace.packages[0]
  if (!pkg) return workspace
  const kept = pkg.scripts.filter((item) => !isProgressSourceName(item.name))
  const folderState = {
    documents,
    folders,
    openKeys: [] as string[],
    activeKey: null,
    pinnedKeys: [] as string[],
  }
  const nextSources: SourceFile[] = [
    ...kept,
    ...documents.map((doc) => {
      const srcKind=getExtension(doc.name)==='.py'?scriptTypeInFolder(folderState,doc.folderId??null):undefined
      return {
        id: doc.key, detached:doc.detached,
        name: doc.name,
        content: doc.source,
        updatedAt: doc.updatedAt ? Date.parse(doc.updatedAt) || Date.now() : Date.now(),
        ...(srcKind ? { srcKind } : {}),
      }
    }),
  ]
  return {
    ...workspace,
    packages: [{ ...pkg, scripts: nextSources }],
  }
}

/** Personal view state; shared folders never belong in this cache. */
export type ProgressUiState = Pick<FlowWorkspaceState, 'openKeys' | 'activeKey' | 'pinnedKeys' | 'split'>
const EMPTY_PROGRESS_UI: ProgressUiState = {openKeys:[],activeKey:null,pinnedKeys:[]}

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
    }
  } catch {
    return { ...EMPTY_PROGRESS_UI }
  }
}

export function saveProgressUiState(state: ProgressUiState) {
  const {openKeys,activeKey,pinnedKeys,split}=state
  localStorage.setItem(PROGRESS_UI_STORAGE_KEY, JSON.stringify({openKeys,activeKey,pinnedKeys,split}))
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
