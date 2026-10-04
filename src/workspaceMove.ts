import {
  assetFileName,
  assetParentDir,
  normalizeAssetPath,
  normalizeFolderPath,
} from './assets/paths'
import {
  localeAssetRootWithExt,
  parseLocaleAssetPath,
  sourceDir,
  sourceExtension,
  sourceFileStemName,
  TEXT_ASSET_EXTENSION,
} from './i18n/localeLayout'
import {
  ensureAssetFolder,
  removeAssetFolder,
  type Workspace,
} from './workspace'

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

/** 一条资产路径搬迁 */
export type AssetPathMove = { fromPath: string; toPath: string }

/** 剧本改名的结果：没资产 / 目标被占用 / 已连带搬迁 */
export type ScriptAssetRename =
  | { kind: 'none' }
  | { kind: 'blocked'; path: string }
  | { kind: 'moved'; workspace: Workspace; moves: AssetPathMove[] }

/**
 * 剧本改名时连带搬走它的本地化资产 —— **每一种语言都要遍历**：
 * - 文本：`assets/<locale>/lang_<ext>/<目录>/<剧本名>.lang`
 * - 音频：`assets/<locale>/voice_<ext>/<目录>/<剧本名>/<键名>.ogg`
 *
 * 路径里带 `<locale>` 的段不参与判断，所以 `zh_cn`、`en_us`…… 会被一视同仁地搬走。
 *
 * **只搬"这份文件自己那个后缀"的产物**：本地化产物按源后缀分家（`lang_hs` / `voice_hs`），
 * 产物路径里的 `<ext>` 必须与源文件的后缀一致 —— 否则改名 `note.md` 会把
 * `assets/<locale>/lang_hs/note.lang` 与 `assets/<locale>/voice_hs/note/` 一起搬走，
 * 那是**另一个文件**的产物。改了后缀（`cp1.hs` → `cp1.md`）时，产物跟着换根目录，
 * 不留在旧根下做孤儿。
 *
 * 纯函数只改元数据；blob 搬迁由调用方按 `moves` 完成（与 `moveAssetToDir` 同规矩）。
 * 目标位置已被占用时返回 `blocked`（不覆盖，调用方放弃整次改名）。
 */
export function renameScriptAssets(
  workspace: Workspace,
  scriptId: string,
  newName: string,
): ScriptAssetRename {
  const pkg = workspace.packages.find((item) =>
    item.scripts.some((script) => script.id === scriptId),
  )
  const script = pkg?.scripts.find((item) => item.id === scriptId)
  if (!pkg || !script) return { kind: 'none' }

  const stemOf = (name: string) =>
    [sourceDir(name), sourceFileStemName(name)].filter(Boolean).join('/')
  const oldStem = stemOf(script.name)
  const newStem = stemOf(newName)
  const oldExt = sourceExtension(script.name)
  const newExt = sourceExtension(newName)
  if (!oldStem || !newStem || !oldExt || !newExt) return { kind: 'none' }
  // 名字和后缀都没变：没有任何产物需要动
  if (oldStem === newStem && oldExt === newExt) return { kind: 'none' }

  const oldTail = oldStem.toLowerCase()
  const textRest = `${oldTail}.${TEXT_ASSET_EXTENSION}`
  const voicePrefix = `${oldTail}/`
  const moves: AssetPathMove[] = []
  const emptiedDirs: string[] = []

  for (const asset of pkg.assets) {
    const parsed = parseLocaleAssetPath(asset.path)
    // 后缀对不上就不是这份文件的产物（见上面的注释）
    if (!parsed || parsed.sourceExt !== oldExt) continue
    const rest = parsed.rest.toLowerCase()
    const root = localeAssetRootWithExt(parsed, newExt)

    // 文本：根目录之后的相对路径整条就是 `<目录>/<剧本名>.lang`
    if (parsed.kind === 'text') {
      if (rest !== textRest) continue
      moves.push({
        fromPath: asset.path,
        toPath: `${root}/${newStem}.${TEXT_ASSET_EXTENSION}`,
      })
      continue
    }

    // 音频：`<目录>/<剧本名>/<键名>.ogg` —— 键名必须是紧邻的下一段
    if (!rest.startsWith(voicePrefix)) continue
    const key = parsed.rest.slice(voicePrefix.length)
    if (!key || key.includes('/')) continue
    moves.push({
      fromPath: asset.path,
      toPath: `${root}/${newStem}/${key}`,
    })
    emptiedDirs.push(assetParentDir(asset.path))
  }

  if (moves.length === 0) return { kind: 'none' }

  const taken = new Set(pkg.assets.map((item) => item.path.toLowerCase()))
  for (const move of moves) {
    if (taken.has(move.toPath.toLowerCase())) {
      return { kind: 'blocked', path: move.toPath }
    }
  }

  const byFrom = new Map(
    moves.map((move) => [move.fromPath.toLowerCase(), move.toPath]),
  )
  const assets = pkg.assets.map((item) => {
    const toPath = byFrom.get(item.path.toLowerCase())
    return toPath ? { ...item, path: toPath, updatedAt: Date.now() } : item
  })

  let next: Workspace = {
    ...workspace,
    packages: workspace.packages.map((item) =>
      item.id === pkg.id ? { ...item, assets } : item,
    ),
  }
  for (const move of moves) {
    next = ensureAssetFolder(next, pkg.id, assetParentDir(move.toPath))
  }
  // 音频目录是「这个剧本专属」的，搬空后旧目录没有存在意义
  for (const dir of emptiedDirs) {
    next = removeAssetFolder(next, pkg.id, dir).workspace
  }

  return { kind: 'moved', workspace: next, moves }
}
