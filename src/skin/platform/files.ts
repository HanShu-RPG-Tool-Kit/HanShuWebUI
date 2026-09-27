/**
 * 平台文件能力隔离(方案 §12.3):
 *   - 桌面(Tauri):原生多选对话框 → 返回路径句柄；文件夹走 webview directory input
 *   - 浏览器:<input type="file"> / webkitdirectory / 拖放 → File + relativePath
 * 业务组件只面对统一的 PickedFile,不感知运行环境。
 */

export interface PickedFile {
  /** Display label (file name). */
  name: string
  /**
   * 相对路径（含文件名，`/` 分隔），来自选文件夹或拖入目录。
   * 例：`CoolPack/team/a.png`。无目录结构时省略。
   */
  relativePath?: string
  /** Desktop only: native absolute path. */
  path?: string
  /** Browser / webview: the File handle for multipart upload. */
  file?: File
}

export interface PlatformFiles {
  readonly mode: 'tauri' | 'browser'
  /** True when the platform can hand out native paths. */
  readonly hasNativePaths: boolean
  pickSkinFiles(): Promise<PickedFile[]>
  /** 选文件夹：递归收集皮肤文件，带 relativePath（含所选根目录名）。 */
  pickSkinFolder(): Promise<PickedFile[]>
  /** Files / folders dropped onto the import drop zone. */
  fromDataTransfer(dt: DataTransfer): Promise<PickedFile[]>
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function classify(name: string): 'png' | 'skin-bin' | 'skin-json' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'png'
  if (lower.endsWith('.skin.json')) return 'skin-json'
  if (lower.endsWith('.skin')) return 'skin-bin'
  if (lower.endsWith('.json')) return 'skin-json'
  return null
}

function isSkinFileName(name: string): boolean {
  return classify(name) != null
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function pickViaInput(opts: {
  multiple?: boolean
  directory?: boolean
}): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (opts.multiple) input.multiple = true
    if (opts.directory) {
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
      // Chromium
      ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory =
        true
    } else {
      input.accept =
        '.png,.skin,.skin.json,.json,image/png,application/json,application/octet-stream'
    }
    input.onchange = () => {
      const out: PickedFile[] = []
      for (const f of Array.from(input.files ?? [])) {
        if (!isSkinFileName(f.name)) continue
        const rel =
          opts.directory && f.webkitRelativePath
            ? normalizeRelPath(f.webkitRelativePath)
            : undefined
        out.push({
          name: f.name,
          file: f,
          relativePath: rel || undefined,
        })
      }
      resolve(out)
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

export type CollectProgress = (found: number) => void

async function yieldToUi(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
}

async function collectFromEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: PickedFile[],
  onProgress?: CollectProgress,
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject)
    })
    if (!isSkinFileName(file.name)) return
    const relativePath = normalizeRelPath(
      prefix ? `${prefix}/${file.name}` : file.name,
    )
    out.push({ name: file.name, file, relativePath })
    if (out.length % 40 === 0) {
      onProgress?.(out.length)
      await yieldToUi()
    }
    return
  }
  if (!entry.isDirectory) return
  const dir = entry as FileSystemDirectoryEntry
  const reader = dir.createReader()
  const nextPrefix = prefix ? `${prefix}/${dir.name}` : dir.name

  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })

  // readEntries may return partial batches
  for (;;) {
    const batch = await readBatch()
    if (batch.length === 0) break
    for (const child of batch) {
      await collectFromEntry(child, nextPrefix, out, onProgress)
    }
    onProgress?.(out.length)
    await yieldToUi()
  }
}

/**
 * 必须在 drop 事件同步阶段调用：DataTransfer / items 离开 handler 后会清空。
 * 先同步取出 FileSystemEntry 与 File 快照，再异步遍历目录。
 */
export function snapshotDataTransfer(dt: DataTransfer): {
  entries: FileSystemEntry[]
  files: File[]
} {
  const entries: FileSystemEntry[] = []
  const items = dt.items ? Array.from(dt.items) : []
  if (items.length > 0 && typeof items[0]?.webkitGetAsEntry === 'function') {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
  }
  const files = Array.from(dt.files ?? [])
  return { entries, files }
}

export async function pickedFromSnapshot(
  snap: {
    entries: FileSystemEntry[]
    files: File[]
  },
  onProgress?: CollectProgress,
): Promise<PickedFile[]> {
  const out: PickedFile[] = []

  if (snap.entries.length > 0) {
    for (const entry of snap.entries) {
      await collectFromEntry(entry, '', out, onProgress)
    }
    onProgress?.(out.length)
    if (out.length > 0) return out
  }

  for (let i = 0; i < snap.files.length; i++) {
    const f = snap.files[i]!
    if (!isSkinFileName(f.name)) continue
    const rel = f.webkitRelativePath
      ? normalizeRelPath(f.webkitRelativePath)
      : undefined
    out.push({ name: f.name, file: f, relativePath: rel || undefined })
    if (out.length % 40 === 0) {
      onProgress?.(out.length)
      await yieldToUi()
    }
  }
  onProgress?.(out.length)
  return out
}

async function fromDataTransferAsync(dt: DataTransfer): Promise<PickedFile[]> {
  return pickedFromSnapshot(snapshotDataTransfer(dt))
}

const tauriFiles: PlatformFiles = {
  mode: 'tauri',
  hasNativePaths: true,
  async pickSkinFiles() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      title: '选择 PNG / .skin / .skin.json',
      filters: [
        { name: '皮肤文件', extensions: ['png', 'skin', 'json'] },
      ],
    })
    if (!selected) return []
    const paths = Array.isArray(selected) ? selected : [selected]
    return paths.map((p) => {
      const name = p.split(/[\\/]/).pop() ?? 'file'
      return { name, path: p }
    })
  },
  async pickSkinFolder() {
    // WebView 的 directory input 能带上 webkitRelativePath；原生仅返回目录路径无法遍历。
    return pickViaInput({ directory: true })
  },
  fromDataTransfer(dt) {
    return fromDataTransferAsync(dt)
  },
}

const browserFiles: PlatformFiles = {
  mode: 'browser',
  hasNativePaths: false,
  async pickSkinFiles() {
    return pickViaInput({ multiple: true })
  },
  async pickSkinFolder() {
    return pickViaInput({ directory: true })
  },
  fromDataTransfer(dt) {
    return fromDataTransferAsync(dt)
  },
}

export function getPlatformFiles(): PlatformFiles {
  return isTauriRuntime() ? tauriFiles : browserFiles
}

/** Classify a picked file for the import queue. */
export function pickedKind(p: PickedFile): 'png-file' | 'skin-file' | null {
  const kind = classify(p.name)
  if (kind === 'png') return 'png-file'
  if (kind === 'skin-bin' || kind === 'skin-json') return 'skin-file'
  return null
}

/** 相对路径中的目录段（不含文件名）。 */
export function relativeFolderSegments(relativePath?: string): string[] {
  if (!relativePath) return []
  const parts = normalizeRelPath(relativePath).split('/').filter(Boolean)
  if (parts.length <= 1) return []
  return parts.slice(0, -1)
}
