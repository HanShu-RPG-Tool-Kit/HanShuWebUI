import { request, type Connection } from '../collab/protocol'

export type LocalDirectory = { id: string; name: string; path: string }
export type LocalDirectoryListing = { directory: LocalDirectory; parent: LocalDirectory | null; entries: LocalDirectory[]; truncated: boolean }
export type LocalProjectHost = { connection: Connection; roots: LocalDirectory[] }
export type LocalProjectConnection = { url: string; token: string; path: string }

/** Discovery uses the local page's service, never the saved remote project URL. */
export async function discoverLocalProjectHost(): Promise<LocalProjectHost | null> {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return null
  const url = import.meta.env.DEV || window.location.port === '4173' ? '/__project' : window.location.origin
  try {
    const value = await request<{ service: string; version: number; token: string; roots: LocalDirectory[] }>({ url, token: '' }, '/api/local/bootstrap')
    if (value.service !== 'hanshu-local-projects' || value.version !== 1 || typeof value.token !== 'string' || !value.token || !Array.isArray(value.roots) || !value.roots.every(root => root && typeof root.id === 'string' && typeof root.name === 'string' && typeof root.path === 'string')) return null
    return { connection: { url, token: value.token }, roots: value.roots }
  } catch { return null }
}

/** Compare host-returned paths; Windows drive letters are case-insensitive. */
function normalizeLocalPath(path: string) {
  const value = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[A-Za-z]:/.test(value) ? value[0].toLowerCase() + value.slice(1) : value
}

function pathUnder(root: string, target: string) {
  const base = normalizeLocalPath(root)
  const next = normalizeLocalPath(target)
  if (next === base) return true
  const prefix = base.endsWith(':') ? `${base}/` : `${base}/`
  return next.startsWith(prefix)
}

/**
 * 用宿主目录浏览把已记住的绝对路径重新解析成临时 directoryId。
 * 不把路径交给 /api/local/open，符合本机宿主“只接受目录 ID”的边界。
 */
export async function resolveLocalDirectory(host: LocalProjectHost, targetPath: string): Promise<LocalDirectory> {
  const target = normalizeLocalPath(targetPath)
  const root = [...host.roots]
    .filter(item => pathUnder(item.path, targetPath))
    .sort((a, b) => normalizeLocalPath(b.path).length - normalizeLocalPath(a.path).length)[0]
  if (!root) throw new Error('找不到该工程路径对应的本机位置，请重新浏览选择')
  let current = root
  if (normalizeLocalPath(current.path) === target) return current
  const remainder = target.slice(normalizeLocalPath(current.path).replace(/\/$/, '').length).replace(/^\//, '')
  for (const segment of remainder.split('/').filter(Boolean)) {
    const listing = await request<LocalDirectoryListing>(
      host.connection,
      `/api/local/directories?directoryId=${encodeURIComponent(current.id)}&filter=${encodeURIComponent(segment)}`,
    )
    const match = listing.entries.find(entry => entry.name.localeCompare(segment, undefined, { sensitivity: 'accent' }) === 0)
      ?? listing.entries.find(entry => entry.name.toLowerCase() === segment.toLowerCase())
    if (!match) throw new Error(`目录已不存在或无法访问：${segment}`)
    current = match
  }
  if (normalizeLocalPath(current.path) !== target) throw new Error('目录路径已变化，请重新浏览选择')
  return current
}
