/** mchhui.rpgtoolkit.devtool.control — 本机控制面 WebSocket 帧 */

export type ControlRequest = {
  type: 'request'
  id: string
  method: string
  params: unknown
}

export type ControlNotify = {
  type: 'notify'
  method: string
  params: unknown
}

export type ControlResponse = {
  type: 'response'
  id: string
  ok?: boolean
  result?: unknown
  error?: string
}

export type ControlInbound = ControlRequest | ControlNotify | ControlResponse

export type ControlStatus = {
  ok: boolean
  subscribers?: number
  pending?: number
  wsPath?: string
}

export function httpBase(host: string, port: number): string {
  return `http://${host}:${port}`
}

export function controlWsUrl(host: string, port: number, password: string): string {
  const q = new URLSearchParams({ password })
  return `ws://${host}:${port}/ws/control?${q}`
}

export function controlStatusUrl(host: string, port: number, password: string): string {
  const q = new URLSearchParams({ password })
  return `${httpBase(host, port)}/control/status?${q}`
}

export function parseInbound(raw: string): ControlInbound | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type === 'request') {
    if (typeof obj.id !== 'string' || typeof obj.method !== 'string' || !obj.method) {
      return null
    }
    return {
      type: 'request',
      id: obj.id,
      method: obj.method,
      params: obj.params ?? null,
    }
  }
  if (type === 'notify') {
    if (typeof obj.method !== 'string' || !obj.method) return null
    return {
      type: 'notify',
      method: obj.method,
      params: obj.params ?? null,
    }
  }
  if (type === 'response') {
    if (typeof obj.id !== 'string') return null
    return {
      type: 'response',
      id: obj.id,
      ok: obj.ok !== false,
      result: obj.result,
      error: typeof obj.error === 'string' ? obj.error : undefined,
    }
  }
  return null
}

export async function fetchControlStatus(
  host: string,
  port: number,
  password: string,
): Promise<ControlStatus> {
  const res = await fetch(controlStatusUrl(host, port, password), {
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as ControlStatus
}
