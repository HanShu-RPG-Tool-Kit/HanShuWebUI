/** 规范化为包内 assets/ 下的相对路径（文件） */
export function normalizeAssetPath(raw: string): string | null {
  let path = raw.trim().replace(/\\/g, '/')
  if (!path) return null
  path = path.replace(/^\.\/+/, '')
  if (!path.toLowerCase().startsWith('assets/')) {
    path = `assets/${path}`
  }
  if (path.includes('..') || path.includes(':') || /\/{2,}/.test(path)) {
    return null
  }
  if (path === 'assets' || path === 'assets/') return null
  if (path.endsWith('/')) return null
  return path
}

/** 规范化文件夹路径，返回无尾斜杠形式，如 assets/voice */
export function normalizeFolderPath(raw: string): string | null {
  let path = raw.trim().replace(/\\/g, '/')
  if (!path) return null
  path = path.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (path.toLowerCase() === 'assets') return 'assets'
  if (!path.toLowerCase().startsWith('assets/')) {
    path = `assets/${path}`
  }
  if (path.includes('..') || path.includes(':') || /\/{2,}/.test(path)) {
    return null
  }
  return path
}

export function assetFileName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

export function assetParentDir(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return 'assets'
  return path.slice(0, idx)
}

export function isAudioAsset(path: string, mime?: string): boolean {
  if (mime?.startsWith('audio/')) return true
  return /\.(wav|mp3|ogg|flac|m4a|aac|opus|webm)$/i.test(path)
}

export function isImageAsset(path: string, mime?: string): boolean {
  if (mime?.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path)
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export type AssetTreeDir = {
  kind: 'dir'
  name: string
  path: string
  children: AssetTreeNode[]
}

export type AssetTreeFile = {
  kind: 'file'
  name: string
  asset: {
    id: string
    path: string
    mime: string
    size: number
    updatedAt: number
  }
}

export type AssetTreeNode = AssetTreeDir | AssetTreeFile

type MutableDir = {
  kind: 'dir'
  name: string
  path: string
  dirs: Map<string, MutableDir>
  files: AssetTreeFile[]
}

function ensureDir(root: MutableDir, folderPath: string): MutableDir {
  const norm = normalizeFolderPath(folderPath)
  if (!norm || norm === 'assets') return root
  const parts = norm.split('/').slice(1)
  let cur = root
  let acc = 'assets'
  for (const part of parts) {
    acc = `${acc}/${part}`
    let next = cur.dirs.get(part)
    if (!next) {
      next = {
        kind: 'dir',
        name: part,
        path: acc,
        dirs: new Map(),
        files: [],
      }
      cur.dirs.set(part, next)
    }
    cur = next
  }
  return cur
}

function freezeDir(dir: MutableDir): AssetTreeDir {
  const children: AssetTreeNode[] = [
    ...[...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .map(freezeDir),
    ...dir.files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  ]
  return { kind: 'dir', name: dir.name, path: dir.path, children }
}

/** 由文件路径 + 显式空文件夹 生成 assets 树 */
export function buildAssetTree(
  assets: {
    id: string
    path: string
    mime: string
    size: number
    updatedAt: number
  }[],
  folders: string[],
): AssetTreeDir {
  const root: MutableDir = {
    kind: 'dir',
    name: 'assets',
    path: 'assets',
    dirs: new Map(),
    files: [],
  }

  for (const folder of folders) {
    ensureDir(root, folder)
  }

  for (const asset of assets) {
    const parent = assetParentDir(asset.path)
    const dir = ensureDir(root, parent)
    dir.files.push({
      kind: 'file',
      name: assetFileName(asset.path),
      asset,
    })
  }

  return freezeDir(root)
}
