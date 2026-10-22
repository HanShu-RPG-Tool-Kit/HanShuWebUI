export type RecentConnection = { url: string; projectId: string; projectName: string; username: string; lastConnected: number }
const key = 'hanshu.recentConnections.v1'
export function connectionUrl(input: string) {
  const url = new URL(input, window.location.href)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP 或 HTTPS 服务地址')
  return url.href.replace(/\/$/, '')
}
export function recentConnections(): RecentConnection[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(values)) return []
    return values.filter((v): v is RecentConnection => !!v && typeof v.url === 'string' && typeof v.projectId === 'string' && typeof v.projectName === 'string' && typeof v.username === 'string' && Number.isFinite(v.lastConnected)).filter(v => { try { return connectionUrl(v.url) === v.url } catch { return false } }).slice(0, 12).map(v=>({url:v.url,projectId:v.projectId,projectName:v.projectName,username:v.username,lastConnected:v.lastConnected}))
  } catch { return [] }
}
export function rememberConnection(value: Omit<RecentConnection, 'lastConnected'>) {
  const entry = { url: connectionUrl(value.url), projectId:value.projectId, projectName:value.projectName, username:value.username, lastConnected: Date.now() }
  try { localStorage.setItem(key, JSON.stringify([entry, ...recentConnections().filter(v => v.url !== entry.url || v.projectId !== entry.projectId)].slice(0, 12))) } catch { /* Optional UI preference. */ }
}
export function removeRecent(url: string) { try { localStorage.setItem(key, JSON.stringify(recentConnections().filter(v => v.url !== url))) } catch { /* Optional UI preference. */ } }
