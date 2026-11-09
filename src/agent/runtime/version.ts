/**
 * 内容版本（`ContentVersion`）= 文件正文的 SHA-256 十六进制。
 *
 * 为什么用内容哈希而不是递增计数器：锁协议要把「模型读到的版本」与「当前版本」比较，
 * 文本改了又改回去时内容其实没变，不应算冲突（文档 §8「版本标识 = 文件内容哈希」）。
 * S 侧同样用内容哈希做 CAS，本层口径一致，保存时才不会出现两套版本语义。
 *
 * 用 `crypto.subtle` 而不是引第三方哈希库：Node 26 与浏览器同源实现。
 */
import type {
  AgentFileWorld,
  AgentPath,
  ContentVersion,
  VersionedFile,
} from '../contracts'

const encoder = new TextEncoder()

/** 正文 → 版本。同内容同版本，不同内容不同版本。 */
export async function contentVersion(text: string): Promise<ContentVersion> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toHex(new Uint8Array(digest))
}

/**
 * 读当前内容并拿到版本；文件不存在返回 null。
 * 所有「文件此刻是哪一版」的判断都走这里，避免版本口径分散到锁表／撤销日志／工具层。
 */
export async function versionedFile(
  world: AgentFileWorld,
  path: AgentPath,
): Promise<VersionedFile | null> {
  const current = await world.read(path)
  if (current === null) return null
  // world.read 约定已经带 version；缺省时现算一次，保证上层永远拿到真哈希
  if (current.version) return current
  return { content: current.content, version: await contentVersion(current.content) }
}

/** 只要版本、不要正文时的便捷入口（不存在 → null）。 */
export async function currentVersion(
  world: AgentFileWorld,
  path: AgentPath,
): Promise<ContentVersion | null> {
  const file = await versionedFile(world, path)
  return file === null ? null : file.version
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
