/**
 * 平台文件能力隔离(方案 §12.3):
 *   - 桌面(Tauri):原生多选对话框 → 返回路径句柄,交给 skin_import_file。
 *   - 浏览器:<input type="file"> / 拖放 → 返回 File,交给 multipart 上传。
 * 业务组件只面对统一的 PickedFile,不感知运行环境。
 */

export interface PickedFile {
  /** Display label (file name). */
  name: string
  /** Desktop only: native absolute path. */
  path?: string
  /** Browser only: the File handle for multipart upload. */
  file?: File
}

export interface PlatformFiles {
  readonly mode: 'tauri' | 'browser'
  /** True when the platform can hand out native paths. */
  readonly hasNativePaths: boolean
  pickSkinFiles(): Promise<PickedFile[]>
  /** Files dropped onto the import drop zone (browser). */
  fromDataTransfer(dt: DataTransfer): PickedFile[]
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const SKIN_FILE_RE = /\.(png|skin\.json|json)$/i

function classify(name: string): 'png' | 'skin-json' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'png'
  if (lower.endsWith('.skin.json')) return 'skin-json'
  if (lower.endsWith('.json')) return 'skin-json'
  return null
}

const tauriFiles: PlatformFiles = {
  mode: 'tauri',
  hasNativePaths: true,
  async pickSkinFiles() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      multiple: true,
      title: '选择 PNG 或 .skin.json 文件',
      filters: [{ name: '皮肤文件', extensions: ['png', 'json'] }],
    })
    if (!selected) return []
    const paths = Array.isArray(selected) ? selected : [selected]
    return paths.map((p) => {
      const name = p.split(/[\\/]/).pop() ?? 'file'
      return { name, path: p }
    })
  },
  fromDataTransfer() {
    // Desktop drag-drop of files arrives via the Tauri window event, not
    // DataTransfer; the DOM drop only carries text here.
    return []
  },
}

const browserFiles: PlatformFiles = {
  mode: 'browser',
  hasNativePaths: false,
  async pickSkinFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = '.png,.skin.json,.json,image/png,application/json'
      input.onchange = () => {
        const out: PickedFile[] = []
        for (const f of Array.from(input.files ?? [])) {
          if (!SKIN_FILE_RE.test(f.name)) continue
          out.push({ name: f.name, file: f })
        }
        resolve(out)
      }
      // Cancelled picks resolve with an empty list on next tick.
      input.oncancel = () => resolve([])
      input.click()
    })
  },
  fromDataTransfer(dt) {
    const out: PickedFile[] = []
    for (const f of Array.from(dt.files ?? [])) {
      if (!SKIN_FILE_RE.test(f.name)) continue
      out.push({ name: f.name, file: f })
    }
    return out
  },
}

export function getPlatformFiles(): PlatformFiles {
  return isTauriRuntime() ? tauriFiles : browserFiles
}

/** Classify a picked file for the import queue. */
export function pickedKind(p: PickedFile): 'png-file' | 'skin-file' | null {
  const kind = classify(p.name)
  if (kind === 'png') return 'png-file'
  if (kind === 'skin-json') return 'skin-file'
  return null
}
