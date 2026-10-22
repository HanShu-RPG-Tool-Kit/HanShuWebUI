import type { SkinApi } from '../api/SkinApi'
import type { FolderNode, FolderScopeSnapshot } from '../contracts/types'

export function folderSnapshot(folder: FolderNode): FolderNode {
  return { folderId: folder.folderId, name: folder.name, parentId: folder.parentId, sortOrder: folder.sortOrder }
}

/** Freeze the exact recursive scope before showing destructive confirmation.
 * If the library changes during pagination, do not silently broaden the set. */
export async function captureFolderScope(api: SkinApi, folderId: string, expectedFolder?: FolderNode): Promise<FolderScopeSnapshot> {
  const tree = await api.listFolders()
  const currentFolder = tree.folders.find(folder => folder.folderId === folderId)
  if (!currentFolder) throw new Error('文件夹已不存在，请刷新皮肤库后重新选择。')
  if (expectedFolder && JSON.stringify(folderSnapshot(currentFolder)) !== JSON.stringify(folderSnapshot(expectedFolder))) {
    throw new Error('文件夹已被移动或修改，请刷新皮肤库后重新选择。')
  }
  const ids = new Set([folderId])
  for (let grew = true; grew;) {
    grew = false
    for (const folder of tree.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.folderId)) {
        ids.add(folder.folderId); grew = true
      }
    }
  }
  const entries: FolderScopeSnapshot['entries'] = []
  for (let page = 1;; page++) {
    const result = await api.listEntries({ scope: 'all', page, pageSize: 200 })
    if (result.revision !== tree.revision) throw new Error('读取操作范围时皮肤库发生了变化，请刷新后重新操作。')
    for (const entry of result.entries) {
      if (entry.folderId && ids.has(entry.folderId)) entries.push({ entryId: entry.entryId, revision: entry.revision })
    }
    if (page * result.pageSize >= result.total) break
    if (!result.entries.length) throw new Error('未能完整读取文件夹范围，请刷新后重试。')
  }
  return { folders: tree.folders.filter(folder => ids.has(folder.folderId)).map(folderSnapshot), entries }
}
