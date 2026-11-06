import { isTauriRuntime } from '../desktopWindow'
import { downloadBlob } from './resourcePack'

export type SaveBlobResult = 'saved' | 'downloaded' | 'cancelled'

export type SaveBlobOptions = {
  /** 对话框标题（桌面／File System Access） */
  title?: string
  /** 扩展名不含点，如 `['zip']` */
  extensions?: string[]
  /** 过滤器显示名 */
  filterLabel?: string
}

type SaveFilePicker = {
  showSaveFilePicker: (options?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<FileSystemFileHandle>
}

async function saveWithFilePicker(blob: Blob, fileName: string, options: SaveBlobOptions): Promise<boolean> {
  const w = window as Window & Partial<SaveFilePicker>
  if (typeof w.showSaveFilePicker !== 'function') return false
  const extensions = (options.extensions ?? []).map((ext) => ext.replace(/^\./, ''))
  const acceptExts = extensions.map((ext) => `.${ext}`)
  const handle = await w.showSaveFilePicker({
    suggestedName: fileName,
    types: extensions.length
      ? [{
          description: options.filterLabel ?? options.title ?? '文件',
          accept: { 'application/octet-stream': acceptExts },
        }]
      : undefined,
  })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
  return true
}

async function saveWithTauri(blob: Blob, fileName: string, options: SaveBlobOptions): Promise<'saved' | 'cancelled'> {
  const { invoke } = await import('@tauri-apps/api/core')
  const extensions = (options.extensions ?? []).map((ext) => ext.replace(/^\./, ''))
  const filters = extensions.length
    ? [{ label: options.filterLabel ?? '文件', extensions }]
    : []
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const path = await invoke<string | null>('desktop_save_export_file', {
    defaultName: fileName,
    filters,
    title: options.title ?? '另存为',
    data: Array.from(bytes),
  })
  return path ? 'saved' : 'cancelled'
}

/**
 * 优先「另存为」到用户指定路径；不可用时回退浏览器下载。
 * - 桌面：原生保存对话框
 * - Web（Chrome／Edge 等）：`showSaveFilePicker`
 * - 其余：`downloadBlob`
 */
export async function saveBlobAs(
  blob: Blob,
  fileName: string,
  options: SaveBlobOptions = {},
): Promise<SaveBlobResult> {
  if (isTauriRuntime()) {
    try {
      return await saveWithTauri(blob, fileName, options)
    } catch (error) {
      // 对话框／写盘失败时仍给下载兜底，避免导出完全不可用
      console.warn('desktop save failed, falling back to download', error)
      downloadBlob(blob, fileName)
      return 'downloaded'
    }
  }
  try {
    if (await saveWithFilePicker(blob, fileName, options)) return 'saved'
  } catch (error) {
    // 用户取消会抛 AbortError；其它错误再走下载
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    console.warn('save file picker failed, falling back to download', error)
  }
  downloadBlob(blob, fileName)
  return 'downloaded'
}
