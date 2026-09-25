/**
 * MC 皮肤站 IPC 契约 — 与 Rust 侧 DTO 一一对应(camelCase JSON)。
 * 纯类型与常量,不引入任何 Node 内置模块,可安全进入浏览器 bundle。
 */

export type SkinModel = 'classic' | 'slim'

export interface Capabilities {
  toolVersion: string
  formatVersion: number
  importKinds: ['png-file', 'png-url', 'player-name', 'skin-code', 'skin-file']
  liveApply: boolean
}

/* ---------- tags (flat in v3) ---------- */

export interface TagNode {
  tagId: string
  name: string
  /** Legacy; new UI treats tags as flat. */
  parentId: string | null
  sortOrder: number
}

export interface TagWithStats extends TagNode {
  directCount: number
  subtreeCount: number
  path: string[]
}

export interface TagTreeResponse {
  revision: number
  tags: TagWithStats[]
}

export interface CreateTagRequest {
  name: string
  parentId?: string | null
  expectedRevision?: number
}

export interface PatchTagRequest {
  expectedRevision?: number
  name?: string
  parentId?: string | null
  sortOrder?: number
  sortSiblingsByName?: boolean
}

/* ---------- folders ---------- */

export interface FolderNode {
  folderId: string
  name: string
  parentId: string | null
  sortOrder: number
}

export interface FolderWithStats extends FolderNode {
  directCount: number
  subtreeCount: number
  path: string[]
}

export interface FolderTreeResponse {
  revision: number
  folders: FolderWithStats[]
}

export interface CreateFolderRequest {
  name: string
  parentId?: string | null
}

export interface PatchFolderRequest {
  name?: string
  parentId?: string | null
  sortOrder?: number
  sortSiblingsByName?: boolean
}

/* ---------- library entries ---------- */

export type EntrySource =
  | { kind: 'png-file'; fileName?: string }
  | { kind: 'png-url'; url: string }
  | { kind: 'player-name'; playerName: string; uuid?: string }
  | { kind: 'skin-code' }
  | { kind: 'skin-file'; fileName?: string }

export interface LibraryEntry {
  entryId: string
  skinId: string
  name: string
  tagIds: string[]
  folderId: string | null
  favorite: boolean
  model: SkinModel
  source: EntrySource
  createdAt: string
  updatedAt: string
  revision: number
}

export type TagScope = 'subtree' | 'direct'
export type TagMatch = 'any' | 'all'

export interface LibraryQuery {
  search?: string
  tagIds?: string[]
  tagScope?: TagScope
  tagMatch?: TagMatch
  untagged?: boolean
  favorite?: boolean
  folderId?: string | null
  includeSubfolders?: boolean
  page?: number
  pageSize?: number
}

export interface LibraryPage {
  entries: LibraryEntry[]
  total: number
  page: number
  pageSize: number
}

/* ---------- imports ---------- */

export type ImportKind = 'png-file' | 'png-url' | 'player-name' | 'skin-code' | 'skin-file'

export type ImportJobState =
  | 'queued'
  | 'fetching'
  | 'validating'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface ImportJob {
  jobId: string
  kind: ImportKind
  state: ImportJobState
  error?: { code: string; message: string }
  result?: {
    skinId: string
    model: SkinModel
    suggestedName: string
    skinCode: string
    suggestedTagPaths?: string[][]
  }
  createdAt: string
  updatedAt: string
  seq: number
}

export interface SaveEntryRequest {
  jobId: string
  name: string
  tagIds?: string[]
  tagPaths?: string[][]
  folderId?: string | null
  favorite?: boolean
}

export interface PatchEntryRequest {
  revision: number
  name?: string
  tagIds?: string[]
  addTagIds?: string[]
  removeTagIds?: string[]
  favorite?: boolean
  folderId?: string | null
}

export interface BatchPatchRequest {
  entryIds: string[]
  addTagIds?: string[]
  removeTagIds?: string[]
  folderId?: string | null
}

export interface BatchPatchResponse {
  updated: number
  revision: number
}

/* ---------- events ---------- */

export type SkinEvent =
  | { type: 'job-updated'; jobId: string; seq: number; state: ImportJobState }
  | { type: 'library-updated'; revision: number; domain: 'entries' | 'tags' | 'folders' }

/* ---------- errors ---------- */

export interface CommandErrorShape {
  code: string
  message: string
  retryAfterMs?: number
}

export class SkinApiError extends Error {
  readonly code: string
  readonly retryAfterMs?: number

  constructor(shape: CommandErrorShape) {
    super(shape.message)
    this.name = 'SkinApiError'
    this.code = shape.code
    this.retryAfterMs = shape.retryAfterMs
  }
}
