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
  CreateTagRequest,
  FolderNode,
  FolderTreeResponse,
  ImportJob,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  PatchEntryRequest,
  PatchFolderRequest,
  PatchTagRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
  TagNode,
  TagTreeResponse,
} from '../contracts/types.ts'

export interface SkinApi {
  capabilities(): Promise<Capabilities>
  listEntries(query: LibraryQuery): Promise<LibraryPage>
  listTags(): Promise<TagTreeResponse>
  createTag(body: CreateTagRequest): Promise<TagNode>
  patchTag(tagId: string, body: PatchTagRequest): Promise<TagNode>
  deleteTag(
    tagId: string,
    mode: 'single' | 'branch',
    expectedRevision?: number,
  ): Promise<{ removedTagIds: string[]; affectedEntries: number }>
  listFolders(): Promise<FolderTreeResponse>
  createFolder(body: CreateFolderRequest): Promise<FolderNode>
  patchFolder(folderId: string, body: PatchFolderRequest): Promise<FolderNode>
  deleteFolder(folderId: string): Promise<{ deleted: boolean }>
  saveEntry(body: SaveEntryRequest): Promise<LibraryEntry>
  patchEntry(entryId: string, body: PatchEntryRequest): Promise<LibraryEntry>
  batchPatchEntries(body: BatchPatchRequest): Promise<BatchPatchResponse>
  deleteEntry(entryId: string): Promise<{ deleted: boolean }>
  startImport(
    kind: 'png-url' | 'player-name' | 'skin-code' | 'skin-file',
    text: string,
    model?: SkinModel,
  ): Promise<{ jobId: string }>
  importFile(path: string, model?: SkinModel): Promise<{ jobId: string }>
  getImport(jobId: string): Promise<ImportJob>
  listImports(): Promise<ImportJob[]>
  cancelImport(jobId: string): Promise<ImportJob>
  /** Object URL for a preview PNG (cached per skinId; released on evict). */
  getPreviewUrl(skinId: string): Promise<string>
  getSkinCode(skinId: string): Promise<string>
  exportSkin(
    skinId: string,
    format: 'png' | 'hskin' | 'skin-json',
  ): Promise<{ text?: string; pngBase64?: string }>
  exportEntry(entryId: string): Promise<{
    schemaVersion: number
    name: string
    tagPaths: string[][]
    skinId: string
    skinCode: string
  }>
  /** Save an export to a user-chosen path via the native save dialog. */
  saveExportFile(skinId: string, format: 'png' | 'hskin'): Promise<void>
  subscribe(listener: (event: SkinEvent) => void): Promise<() => void>
}
