/**
 * SkinApi — 领域接口。组件只调用这些方法,不直接 import Tauri API。
 * invoke 的 Promise 不能直接填进 <img src>:预览走 getPreviewUrl 的
 * object URL 缓存,淘汰时释放。
 */

import type {
  BatchPatchRequest,
  BatchPatchResponse,
  Capabilities,
  CreateFolderRequest,
  EntryExport,
  FolderNode,
  FolderTreeResponse,
  ImportJob,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  PatchEntryRequest,
  PatchFolderRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
  TagListResponse,
  UsableManifest,
} from '../contracts/types.ts'

/** 清理黑户进度（用于锁定弹窗进度条）。 */
export interface GcOrphansProgress {
  phase: 'scanning' | 'objects' | 'previews' | 'done'
  /** 当前阶段已处理数 */
  current: number
  /** 当前阶段总数；未知时为 0 */
  total: number
  label: string
}

export interface SkinApi {
  capabilities(): Promise<Capabilities>
  listEntries(query: LibraryQuery): Promise<LibraryPage>
  /** Direct entry lookup — details must not depend on the current page cache. */
  getEntry(entryId: string): Promise<LibraryEntry>
  /** Auto-collected unique tags from all entries. */
  listTags(): Promise<TagListResponse>
  /** Rename a tag across every entry that uses it. */
  renameTag(from: string, to: string): Promise<{ affectedEntries: number }>
  /** Remove a tag name from every entry. */
  deleteTag(name: string): Promise<{ affectedEntries: number }>
  listFolders(): Promise<FolderTreeResponse>
  createFolder(body: CreateFolderRequest): Promise<FolderNode>
  patchFolder(folderId: string, body: PatchFolderRequest): Promise<FolderNode>
  deleteFolder(folderId: string): Promise<{ deleted: boolean }>
  /** Delete every entry in the folder and its descendant folders (nodes kept). */
  deleteEntriesInFolder(folderId: string): Promise<{ deleted: number }>
  saveEntry(body: SaveEntryRequest): Promise<LibraryEntry>
  patchEntry(entryId: string, body: PatchEntryRequest): Promise<LibraryEntry>
  batchPatchEntries(body: BatchPatchRequest): Promise<BatchPatchResponse>
  deleteEntry(entryId: string): Promise<{ deleted: boolean }>
  startImport(
    kind: 'png-url' | 'player-name' | 'skin-code' | 'skin-file',
    text: string,
    model?: SkinModel,
  ): Promise<{ jobId: string }>
  /** Desktop: native path from the dialog plugin. */
  importFile(path: string, model?: SkinModel): Promise<{ jobId: string }>
  /** Browser: upload bytes (multipart); the server never takes raw paths. */
  importFileBlob(file: File, model?: SkinModel): Promise<{ jobId: string }>
  getImport(jobId: string): Promise<ImportJob>
  listImports(): Promise<ImportJob[]>
  cancelImport(jobId: string): Promise<ImportJob>
  /** Object URL for a preview PNG (cached per skinId; released on evict). */
  getPreviewUrl(skinId: string): Promise<string>
  getSkinCode(skinId: string): Promise<string>
  exportSkin(
    skinId: string,
    format: 'png' | 'skin' | 'hskin' | 'skin-json',
  ): Promise<{ text?: string; pngBase64?: string; skinBase64?: string }>
  /** Portable export by entryId; v3 (default) carries full metadata. */
  exportEntry(entryId: string, format?: 'v3' | 'v2'): Promise<EntryExport>
  /** Manifest of active entries — the verifiable consumer of `active`. */
  exportUsableManifest(): Promise<UsableManifest>
  /** Save an export to a user-chosen path via the native save dialog. */
  saveExportFile(skinId: string, format: 'png' | 'skin' | 'hskin'): Promise<void>
  /**
   * 清理无条目引用的 objects（黑户）与孤立 preview 缓存。
   * 未保存的 import job 结果仍保留。
   * `onProgress` 用于 UI 锁定弹窗；应尽量频繁回调。
   */
  gcOrphans(
    onProgress?: (p: GcOrphansProgress) => void,
  ): Promise<{
    removedObjects: number
    removedPreviews: number
    protectedCount: number
  }>
  subscribe(listener: (event: SkinEvent) => void): Promise<() => void>
}
