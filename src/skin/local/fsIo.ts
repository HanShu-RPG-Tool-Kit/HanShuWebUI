/** 基于 FileSystemDirectoryHandle 的相对路径读写 */

import {
  resolveParentDir,
  writeFileAtPath,
  writeTextFile,
} from '../../project/directoryIo'

export async function ensureDir(
  root: FileSystemDirectoryHandle,
  relativeDir: string,
): Promise<FileSystemDirectoryHandle> {
  const parts = relativeDir.replace(/\\/g, '/').split('/').filter(Boolean)
  let cur = root
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create: true })
  }
  return cur
}

export async function readTextAt(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<string | null> {
  try {
    const { parent, fileName } = await resolveParentDir(
      root,
      relativePath,
      false,
    )
    const fh = await parent.getFileHandle(fileName)
    const file = await fh.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export async function writeTextAt(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFileAtPath(root, relativePath, content)
}

export async function writeBytesAt(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  data: Uint8Array | Blob,
): Promise<void> {
  const blob =
    data instanceof Blob ? data : new Blob([data.buffer as ArrayBuffer])
  await writeFileAtPath(root, relativePath, blob)
}

export async function removeAt(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  recursive = false,
): Promise<void> {
  try {
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return
    if (parts.length === 1) {
      await root.removeEntry(parts[0]!, { recursive })
      return
    }
    const fileName = parts[parts.length - 1]!
    let parent = root
    for (let i = 0; i < parts.length - 1; i++) {
      parent = await parent.getDirectoryHandle(parts[i]!)
    }
    await parent.removeEntry(fileName, { recursive })
  } catch {
    // ignore
  }
}

export async function writeRootText(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  await writeTextFile(dir, name, content)
}
