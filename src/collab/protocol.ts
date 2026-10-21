/** Protocol v3: one server-owned directory project shared by every workspace. */
export type { Role, Subject, Session, Lease, ResourceInfo, Resource, Snapshot } from './generated'
export type Connection = { url: string; token: string }

export class ServiceError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
export function endpoint(base: string, path: string) { return `${base.replace(/\/$/, '')}${path}` }
export async function request<T>(connection: Connection, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(endpoint(connection.url, path), {
    method, headers: { 'Content-Type': 'application/json', ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), cache: 'no-store',
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new ServiceError(value?.code ?? 'network', value?.message ?? `服务请求失败（${response.status}）`)
  return value as T
}
export function socketUrl(base: string) { const url = new URL(endpoint(base, '/api/events'), window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.href }
