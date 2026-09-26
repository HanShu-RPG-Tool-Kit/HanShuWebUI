import { assetFileName, normalizeAssetPath, normalizeFolderPath } from './assets/paths'
import { ensureAssetFolder, type Workspace } from './workspace'

/**
 * 工程结构里的「移动」收在这里，做成**纯函数**：给定工作区算出新工作区。
 * 好处是模型变换可以被单测覆盖，调用方（React 组件）只剩 blob 搬迁与提交两件事。
 *
 * 注意：资产的真身是 IndexedDB 里的 blob，纯函数只管元数据；
 * blob 的搬迁由调用方按返回的 `from*` / `to*` 路径完成。
 */

export type AssetMove = {
  /** 移动后的工作区 */
  workspace: Workspace
  /** 资产 id（原样保留，所以活动资产不会失效） */
  assetId: string
  fromPackageId: string
  fromPath: string
  toPackageId: string
  toPath: string
}

/**
 * 剧本换包（剪切）。
 * 找不到剧本、或本来就在目标包里 → 原样返回（调用方据此判断"没发生移动"）。
 */
export function moveScriptToPackage(
  workspace: Workspace,
  scriptId: string,
  targetPackageId: string,
): Workspace {
  const from = workspace.packages.find((pkg) =>
    pkg.scripts.some((script) => script.id === scriptId),
  )
  const script = from?.scripts.find((item) => item.id === scriptId)
  if (!from || !script || from.id === targetPackageId) return workspace

  return {
    ...workspace,
    packages: workspace.packages.map((pkg) => {
      if (pkg.id === from.id) {
        return {
          ...pkg,
          scripts: pkg.scripts.filter((item) => item.id !== scriptId),
        }
      }
      if (pkg.id === targetPackageId) {
        return { ...pkg, scripts: [...pkg.scripts, script] }
      }
      return pkg
    }),
  }
}

/**
 * 资产换目录（剪切，可跨包）。
 *
 * 返回 `null` 表示**没有发生移动**，三种情况：找不到资产、原地不动、
 * 或者目标位置已有同名文件（不覆盖，避免出现两条同路径资产）。
 */
export function moveAssetToDir(
  workspace: Workspace,
  assetId: string,
  targetPackageId: string,
  targetDir: string,
): AssetMove | null {
  let fromPackage: Workspace['packages'][number] | null = null
  let asset: Workspace['packages'][number]['assets'][number] | null = null
  for (const pkg of workspace.packages) {
    const hit = pkg.assets.find((item) => item.id === assetId)
    if (hit) {
      fromPackage = pkg
      asset = hit
      break
    }
  }
  if (!fromPackage || !asset) return null

  const dir = normalizeFolderPath(targetDir) ?? 'assets'
  const toPath = normalizeAssetPath(`${dir}/${assetFileName(asset.path)}`)
  if (!toPath) return null
  if (fromPackage.id === targetPackageId && toPath.toLowerCase() === asset.path.toLowerCase()) {
    return null
  }

  const target = workspace.packages.find((pkg) => pkg.id === targetPackageId)
  const clash = target?.assets.some(
    (item) => item.id !== assetId && item.path.toLowerCase() === toPath.toLowerCase(),
  )
  if (clash) return null

  const moved = { ...asset, path: toPath, updatedAt: Date.now() }
  const packages = workspace.packages.map((pkg) => {
    if (pkg.id !== fromPackage!.id && pkg.id !== targetPackageId) return pkg
    const without = pkg.assets.filter((item) => item.id !== assetId)
    if (pkg.id === targetPackageId) {
      return { ...pkg, assetsCollapsed: false, assets: [...without, moved] }
    }
    return { ...pkg, assets: without }
  })

  return {
    workspace: ensureAssetFolder({ ...workspace, packages }, targetPackageId, dir),
    assetId,
    fromPackageId: fromPackage.id,
    fromPath: asset.path,
    toPackageId: targetPackageId,
    toPath,
  }
}
