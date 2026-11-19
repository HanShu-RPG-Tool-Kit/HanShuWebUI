import { deleteAssetBlob, putAssetBlob } from '../assets/idb'
import { stringifyTextFile, TEXT_ASSET_MIME, type TextFile } from './textMap'
import { sourceExtension, textAssetPath } from './localeLayout'
import { voiceAssetDir } from './voiceMap'
import {
  registerAsset,
  removeAssetFolder,
  removeAssetMeta,
  type Workspace,
} from '../workspace'

/** 工程里真实存在过的语言与其资产数量 */
export type LocaleSummary = { locale: string; langFiles: number; voiceFiles: number }

/** 工程里真实存在过的语言（`assets/<locale>/lang_*` 与 `voice_*`） */
export function listLocalesOf(workspace: Workspace): LocaleSummary[] {
  const map = new Map<string, LocaleSummary>()
  const bump = (locale: string, field: 'langFiles' | 'voiceFiles') => {
    const hit = map.get(locale) ?? { locale, langFiles: 0, voiceFiles: 0 }
    hit[field] += 1
    map.set(locale, hit)
  }
  for (const pkg of workspace.packages) {
    for (const asset of pkg.assets) {
      const parts = asset.path.replace(/\\/g, '/').split('/')
      const locale = parts[1]
      if (parts[0]?.toLowerCase() !== 'assets' || !locale) continue
      if (/^lang_[a-z0-9]+$/i.test(parts[2] ?? '')) bump(locale.toLowerCase(), 'langFiles')
      else if (/^voice_[a-z0-9]+$/i.test(parts[2] ?? '')) {
        bump(locale.toLowerCase(), 'voiceFiles')
      }
    }
  }
  return [...map.values()].sort((a, b) => a.locale.localeCompare(b.locale))
}

/** 某个源文件在**所有语言**下的本地化资产（语言文本 + 配音目录） */
export function sourceAssetPathsOf(
  workspace: Workspace,
  sourceName: string,
): { paths: string[]; voiceDirs: string[] } {
  const ext = sourceExtension(sourceName)
  const paths: string[] = []
  const voiceDirs: string[] = []
  for (const pkg of workspace.packages) {
    const locales = new Set<string>()
    for (const asset of pkg.assets) {
      const parts = asset.path.replace(/\\/g, '/').split('/')
      const locale = parts[1]
      if (parts[0]?.toLowerCase() === 'assets' && locale) {
        locales.add(locale.toLowerCase())
      }
    }
    for (const locale of locales) {
      const textPath = textAssetPath(locale, sourceName)
      if (
        pkg.assets.some(
          (asset) => asset.path.toLowerCase() === textPath.toLowerCase(),
        )
      ) {
        paths.push(textPath)
      }
      const dir = voiceAssetDir(locale, sourceName, ext)
      if (
        pkg.assets.some((asset) =>
          asset.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`),
        )
      ) {
        voiceDirs.push(dir)
      }
    }
  }
  return { paths, voiceDirs }
}

/** 写语言文本：blob → 登记进工作区（父目录 + 元数据），顺序与界面里的资产写入一致 */
export async function writeLangAsset(
  workspace: Workspace,
  packageId: string,
  path: string,
  data: TextFile,
): Promise<Workspace> {
  const blob = new Blob([stringifyTextFile(data)], { type: TEXT_ASSET_MIME })
  await putAssetBlob(packageId, path, blob)
  const result = registerAsset(
    workspace,
    packageId,
    path,
    TEXT_ASSET_MIME,
    blob.size,
  )
  return result?.workspace ?? workspace
}

/**
 * 删除某个源文件在所有语言下的本地化资产：blob、元数据，以及清空后的配音目录。
 * 删除剧本时若不清这些，`assets/<locale>/lang_<ext>/xx.lang` 会变成永久孤儿。
 */
export async function deleteSourceAssets(
  workspace: Workspace,
  sourceName: string,
): Promise<{ workspace: Workspace; removed: string[] }> {
  const { paths, voiceDirs } = sourceAssetPathsOf(workspace, sourceName)
  let next = workspace
  const removed: string[] = []
  for (const pkg of workspace.packages) {
    const targets = [
      ...pkg.assets.filter((asset) =>
        paths.some((path) => path.toLowerCase() === asset.path.toLowerCase()),
      ),
      ...pkg.assets.filter((asset) =>
        voiceDirs.some((dir) =>
          asset.path.toLowerCase().startsWith(`${dir.toLowerCase()}/`),
        ),
      ),
    ]
    for (const asset of targets) {
      await deleteAssetBlob(pkg.id, asset.path)
      next = removeAssetMeta(next, asset.id)
      removed.push(asset.path)
    }
    for (const dir of voiceDirs) {
      next = removeAssetFolder(next, pkg.id, dir).workspace
    }
  }
  return { workspace: next, removed }
}
