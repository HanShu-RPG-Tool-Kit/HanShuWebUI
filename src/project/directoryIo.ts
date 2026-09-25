/** File System Access — 目录读写工具（Web 开发 / Chromium WebView） */

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickProjectDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!supportsDirectoryPicker()) {
    throw new Error(
      '当前环境不支持文件夹 API。请使用 Chrome / Edge 打开本开发页（localhost）。',
    )
  }
  return window.showDirectoryPicker!({
    id: 'hanshu-project',
    mode: 'readwrite',
    startIn: 'documents',
  })
}

export async function ensureReadWritePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  const current = await handle.queryPermission(opts)
  if (current === 'granted') return true
  const next = await handle.requestPermission(opts)
  return next === 'granted'
}

export async function readTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

export async function writeBlobFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function removeEntryIfExists(
  dir: FileSystemDirectoryHandle,
  name: string,
  opts?: { recursive?: boolean },
): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: opts?.recursive })
  } catch {
    // ignore missing
  }
}

/** 按相对路径（a/b/c.txt）解析父目录与文件名 */
export async function resolveParentDir(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  create = false,
): Promise<{ parent: FileSystemDirectoryHandle; fileName: string }> {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) {
    throw new Error('空路径')
  }
  const fileName = parts[parts.length - 1]!
  let parent = root
  for (let i = 0; i < parts.length - 1; i++) {
    parent = await parent.getDirectoryHandle(parts[i]!, { create })
  }
  return { parent, fileName }
}

export async function writeFileAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  data: string | Blob,
): Promise<void> {
  const { parent, fileName } = await resolveParentDir(root, relativePath, true)
  if (typeof data === 'string') {
    await writeTextFile(parent, fileName, data)
  } else {
    await writeBlobFile(parent, fileName, data)
  }
}

export async function readFileAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File | null> {
  try {
    const { parent, fileName } = await resolveParentDir(
      root,
      relativePath,
      false,
    )
    const handle = await parent.getFileHandle(fileName)
    return await handle.getFile()
  } catch {
    return null
  }
}

export type DirEntry =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'directory'; name: string; path: string }

/** 列出目录直接子项 */
export async function listChildren(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<DirEntry[]> {
  const out: DirEntry[] = []
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'file') {
      out.push({ kind: 'file', name, path })
    } else {
      out.push({ kind: 'directory', name, path })
    }
  }
  return out
}

/** 递归列出文件相对路径 */
export async function listFilesRecursive(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<string[]> {
  const files: string[] = []
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'file') {
      files.push(path)
    } else if (handle.kind === 'directory') {
      const sub = await listFilesRecursive(handle, path)
      files.push(...sub)
    }
  }
  return files
}

export function guessMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}
