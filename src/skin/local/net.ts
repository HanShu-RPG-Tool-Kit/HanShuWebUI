/**
 * Browser / Tauri network helpers for PNG URL + Mojang player-name import.
 * Desktop prefers Tauri IPC (skin-core safe_fetch); browser uses fetch + Vite
 * Mojang proxies (CORS).
 */

import { SkinApiError } from '../contracts/types'
import type { SkinModel } from '../contracts/types'

const MAX_PNG_BYTES = 512 * 1024
const USER_AGENT = 'HanShuWebUI-skin-manager/0.1 (+web)'
const FETCH_TIMEOUT_MS = 30_000

const NAME_LOOKUP_DIRECT =
  'https://api.minecraftservices.com/minecraft/profile/lookup/name/'
const SESSION_DIRECT =
  'https://sessionserver.mojang.com/session/minecraft/profile/'

/** Dev / Vite-served same-origin proxies (see vite.config.ts). */
const NAME_LOOKUP_PROXY = '/__skin_net/name/'
const SESSION_PROXY = '/__skin_net/session/'

export type ResolvedPlayerSkin = {
  uuid: string
  playerName: string
  skinUrl: string
  model: SkinModel
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function useMojangProxy(): boolean {
  // Proxied only when served from Vite (dev / preview with proxy).
  return Boolean(import.meta.env.DEV) || location.hostname === 'localhost'
}

function nameLookupBase(): string {
  return useMojangProxy() ? NAME_LOOKUP_PROXY : NAME_LOOKUP_DIRECT
}

function sessionBase(): string {
  return useMojangProxy() ? SESSION_PROXY : SESSION_DIRECT
}

function isForbiddenIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

/** Validate caller-supplied image URL (browser-side; Tauri re-checks in Rust). */
export function validateFetchUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new SkinApiError({ code: 'FETCH_FAILED', message: '无效的 URL' })
  }
  if (u.protocol === 'http:' && u.hostname === 'textures.minecraft.net') {
    u.protocol = 'https:'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SkinApiError({
      code: 'FETCH_FAILED',
      message: `不允许的协议 ${u.protocol}`,
    })
  }
  if (u.username || u.password) {
    throw new SkinApiError({
      code: 'FETCH_FAILED',
      message: 'URL 不允许带凭据',
    })
  }
  if (u.port) {
    const expected = u.protocol === 'https:' ? '443' : '80'
    if (u.port !== expected) {
      throw new SkinApiError({
        code: 'FETCH_FAILED',
        message: `不允许非标准端口 ${u.port}`,
      })
    }
  }
  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    isForbiddenIpv4(host)
  ) {
    throw new SkinApiError({
      code: 'FETCH_FORBIDDEN_ADDRESS',
      message: `地址 ${host} 不允许`,
    })
  }
  return u
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function tauriFetchPng(url: string): Promise<Uint8Array> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const b64 = await invoke<string>('skin_net_fetch_png', { url })
    return b64ToBytes(b64)
  } catch (e) {
    throw mapInvokeError(e)
  }
}

async function tauriResolvePlayer(name: string): Promise<ResolvedPlayerSkin> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const r = await invoke<{
      uuid: string
      playerName: string
      skinUrl: string
      model: string
    }>('skin_net_resolve_player', { name })
    return {
      uuid: r.uuid,
      playerName: r.playerName,
      skinUrl: r.skinUrl,
      model: r.model === 'slim' ? 'slim' : 'classic',
    }
  } catch (e) {
    throw mapInvokeError(e)
  }
}

async function browserFetchBytes(url: string, accept: string): Promise<Uint8Array> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: accept,
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (res.status === 404) {
      throw new SkinApiError({ code: 'FETCH_FAILED', message: '资源不存在 (404)' })
    }
    if (res.status === 429) {
      throw new SkinApiError({
        code: 'PLAYER_RATE_LIMITED',
        message: '请求过于频繁，请稍后重试',
      })
    }
    if (!res.ok) {
      throw new SkinApiError({
        code: 'FETCH_FAILED',
        message: `下载失败 HTTP ${res.status}`,
      })
    }
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_PNG_BYTES) {
      throw new SkinApiError({
        code: 'FETCH_FAILED',
        message: `响应过大 (${len} bytes)`,
      })
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_PNG_BYTES) {
      throw new SkinApiError({
        code: 'FETCH_FAILED',
        message: `响应过大 (${buf.byteLength} bytes)`,
      })
    }
    return buf
  } catch (e) {
    if (e instanceof SkinApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new SkinApiError({ code: 'FETCH_TIMEOUT', message: '下载超时' })
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
      throw new SkinApiError({
        code: 'FETCH_FAILED',
        message:
          '无法下载（可能被 CORS 拦截）。请换 textures.minecraft.net 等允许跨域的地址，或使用桌面版。',
      })
    }
    throw new SkinApiError({ code: 'FETCH_FAILED', message: msg })
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchPngBytes(rawUrl: string): Promise<{
  bytes: Uint8Array
  finalUrl: string
  fileName: string
}> {
  const u = validateFetchUrl(rawUrl)
  const url = u.toString()
  const bytes = isTauri()
    ? await tauriFetchPng(url)
    : await browserFetchBytes(url, 'image/png,image/*;q=0.8,*/*;q=0.5')
  const fileName =
    u.pathname.split('/').filter(Boolean).pop() || 'skin.png'
  return { bytes, finalUrl: url, fileName }
}

function urlencodeName(name: string): string {
  return encodeURIComponent(name.trim())
}

function isValidPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name.trim())
}

async function browserResolvePlayer(playerName: string): Promise<ResolvedPlayerSkin> {
  const name = playerName.trim()
  if (!isValidPlayerName(name)) {
    throw new SkinApiError({
      code: 'PLAYER_NOT_FOUND',
      message: `无效的玩家名: ${name}`,
    })
  }

  let nameJson: { id?: string; name?: string }
  try {
    const raw = await browserFetchBytes(
      `${nameLookupBase()}${urlencodeName(name)}`,
      'application/json',
    )
    nameJson = JSON.parse(new TextDecoder().decode(raw)) as {
      id?: string
      name?: string
    }
  } catch (e) {
    if (e instanceof SkinApiError && e.code === 'FETCH_FAILED') {
      throw new SkinApiError({
        code: 'PLAYER_NOT_FOUND',
        message: `找不到玩家: ${name}`,
      })
    }
    throw e
  }
  const uuid = nameJson.id
  if (!uuid) {
    throw new SkinApiError({
      code: 'PLAYER_NOT_FOUND',
      message: `找不到玩家: ${name}`,
    })
  }
  const canonical = nameJson.name ?? name

  const profileRaw = await browserFetchBytes(
    `${sessionBase()}${uuid}?unsigned=false`,
    'application/json',
  )
  const profile = JSON.parse(new TextDecoder().decode(profileRaw)) as {
    properties?: Array<{ name?: string; value?: string }>
  }
  const texProp = profile.properties?.find((p) => p.name === 'textures')?.value
  if (!texProp) {
    throw new SkinApiError({
      code: 'PLAYER_NO_SKIN',
      message: '该玩家没有皮肤属性',
    })
  }
  let tex: {
    textures?: {
      SKIN?: { url?: string; metadata?: { model?: string } }
    }
  }
  try {
    tex = JSON.parse(atob(texProp)) as typeof tex
  } catch {
    throw new SkinApiError({
      code: 'PLAYER_SERVICE_UNAVAILABLE',
      message: '无法解析皮肤纹理数据',
    })
  }
  const skin = tex.textures?.SKIN
  const skinUrl = skin?.url
  if (!skinUrl) {
    throw new SkinApiError({
      code: 'PLAYER_NO_SKIN',
      message: '该玩家没有自定义皮肤',
    })
  }
  let parsed: URL
  try {
    parsed = new URL(skinUrl)
  } catch {
    throw new SkinApiError({ code: 'PLAYER_NO_SKIN', message: '皮肤 URL 无效' })
  }
  if (parsed.hostname !== 'textures.minecraft.net') {
    throw new SkinApiError({
      code: 'PLAYER_NO_SKIN',
      message: `意外的皮肤主机: ${parsed.hostname}`,
    })
  }
  const model: SkinModel =
    skin?.metadata?.model === 'slim' ? 'slim' : 'classic'
  return {
    uuid,
    playerName: canonical,
    skinUrl: parsed.protocol === 'http:' ? parsed.href.replace(/^http:/, 'https:') : parsed.href,
    model,
  }
}

export async function resolvePlayerSkin(
  playerName: string,
): Promise<ResolvedPlayerSkin> {
  if (isTauri()) {
    return tauriResolvePlayer(playerName)
  }
  return browserResolvePlayer(playerName)
}

function mapInvokeError(e: unknown): SkinApiError {
  if (e instanceof SkinApiError) return e
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const err = e as { code: string; message: string }
    return new SkinApiError({ code: err.code, message: err.message })
  }
  return new SkinApiError({
    code: 'FETCH_FAILED',
    message: e instanceof Error ? e.message : String(e),
  })
}

export async function fetchPlayerSkinPng(playerName: string): Promise<{
  bytes: Uint8Array
  resolved: ResolvedPlayerSkin
  fileName: string
}> {
  const resolved = await resolvePlayerSkin(playerName)
  const { bytes } = await fetchPngBytes(resolved.skinUrl)
  return {
    bytes,
    resolved,
    fileName: resolved.playerName,
  }
}
