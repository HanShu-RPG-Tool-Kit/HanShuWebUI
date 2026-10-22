import type { BatchPatchRequest, FolderNode, LibraryEntry, PatchFolderRequest } from '../contracts/types'
import type { FileEdit } from '../../project/serviceClient'

export type EntryRef = { entryId: string; revision: number }
export type SkinLibraryCommand =
  | { command: 'ensure-library' }
  | { command: 'import-entry'; entry: LibraryEntry }
  | { command: 'batch-patch'; expectedEntries: EntryRef[]; changes: Omit<BatchPatchRequest, 'entryIds' | 'expectedRevisions'> }
  | { command: 'delete-entries'; expectedEntries: EntryRef[] }
  | { command: 'create-folder'; folderId: string; name: string; parentId: string | null }
  | { command: 'patch-folder'; expectedFolder: FolderNode; expectedSiblings?: FolderNode[]; changes: Omit<PatchFolderRequest, 'expectedFolder' | 'expectedSiblings'> }
  | { command: 'delete-folder'; expectedFolder: FolderNode }
  | { command: 'rename-tag'; from: string; to: string; expectedEntries: EntryRef[] }
  | { command: 'delete-tag'; name: string; expectedEntries: EntryRef[] }
  | { command: 'delete-folder-entries'; folderId: string; expectedFolders: FolderNode[]; expectedEntries: EntryRef[] }

export function libraryCommand(edit: FileEdit): SkinLibraryCommand | null {
  if (edit.op !== 'skin-library-command' || typeof edit.data !== 'string') return null
  try { return JSON.parse(edit.data) as SkinLibraryCommand } catch { return null }
}

export const entryRef = (entry: LibraryEntry): EntryRef => ({ entryId: entry.entryId, revision: entry.revision })
// Folder views contain counts; only the authoritative node is a CAS snapshot.
export const folderRef = (folder: FolderNode): FolderNode => ({ folderId: folder.folderId, name: folder.name, parentId: folder.parentId, sortOrder: folder.sortOrder })
