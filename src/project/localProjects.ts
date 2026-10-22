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
