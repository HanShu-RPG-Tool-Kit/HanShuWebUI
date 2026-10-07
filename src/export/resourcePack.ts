import type { Workspace } from '../workspace'
import { exportPaks } from './pack/exportPaks'

export type ExportWarning = string

export type ExportResult = {
  blob: Blob
  fileCount: number
  warnings: ExportWarning[]
}

/**
 * 导出单个 combined PAK（兼容旧调用方）。
 * 内部走编译图 + 接线；行为对齐历史「导出PAK」。
 */
export async function buildResourcePackZip(
  workspace: Workspace,
): Promise<ExportResult> {
  const { packs, warnings } = await exportPaks(workspace, {
    targets: ['combined'],
  })
  const pack = packs[0]
  if (!pack) {
    return { blob: new Blob(), fileCount: 0, warnings }
  }
  return { blob: pack.blob, fileCount: pack.fileCount, warnings }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** @deprecated */
export function collectLinesPackFiles(_workspace: Workspace) {
  return [] as { path: string; content: string }[]
}

export { exportPaks, bundlePacksZip } from './pack/exportPaks'
export type { ExportPaksOptions, ExportPaksResult, PackPlaneResult } from './pack/exportPaks'
