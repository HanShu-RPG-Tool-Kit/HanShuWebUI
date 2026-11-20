import type { RefObject } from 'react'
import {
  deleteAssetBlob,
  getAssetBlob,
  putAssetBlob,
} from '../../assets/idb'
import { normalizeAssetPath, normalizeFolderPath } from '../../assets/paths'
import { alertDialog, confirmDialog, promptDialog } from '../../ui/dialogs'
import { moveAssetToDir } from '../../workspaceMove'
import {
  ensureAssetFolder,
  findAsset,
  registerAsset,
  removeAssetFolder,
  toggleAssetsCollapsed,
} from '../../workspace'
import { removeAssetMeta, type Workspace } from '../../workspace'
import { createVoiceDiskSink } from '../../project/voiceDiskSink'
import type { FileEdit } from '../../project/serviceClient'
import type { ProjectDirectory } from '../../project/serviceClient'

/**
 * `assets/` 真实目录的全部写操作。**不持有状态**：工作区怎么存、工程句柄在哪、
 * 资产变了要通知谁，全部由调用方通过 {@link AssetActionDeps} 注入。
 *
 * 三个工作区（剧本 / 游戏性 / 视听）共用这一份：它只依赖工作区投影与工程句柄，
 * 不认识任何工作区自己的编辑器或文档模型。
 */
export type AssetActionDeps = {
  workspaceRef: RefObject<Workspace>
  projectRef: RefObject<{ handle: ProjectDirectory } | null>
  commitWorkspace: (next: Workspace) => void
  /** 打开资产前先把编辑器里的正文落回工作区投影（带编辑缓冲的工作区才需要）。 */
  flushEditorInto?: (base: Workspace) => Workspace
  /** 资产集合变了：配音库 / 文本绑定之类要刷新（可选）。 */
  onAssetsChanged?: () => void
}

export type AssetActions = {
  transfer: (projectId: string, sourcePath: string, targetDir: string, cut: boolean) => Promise<void>
  toggleAssets: (projectId: string) => void
  openAsset: (assetId: string) => void
  /** 文本 / JSON 资产（`.lang` 等）写回 IndexedDB；语言文本另走 stageWrite 合批保存。 */
  saveTextAsset: (assetId: string, content: string) => Promise<void>
  deleteAsset: (assetId: string) => void
  newFolder: (projectId: string, parentPath: string) => void
  deleteFolder: (projectId: string, folderPath: string) => void
  importAssets: (projectId: string, files: FileList | File[], targetDir?: string) => Promise<void>
  /** 资产在真实目录之间移动（拖放）。脚本移动不走这里，见工作区的 `applyScriptMove`。 */
  moveAsset: (assetId: string, targetProjectId: string, targetDir: string) => void
}

export function createAssetActions(deps: AssetActionDeps): AssetActions {
  const clientOf = () => deps.projectRef.current?.handle.client ?? null

  const toggleAssets = (projectId: string) => {
    deps.commitWorkspace(toggleAssetsCollapsed(deps.workspaceRef.current, projectId))
  }

  const openAsset = (assetId: string) => {
    if (!findAsset(deps.workspaceRef.current, assetId)) return
    const base = deps.flushEditorInto ? deps.flushEditorInto(deps.workspaceRef.current) : deps.workspaceRef.current
    deps.commitWorkspace({ ...base, activeAssetId: assetId })
  }

  const saveTextAsset = async (assetId: string, content: string) => {
    const hit = findAsset(deps.workspaceRef.current, assetId)
    if (!hit) return
    const { pkg, asset } = hit
    const mime = asset.mime || 'application/json'
    const blob = new Blob([content], { type: mime })
    const sourceClient = clientOf()
    const mirror = async () => {
      if (clientOf() !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
      await putAssetBlob(pkg.id, asset.path, blob)
      if (clientOf() !== sourceClient) throw new Error('工程已切换，原语言草稿保留在原工程')
      // 不传 refTarget：保留原有引用字段；配音四态刷新由宿主 onAssetsChanged 负责。
      const result = registerAsset(deps.workspaceRef.current, pkg.id, asset.path, mime, blob.size)
      if (result) deps.commitWorkspace(result.workspace)
      deps.onAssetsChanged?.()
    }
    if (sourceClient && /^assets\/[^/]+\/lang_/.test(asset.path)) {
      await sourceClient.transactions.stageWrite({ op: 'write', path: asset.path, data: content }, mirror)
    } else {
      await mirror()
    }
  }

  /**
   * 删除资产 = 磁盘上的实文件 + 本机 blob + 投影里的条目，三步同一份确认。
   * 不走 `voiceOps`：那条路带了配音库的刷新，别的视图没有配音库。
   */
  const deleteAsset = (assetId: string) => {
    const hit = findAsset(deps.workspaceRef.current, assetId)
    if (!hit) return
    const { path } = hit.asset
    const packageId = hit.pkg.id
    void confirmDialog({ message: `删除资产「${path}」？`, danger: true }).then(async (ok) => {
      if (!ok) return
      try {
        await createVoiceDiskSink(deps.projectRef.current?.handle ?? null).removeMany([path])
        await deleteAssetBlob(packageId, path)
        deps.commitWorkspace(removeAssetMeta(deps.workspaceRef.current, assetId))
        deps.onAssetsChanged?.()
      } catch (error) {
        await alertDialog(`资产未删除：${String(error)}`)
      }
    })
  }

  const newFolder = (projectId: string, parentPath: string) => {
    void promptDialog({
      title: '新建文件夹',
      message: '文件夹名不能包含 \\ / : * ? " < > |',
      defaultValue: 'voice',
      validate: (value) => {
        if (!value.trim()) return '名字不能为空'
        if (/[\\/:*?"<>|]/.test(value.trim())) return '文件夹名不能包含 \\ / : * ? " < > |'
        return null
      },
    }).then((name) => {
      if (!name?.trim()) return
      const folder = normalizeFolderPath(`${parentPath}/${name.trim()}`)
      if (!folder || folder === 'assets') {
        void alertDialog('文件夹路径无效')
        return
      }
      const client = clientOf()
      if (!client) return
      void client
        .apply([{ op: 'mkdir', path: folder }])
        .then(() => deps.commitWorkspace(ensureAssetFolder(deps.workspaceRef.current, projectId, folder)))
        .catch((error: unknown) => {
          void alertDialog(String(error))
        })
    })
  }

  const deleteFolder = (projectId: string, folderPath: string) => {
    if (folderPath === 'assets') return
    void confirmDialog({ message: `删除文件夹「${folderPath}」及其下全部资产？`, danger: true }).then((ok) => {
      if (!ok) return
      const client = clientOf()
      void (async () => {
        if (client?.transactions.stagedWrites().some((edit) => edit.path.startsWith(`${folderPath}/`))) {
          throw new Error('文件夹内还有未保存的修改，请先保存或处理提交记录')
        }
        if (client?.entry(folderPath)) await client.apply([{ op: 'remove', path: folderPath }], '删除资产文件夹')
        if (clientOf() !== client) return
        const { workspace: next, removed } = removeAssetFolder(deps.workspaceRef.current, projectId, folderPath)
        for (const asset of removed) await deleteAssetBlob(projectId, asset.path)
        deps.commitWorkspace(next)
      })().catch((error: unknown) => {
        void alertDialog(`删除文件夹未完成：${String(error)}`)
      })
    })
  }

  const importAssets = async (projectId: string, files: FileList | File[], targetDir = 'assets') => {
    const sourceClient = clientOf()
    if (!sourceClient?.writable) { await alertDialog('当前工程不可写'); return }
    const list = Array.from(files)
    if (list.length === 0) return

    const baseDir = normalizeFolderPath(targetDir) ?? 'assets'
    let next = ensureAssetFolder(deps.workspaceRef.current, projectId, baseDir)
    let lastAssetId: string | null = null
    const failed: string[] = []

    for (const file of list) {
      const withPath = file as File & { webkitRelativePath?: string }
      const rel = withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0 ? withPath.webkitRelativePath : file.name
      let path = normalizeAssetPath(`${baseDir}/${rel}`)
      if (!path) {
        failed.push(file.name)
        continue
      }
      try {
        if (clientOf() !== sourceClient) throw new Error('工程已切换')
        const original = path
        const dot = original.lastIndexOf('.')
        const split = dot > original.lastIndexOf('/') ? dot : original.length
        let n = 1
        while (sourceClient.entry(path) || next.packages.find(p => p.id === projectId)?.assets.some(a => a.path.toLowerCase() === path!.toLowerCase())) {
          path = `${original.slice(0, split)} (${n++})${original.slice(split)}`
        }
        await sourceClient.apply([{op: 'write', path, data: file, version: null}], '导入资产')
        if (clientOf() !== sourceClient) return
        await putAssetBlob(projectId, path, file)
        next = ensureAssetFolder(deps.workspaceRef.current, projectId, baseDir)
        const result = registerAsset(next, projectId, path, file.type || 'application/octet-stream', file.size)
        if (!result) {
          failed.push(file.name)
          continue
        }
        next = result.workspace
        lastAssetId = result.asset.id
        deps.commitWorkspace(next)
      } catch {
        failed.push(file.name)
      }
    }

    if (clientOf() !== sourceClient) return
    deps.commitWorkspace({ ...next, activeAssetId: lastAssetId ?? next.activeAssetId })
    deps.onAssetsChanged?.()
    if (failed.length > 0) void alertDialog(`部分文件导入失败：\n${failed.join('\n')}`)
  }

  const moveAsset = (assetId: string, targetProjectId: string, targetDir: string) => {
    const result = moveAssetToDir(deps.workspaceRef.current, assetId, targetProjectId, targetDir)
    if (!result) return
    const client = clientOf()
    void (async () => {
      const blob = await getAssetBlob(result.fromPackageId, result.fromPath)
      if (!blob) return
      if (client) {
        if (client.transactions.stagedWrites().some((edit) => edit.path === result.fromPath)) {
          throw new Error('该资产还有未保存的修改，请先保存再移动')
        }
        await client.apply(
          [
            ...(client.entry(result.fromPath)
              ? [{ op: 'move' as const, path: result.fromPath, destination: result.toPath }]
              : []),
            { op: 'write' as const, path: result.toPath, data: blob },
          ],
          '移动资产及当前内容',
        )
      }
      if (clientOf() !== client) return
      await putAssetBlob(result.toPackageId, result.toPath, blob)
      await deleteAssetBlob(result.fromPackageId, result.fromPath)
      const current = moveAssetToDir(deps.workspaceRef.current, assetId, targetProjectId, targetDir)
      if (current) deps.commitWorkspace(current.workspace)
    })().catch((error: unknown) => {
      void alertDialog(`移动资产失败：${String(error)}`)
    })
  }

  const transfer = async (projectId: string, sourcePath: string, targetDir: string, cut: boolean) => {
    const client = clientOf()
    if (!client?.writable) throw new Error('当前工程不可写')
    const pkg = deps.workspaceRef.current.packages.find(p => p.id === projectId)
    if (!pkg || sourcePath === 'assets' || !sourcePath.startsWith('assets/')) throw new Error('资产路径无效')
    const dir = normalizeFolderPath(targetDir)
    if (!dir || dir === sourcePath || dir.startsWith(sourcePath + '/')) throw new Error('不能复制或移动到自身内部')
    const assets = pkg.assets.filter(a => a.path === sourcePath || a.path.startsWith(sourcePath + '/'))
    const folders = (pkg.assetFolders ?? []).filter(p => p === sourcePath || p.startsWith(sourcePath + '/'))
    if (!assets.length && !folders.length) throw new Error('源资产已不存在')
    const occupied = new Set([...client.tree.entries.map(e => e.path.toLowerCase()), ...pkg.assets.map(a => a.path.toLowerCase()), ...(pkg.assetFolders ?? []).map(p => p.toLowerCase())])
    const name = sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
    let destination = `${dir}/${name}`
    if (cut && destination === sourcePath) return
    const dot = name.lastIndexOf('.')
    const stem = assets.some(a => a.path === sourcePath) && dot > 0 ? name.slice(0, dot) : name
    const ext = stem === name ? '' : name.slice(dot)
    for (let n = 1; occupied.has(destination.toLowerCase()); n++) destination = `${dir}/${stem} (${n})${ext}`
    if ([...client.transactions.stagedWrites().map(e => e.path), ...client.transactions.editorDirtyPaths()].some(path => path === sourcePath || path.startsWith(sourcePath + '/'))) throw new Error('请先保存源资产的修改')
    const sourceEntry = client.entry(sourcePath)
    const contents = await Promise.all(assets.map(async asset => {
      const entry = client.entry(asset.path)
      const snapshot = entry ? await client.readSnapshot(asset.path, false, entry.version) : null
      const blob = snapshot?.file ?? await getAssetBlob(projectId, asset.path)
      if (!blob) throw new Error(`无法读取 ${asset.path}`)
      return { asset, blob, version: snapshot?.version }
    }))
    if (clientOf() !== client) throw new Error('工程已切换')
    const to = (path: string) => destination + path.slice(sourcePath.length)
    const movingDirectory = cut && sourceEntry?.kind === 'directory'
    const edits: FileEdit[] = folders.map(path => ({ op: 'mkdir', path: to(path) }))
    for (const {asset, blob, version} of contents) {
      if (cut && version) edits.push({ op: 'move', path: asset.path, destination: to(asset.path), version, destinationVersion: null })
      else edits.push({ op: 'write', path: to(asset.path), data: blob, version: null })
    }
    if (movingDirectory) edits.splice(0, edits.length, {op: 'move', path: sourcePath, destination, version: sourceEntry.version, destinationVersion: null})
    await client.apply(edits, cut ? '剪切资产' : '复制资产')
    if (clientOf() !== client) return
    let next = deps.workspaceRef.current
    for (const path of folders) next = ensureAssetFolder(next, projectId, to(path))
    for (const {asset, blob} of contents) {
      await putAssetBlob(projectId, to(asset.path), blob)
      const result = registerAsset(next, projectId, to(asset.path), asset.mime, blob.size)
      if (result) next = result.workspace
      if (cut) { next = removeAssetMeta(next, asset.id); await deleteAssetBlob(projectId, asset.path) }
    }
    if (cut && folders.length) next = removeAssetFolder(next, projectId, sourcePath).workspace
    deps.commitWorkspace(next)
    deps.onAssetsChanged?.()
  }

  return { transfer, toggleAssets, openAsset, saveTextAsset, deleteAsset, newFolder, deleteFolder, importAssets, moveAsset }
}
