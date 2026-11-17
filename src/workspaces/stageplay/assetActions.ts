import type { RefObject } from 'react'
import {
  deleteAssetBlob,
  getAssetBlob,
  putAssetBlob,
} from '../../assets/idb'
import { normalizeAssetPath, normalizeFolderPath } from '../../assets/paths'
import type { FileEdit } from '../../project/serviceClient'
import { alertDialog, confirmDialog, promptDialog } from '../../ui/dialogs'
import { moveAssetToDir } from '../../workspaceMove'
import {
  ensureAssetFolder,
  findAsset,
  registerAsset,
  removeAssetFolder,
  toggleAssetsCollapsed,
  type Workspace,
} from '../../workspace'
import type { VoiceOps } from '../../i18n/voiceOps'

/**
 * `assets/` 真实目录的全部写操作。**不持有状态**：工作区怎么存、工程句柄在哪、
 * 配音资产怎么连带删，全部由调用方通过 {@link StageplayAssetDeps} 注入。
 *
 * 抽出来的理由与 `dockPanels.tsx` 相同：这些操作此前是工作区组件里的闭包，
 * 面板拿不到、别的宿主也复用不了。现在它是一份能力对象——资产管理器面板只要有
 * 这些回调就能工作，不需要知道剧本工作区长什么样。
 */
export type StageplayAssetDeps = {
  workspaceRef: RefObject<Workspace>
  projectRef: RefObject<{ handle: { client: AssetProjectClient } } | null>
  commitWorkspace: (next: Workspace) => void
  /** 打开资产前先把编辑器里的正文落回工作区投影。 */
  flushEditorInto: (base: Workspace) => Workspace
  /** 配音 / 文本资产要跟着一起删除（见 `i18n/voiceOps`）。 */
  voiceOps: () => Pick<VoiceOps, 'removeAssetEverywhere'>
}

/** 只依赖事务与条目这几样，不把整个 ProjectClient 形状搬进来。 */
export type AssetProjectClient = {
  transactions: { stagedWrites: () => FileEdit[] }
  entry: (path: string) => unknown
  apply: (edits: FileEdit[], label?: string) => Promise<void>
}

export type StageplayAssetActions = {
  toggleAssets: (projectId: string) => void
  openAsset: (assetId: string) => void
  deleteAsset: (assetId: string) => void
  newFolder: (projectId: string, parentPath: string) => void
  deleteFolder: (projectId: string, folderPath: string) => void
  importAssets: (projectId: string, files: FileList | File[], targetDir?: string) => Promise<void>
  /** 资产在真实目录之间移动（拖放）。脚本移动不走这里，见工作区的 `applyScriptMove`。 */
  moveAsset: (assetId: string, targetProjectId: string, targetDir: string) => void
}

export function createStageplayAssetActions(deps: StageplayAssetDeps): StageplayAssetActions {
  const clientOf = (): AssetProjectClient | null => deps.projectRef.current?.handle.client ?? null

  const toggleAssets = (projectId: string) => {
    deps.commitWorkspace(toggleAssetsCollapsed(deps.workspaceRef.current, projectId))
  }

  const openAsset = (assetId: string) => {
    if (!findAsset(deps.workspaceRef.current, assetId)) return
    // 先落盘当前剧本
    deps.commitWorkspace({
      ...deps.flushEditorInto(deps.workspaceRef.current),
      activeAssetId: assetId,
    })
  }

  const deleteAsset = (assetId: string) => {
    const hit = findAsset(deps.workspaceRef.current, assetId)
    if (!hit) return
    void confirmDialog({ message: `删除资产「${hit.asset.path}」？`, danger: true }).then(async (ok) => {
      if (!ok) return
      try {
        await deps.voiceOps().removeAssetEverywhere(hit.pkg.id, [hit.asset.path])
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
    const list = Array.from(files)
    if (list.length === 0) return

    const baseDir = normalizeFolderPath(targetDir) ?? 'assets'
    let next = ensureAssetFolder(deps.workspaceRef.current, projectId, baseDir)
    let lastAssetId: string | null = null
    const failed: string[] = []

    for (const file of list) {
      const withPath = file as File & { webkitRelativePath?: string }
      const rel = withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0 ? withPath.webkitRelativePath : file.name
      const path = normalizeAssetPath(`${baseDir}/${rel}`)
      if (!path) {
        failed.push(file.name)
        continue
      }
      try {
        await putAssetBlob(projectId, path, file)
        const result = registerAsset(next, projectId, path, file.type || 'application/octet-stream', file.size)
        if (!result) {
          failed.push(file.name)
          continue
        }
        next = result.workspace
        lastAssetId = result.asset.id
      } catch {
        failed.push(file.name)
      }
    }

    deps.commitWorkspace({ ...next, activeAssetId: lastAssetId ?? next.activeAssetId })
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

  return { toggleAssets, openAsset, deleteAsset, newFolder, deleteFolder, importAssets, moveAsset }
}
