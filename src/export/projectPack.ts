import JSZip from 'jszip'
import { isAudioAsset } from '../assets/paths'
import { getAssetBlob } from '../assets/idb'
import { isVoiceRefPath } from '../i18n/voiceMap'
import { sourcePathOf, type Workspace } from '../workspace'
import type { ExportResult, ExportWarning } from './resourcePack'

function safePackageDir(name: string): string {
  const s = name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
  return s || 'package'
}

/**
 * 导出**工程包**：原样完整打包，不改写、不编译、不裁剪。
 * - 包内文件（`.hs` / `.md` / `.char` / `*.voice` …）按原文写入
 * - `assets/` 下的资产按 IndexedDB 里的二进制写入
 *
 * 结构：`包名/...`。与导出 PAK 不同，这里不做 `.hsc` 编译，也不按键名裁剪语言资源。
 */
export async function buildProjectPackZip(
  workspace: Workspace,
): Promise<ExportResult> {
  const warnings: ExportWarning[] = []
  const zip = new JSZip()
  let fileCount = 0

  for (const pkg of workspace.packages) {
    const root = safePackageDir(pkg.name)
    const folders = new Set<string>(['assets'])

    for (const folder of pkg.assetFolders ?? []) {
      const norm = folder.replace(/\\/g, '/').replace(/\/+$/, '')
      if (norm) folders.add(norm)
    }

    for (const script of pkg.scripts) {
      // 工程结构：源文件进 `src/<kind>/`（`xx.hs` → `src/hanshu/xx.hs`）
      zip.file(`${root}/${sourcePathOf(script)}`, script.content)
      fileCount++
    }

    for (const asset of pkg.assets) {
      const path = asset.path.replace(/\\/g, '/')
      const parent = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : 'assets'
      folders.add(parent)

      const blob = await getAssetBlob(pkg.id, asset.path)
      if (!blob) {
        warnings.push(`[${pkg.name}] IndexedDB 无数据: ${asset.path}`)
        continue
      }
      zip.file(`${root}/${path}`, blob)
      fileCount++
    }

    /*
     * 「引用资产」（`.ref`）**原样进包**：工程包是"可继续编辑的源"，引用在这里是对的
     * （落地成音频是导出 PAK 的职责）。但悬空引用不能静默跟着包流出去 ——
     * 收包的人打开只会看到"这个键没有配音"，查不回原因。
     */
    for (const asset of pkg.assets) {
      if (!isVoiceRefPath(asset.path)) continue
      const target = asset.refTarget ?? null
      if (!target) {
        warnings.push(
          `[${pkg.name}] ${asset.path}: 引用正文里没有可用的路径（应为一行 assets/… 路径）`,
        )
        continue
      }
      const hit = pkg.assets.find(
        (item) => item.path.toLowerCase() === target.toLowerCase(),
      )
      if (!hit) {
        warnings.push(
          `[${pkg.name}] ${asset.path}: 引用指向的资产不在这个包里（${target}）`,
        )
      } else if (!isAudioAsset(hit.path, hit.mime)) {
        warnings.push(
          `[${pkg.name}] ${asset.path}: 引用只能指向音频文件（${target}）`,
        )
      }
    }

    for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
      zip.folder(`${root}/${folder}`)
    }
  }

  if (workspace.packages.length === 0) {
    warnings.push('工作区没有包，导出为空')
  } else if (fileCount === 0) {
    warnings.push('没有可导出的文件')
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
  })

  return { blob, fileCount, warnings }
}
