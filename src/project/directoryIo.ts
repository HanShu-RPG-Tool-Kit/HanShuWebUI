/** Project directory navigation and explicit server commands. No browser filesystem mutation. */
import { ProjectDirectory, requestProjectConnection } from './serviceClient'
import { ServiceError } from '../collab/protocol'
export { ProjectDirectory }
export function supportsDirectoryPicker(): boolean { return true }
export async function pickProjectDirectory(mode: 'open' | 'create' = 'open'): Promise<ProjectDirectory> { return (await requestProjectConnection(mode)).root() }
export async function ensureReadWritePermission(dir: ProjectDirectory): Promise<boolean> { return dir.client.writable }
export async function readTextFile(dir: ProjectDirectory, name: string): Promise<string | null> { return dir.client.text(dir.resolve(name)) }
export async function writeTextFile(dir: ProjectDirectory, name: string, content: string): Promise<void> { await writeFileAtPath(dir, name, content) }
export async function writeBlobFile(dir: ProjectDirectory, name: string, content: Blob): Promise<void> { await writeFileAtPath(dir, name, content) }
export async function writeFileAtPath(dir: ProjectDirectory, path: string, data: string | Blob): Promise<void> { await dir.client.apply([{ op: 'write', path: dir.resolve(path), data }]) }
export async function removeEntryIfExists(dir: ProjectDirectory, path: string, _opts?: { recursive?: boolean }): Promise<void> {
  const full = dir.resolve(path)
  if (dir.client.entry(full)) await dir.client.apply([{ op: 'remove', path: full }])
}
export async function removeFileAtPath(dir: ProjectDirectory, path: string): Promise<void> { await removeEntryIfExists(dir, path) }
export async function removeDirectoryAtPath(dir: ProjectDirectory, path: string): Promise<void> { await removeEntryIfExists(dir, path) }
export async function resolveParentDir(root: ProjectDirectory, path: string, create = false): Promise<{parent: ProjectDirectory; fileName: string}> {
  const full = root.resolve(path); const split = full.lastIndexOf('/'); const parentPath = split < 0 ? '' : full.slice(0, split)
  if (create && parentPath && !root.client.entry(parentPath)) await root.client.apply([{ op: 'mkdir', path: parentPath }])
  return { parent: new ProjectDirectory(root.client, parentPath), fileName: full.slice(split + 1) }
}
export async function readFileAtPath(root: ProjectDirectory, path: string): Promise<File | null> {
  try { return await root.client.read(root.resolve(path)) }
  catch (e) { if (e instanceof ServiceError && e.code === 'not_found') return null; throw e }
}
export type DirEntry = {kind: 'file' | 'directory'; name: string; path: string}
export async function listChildren(dir: ProjectDirectory, prefix = ''): Promise<DirEntry[]> {
  const out: DirEntry[] = []; for await (const [name, handle] of dir.entries()) out.push({ kind: handle.kind, name, path: prefix ? `${prefix}/${name}` : name }); return out
}
export async function listFilesRecursive(dir: ProjectDirectory, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for await (const [name, handle] of dir.entries()) { const path = prefix ? `${prefix}/${name}` : name; if (handle.kind === 'file') out.push(path); else out.push(...await listFilesRecursive(handle as ProjectDirectory, path)) }
  return out
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
  // 「引用资产」配音：一行路径的文本文件。标成 text/plain 才会被当成可读文本
  // （见 assets/paths 的 isTextAsset），否则资源管理器里只会显示"此类型暂无预览"
  if (lower.endsWith('.ref')) return 'text/plain'
  return 'application/octet-stream'
}
