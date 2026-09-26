/**
 * MC 皮肤站 IPC 契约 — 与 Rust 侧 DTO 一一对应(camelCase JSON)。
 * 纯类型与常量,不引入任何 Node 内置模块,可安全进入浏览器 bundle。
 *
 * schema v5：标签为条目上的自由字符串；listTags 从全库条目自动收集。
 */

export type SkinModel = 'classic' | 'slim'

export interface Capabilities {
  toolVersion: string
  apiVersion: string
  librarySchemaVersion: number
  formatVersion: number
  importKinds: ['png-file', 'png-url', 'player-name', 'skin-code', 'skin-file']
  liveApply: boolean
  features: {
    batchActive: boolean
    httpApi: boolean
  }
}

/* ---------- tags (freeform strings collected from entries) ---------- */

/** Unique tag name + how many entries use it. Identity is the normalized name. */
export interface CollectedTag {
  name: string
  count: number
}

export interface TagListResponse {
  revision: number
  tags: CollectedTag[]
}

export interface RenameTagRequest {
  from: string
  to: string
  expectedRevision?: number
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

export interface LicenseInfo {
  status: 'unspecified' | 'declared'
  name: string | null
  url: string | null
  note: string | null
}

export interface Provenance {
  author: string | null
  sourceName: string | null
  sourceUrl: string | null
  sourceNote: string | null
  originalCreatedAt: string | null
}

export interface LibraryEntry {
  entryId: string
  skinId: string
  name: string
  active: boolean
  /** Freeform tag names attached to this skin (NFC + trim, unique per entry). */
  tags: string[]
  folderId: string | null
  favorite: boolean
  model: SkinModel
  source: EntrySource
  provenance: Provenance
  license: LicenseInfo
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

export type TagMatch = 'any' | 'all'
export type EntrySortBy = 'name' | 'createdAt' | 'updatedAt' | 'author'
export type SortDirection = 'asc' | 'desc'
export type EntryScope = 'all' | 'unfiled' | 'folder'

export interface LibraryQuery {
  search?: string
  /** Include entries that match these tag names. */
  tags?: string[]
  excludeTags?: string[]
  tagMatch?: TagMatch
  untagged?: boolean
  favorite?: boolean
  active?: boolean
  models?: SkinModel[]
  includeLicenseNames?: string[]
  excludeLicenseNames?: string[]
  /** true → only unspecified licenses; false → only declared. */
  licenseUnspecified?: boolean
  author?: string
  createdFrom?: string
  createdTo?: string
  scope?: EntryScope
  folderId?: string | null
  includeSubfolders?: boolean
  sortBy?: EntrySortBy
  sortDirection?: SortDirection
  page?: number
  pageSize?: number
}

export interface LibraryPage {
  entries: LibraryEntry[]
  total: number
  page: number
  pageSize: number
  revision: number
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
    suggestedActive?: boolean
    suggestedLicense?: LicenseInfo
    suggestedProvenance?: Provenance
    suggestedNote?: string
  }
  createdAt: string
  updatedAt: string
  seq: number
}

export interface SaveEntryRequest {
  jobId: string
  name: string
  tags?: string[]
  /** Portable import alias — flattened to freeform `tags`. */
  tagPaths?: string[][]
  folderId?: string | null
  favorite?: boolean
  active?: boolean
  license?: LicenseInfo
  provenance?: Provenance
  note?: string
}

export interface PatchEntryRequest {
  revision: number
  name?: string
  tags?: string[]
  addTags?: string[]
  removeTags?: string[]
  favorite?: boolean
  folderId?: string | null
  active?: boolean
  model?: SkinModel
  license?: LicenseInfo
  provenance?: Provenance
  note?: string
}

export interface BatchPatchRequest {
  entryIds: string[]
  addTags?: string[]
  removeTags?: string[]
  folderId?: string | null
  active?: boolean
  /** Expected revisions per entry; must match entryIds length when provided. */
  expectedRevisions?: number[]
}

export interface BatchPatchResponse {
  updated: number
  revision: number
  conflicts?: Array<{ entryId: string; expectedRevision: number; actualRevision: number }>
}

/* ---------- portable files ---------- */

export interface PortableSkinFileV3 {
  schemaVersion: 3
  name: string
  skinId: string
  skinCode: string
  model: SkinModel
  tagPaths: string[][]
  active: boolean
  license: LicenseInfo
  provenance: Provenance
  note: string
}

export interface PortableSkinFileV2 {
  schemaVersion: 2
  name: string
  tagPaths: string[][]
  skinId: string
  skinCode: string
}

export interface PortableSkinFileV1 {
  schemaVersion: 1
  name: string
  tags: string[]
  skinId: string
  skinCode: string
}

/** Entry export: v3 by default, v2 via explicit format. */
export type EntryExport = PortableSkinFileV3 | PortableSkinFileV2

/* ---------- usable manifest ---------- */

export interface UsableManifestItem {
  entryId: string
  skinId: string
  name: string
  model: SkinModel
  author: string | null
  license: LicenseInfo
  provenance: Provenance
}

export interface UsableManifest {
  entries: UsableManifestItem[]
  count: number
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
