/**
 * 本机 pak 发版：POST /publish → `<gamedir>/rpgtoolkit/pak/` + reload。
 * 协议见 RPGToolKit docs/publish-protocol.md（门户密码鉴权，仅 loopback）。
 */

import { httpBase } from './protocol'
import { loadGameDevServerPrefs } from './prefs'

export const AUTO_PUBLISH_PAK_NAME = 'auto.pak'

export type PublishKindStatus = {
  status?: string
  entryCount?: number
  errors?: string[]
}

export type PublishResult = {
  ok: boolean
  installed?: string[]
  root?: string
  publishedOrSkipped?: boolean
  kinds?: Record<string, PublishKindStatus>
  errors?: string[]
  error?: string
}

async function readPublishBody(res: Response): Promise<PublishResult> {
  const text = await res.text().catch(() => '')
  let body: PublishResult | null = null
  if (text) {
    try {
      body = JSON.parse(text) as PublishResult
    } catch {
      body = null
    }
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('unauthorized（密码错误或未带鉴权）')
    }
    const code = body?.error || text || `HTTP ${res.status}`
    throw new Error(String(code))
  }
  if (!body || typeof body !== 'object') {
    throw new Error('publish 响应不是 JSON')
  }
  return body
}

/** 单文件原始字节上传；默认文件名 `auto.pak`。 */
export async function publishPakBlob(
  blob: Blob,
  name = AUTO_PUBLISH_PAK_NAME,
  prefs = loadGameDevServerPrefs(),
): Promise<PublishResult> {
  const fileName = name.trim().toLowerCase().endsWith('.pak')
    ? name.trim()
    : `${name.trim() || 'auto'}.pak`
  const q = new URLSearchParams({ name: fileName })
  const res = await fetch(`${httpBase(prefs.host, prefs.port)}/publish?${q}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-DevTool-Password': prefs.password,
      'X-Pak-Name': fileName,
    },
    body: blob,
  })
  return readPublishBody(res)
}

export function summarizePublishResult(result: PublishResult): string {
  const installed = result.installed?.length
    ? result.installed.join(', ')
    : '（无新文件）'
  const kindBits = result.kinds
    ? Object.entries(result.kinds)
      .map(([kind, info]) => {
        const status = info.status ?? '?'
        const n = typeof info.entryCount === 'number' ? ` · ${info.entryCount}` : ''
        return `${kind}:${status}${n}`
      })
      .join('；')
    : ''
  const errs = [...(result.errors ?? [])]
  if (result.kinds) {
    for (const [kind, info] of Object.entries(result.kinds)) {
      for (const err of info.errors ?? []) errs.push(`${kind}: ${err}`)
    }
  }
  const parts = [`已安装 ${installed}`]
  if (kindBits) parts.push(kindBits)
  if (result.publishedOrSkipped === false) parts.push('部分 kind 保留旧表（RETAINED）')
  if (errs.length) parts.push(`错误：${errs.slice(0, 5).join('；')}`)
  return parts.join(' · ')
}
