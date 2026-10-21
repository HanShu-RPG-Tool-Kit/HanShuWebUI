import { ServiceError } from '../../collab/protocol'
import { ProjectDirectory } from '../../project/serviceClient'
/** 基于 ProjectDirectory 的相对路径读写 */

import {
  resolveParentDir,
  writeFileAtPath,
  writeTextFile,
} from '../../project/directoryIo'

export async function ensureDir(
  root: ProjectDirectory,
  relativeDir: string,
): Promise<ProjectDirectory> {
  // Parents are created by the server's atomic file transaction, including for read-only browsing.
  return new ProjectDirectory(root.client, root.resolve(relativeDir))
}

export async function readTextAt(
  root: ProjectDirectory,
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
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') return null
    throw e
  }
}

export async function readBytesAt(
  root: ProjectDirectory,
  relativePath: string,
): Promise<Uint8Array | null> {
  try {
    const { parent, fileName } = await resolveParentDir(
      root,
      relativePath,
      false,
    )
    const fh = await parent.getFileHandle(fileName)
    const file = await fh.getFile()
    return new Uint8Array(await file.arrayBuffer())
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') return null
    throw e
  }
}

export async function writeTextAt(
  root: ProjectDirectory,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFileAtPath(root, relativePath, content)
}

export async function writeBytesAt(
  root: ProjectDirectory,
  relativePath: string,
  data: Uint8Array | Blob,
): Promise<void> {
  const blob =
    data instanceof Blob ? data : new Blob([data.buffer as ArrayBuffer])
  await writeFileAtPath(root, relativePath, blob)
}

/** 列出相对目录下的直接子项名称（不存在则空数组）。 */
export async function listChildNames(
  root: ProjectDirectory,
  relativeDir: string,
): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
  try {
    const parts = relativeDir.replace(/\\/g, '/').split('/').filter(Boolean)
    let cur = root
    for (const part of parts) {
      cur = await cur.getDirectoryHandle(part)
    }
    const out: { name: string; kind: 'file' | 'directory' }[] = []
    for await (const [name, handle] of cur.entries()) {
      out.push({
        name,
        kind: handle.kind === 'directory' ? 'directory' : 'file',
      })
    }
    return out
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') return []
    throw e
  }
}

export async function removeAt(
  root: ProjectDirectory,
  relativePath: string,
  _recursive = false,
): Promise<void> {
  const path = root.resolve(relativePath)
  if (root.client.entry(path)) await root.client.apply([{ op: 'remove', path }])
}

export async function writeRootText(
  dir: ProjectDirectory,
  name: string,
  content: string,
): Promise<void> {
  await writeTextFile(dir, name, content)
}
