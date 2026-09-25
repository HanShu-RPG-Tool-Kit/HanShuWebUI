import JSZip from 'jszip'
import { getAssetBlob } from '../assets/idb'
import type { Workspace } from '../workspace'
import type { ExportResult, ExportWarning } from './resourcePack'

function safePackageDir(name: string): string {
  const s = name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
  return s || 'package'
}

/**
 * 导出工作区各包的原始 assets/（IndexedDB 二进制），不做 rpgtoolkit 编译。
 * 结构：`包名/assets/...`
 */
export async function buildAssetsPackZip(
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

    for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
      zip.folder(`${root}/${folder}`)
    }
  }

  if (workspace.packages.length === 0) {
    warnings.push('工作区没有包，导出为空')
  } else if (fileCount === 0) {
    warnings.push('没有可导出的资产文件')
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
  })

  return { blob, fileCount, warnings }
}
