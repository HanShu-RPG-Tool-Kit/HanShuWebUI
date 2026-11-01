import { BOSSBAR_LIMITS } from '../protocol'
import { base64ToBytes, decodedTextureBytes, pngInfo } from '../png'

/** Decoded textures are shared by exact source content and retained by their users. */
export type BossbarTexture = {
  key: string
  base64: string
  image: CanvasImageSource
  width: number
  height: number
}

type CacheEntry = {
  texture: BossbarTexture
  bytes: number
  references: number
  discardOnRelease: boolean
}

type PendingTexture = {
  promise: Promise<BossbarTexture | null>
  references: number
  discardOnRelease: boolean
}

export const BOSSBAR_TEXTURE_CACHE_BYTES = 128 * 1024 * 1024
// Exact Base64 keys also compare the complete content, including when fingerprints collide.
const cache = new Map<string, CacheEntry>()
const pending = new Map<string, PendingTexture>()
let decodedBytes = 0
let reservedBytes = 0

/** Full-content fingerprint for diagnostics; cache identity always uses the source itself. */
export function textureKey(base64: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < base64.length; index += 1) {
    hash ^= base64.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16) + '-' + base64.length
}

export function textureSizeOf(base64: string): { width: number; height: number } | null {
  const bytes = base64ToBytes(base64)
  const info = bytes ? pngInfo(bytes) : null
  return info ? { width: info.width, height: info.height } : null
}

function touch(source: string, entry: CacheEntry): void {
  cache.delete(source)
  cache.set(source, entry)
}

function dispose(source: string, entry: CacheEntry): void {
  cache.delete(source)
  decodedBytes -= entry.bytes
  if (typeof ImageBitmap !== 'undefined' && entry.texture.image instanceof ImageBitmap) {
    entry.texture.image.close()
  }
}

function reserve(bytes: number): void {
  for (const [source, entry] of cache) {
    if (decodedBytes + reservedBytes + bytes <= BOSSBAR_TEXTURE_CACHE_BYTES) break
    if (entry.references === 0) dispose(source, entry)
  }
  if (decodedBytes + reservedBytes + bytes > BOSSBAR_TEXTURE_CACHE_BYTES) {
    throw new Error('已使用的图集达到 128 MiB 解码预算，请关闭其他血条文档并重新打开当前文档。')
  }
  reservedBytes += bytes
}

/** Read-only lookup; callers that display a texture must obtain a reference with loadBossbarTexture. */
export function peekTexture(base64: string): BossbarTexture | null {
  const entry = cache.get(base64)
  if (!entry) return null
  touch(base64, entry)
  return entry.texture
}

async function decode(
  base64: string,
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<BossbarTexture | null> {
  const key = textureKey(base64)
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' })
  try {
    const bitmap = await createImageBitmap(blob)
    if (bitmap.width !== width || bitmap.height !== height) {
      bitmap.close()
      return null
    }
    return { key, base64, image: bitmap, width, height }
  } catch {
    const url = URL.createObjectURL(blob)
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('PNG 无法解码'))
        element.src = url
      })
      if (image.naturalWidth !== width || image.naturalHeight !== height) return null
      return { key, base64, image, width, height }
    } catch {
      return null
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

/** Each successful call acquires one reference; release it with releaseBossbarTexture. */
export async function loadBossbarTexture(base64: string): Promise<BossbarTexture | null> {
  const hit = cache.get(base64)
  if (hit) {
    hit.references += 1
    touch(base64, hit)
    return hit.texture
  }
  const inFlight = pending.get(base64)
  if (inFlight) {
    inFlight.references += 1
    return inFlight.promise
  }
  const bytes = base64ToBytes(base64)
  const info = bytes ? pngInfo(bytes) : null
  if (!bytes || !info || info.apng) return null
  const memory = decodedTextureBytes(info.width, info.height)
  if (bytes.byteLength > BOSSBAR_LIMITS.texture.maxBytes ||
      info.width > BOSSBAR_LIMITS.texture.maxSide || info.height > BOSSBAR_LIMITS.texture.maxSide ||
      memory > BOSSBAR_LIMITS.texture.decodeBytes) return null
  reserve(memory)
  let reservationHeld = true
  const releaseReservation = () => {
    if (!reservationHeld) return
    reservationHeld = false
    reservedBytes -= memory
  }
  const request: PendingTexture = {
    references: 1,
    discardOnRelease: false,
    promise: Promise.resolve(null),
  }
  request.promise = decode(base64, bytes, info.width, info.height).then((texture) => {
    releaseReservation()
    if (texture) {
      decodedBytes += memory
      cache.set(base64, {
        texture,
        bytes: memory,
        references: request.references,
        discardOnRelease: request.discardOnRelease,
      })
    }
    return texture
  }).finally(() => {
    releaseReservation()
    if (pending.get(base64) === request) pending.delete(base64)
  })
  pending.set(base64, request)
  return request.promise
}

/** Release exactly one successfully acquired reference. Active textures are never evicted. */
export function releaseBossbarTexture(texture: BossbarTexture): void {
  const entry = cache.get(texture.base64)
  if (!entry || entry.texture !== texture || entry.references === 0) return
  entry.references -= 1
  if (entry.references === 0 && entry.discardOnRelease) dispose(texture.base64, entry)
  else touch(texture.base64, entry)
}

/** Clear idle entries immediately and dispose retained/pending entries after their last release. */
export function clearTextureCache(): void {
  for (const [source, entry] of cache) {
    if (entry.references === 0) dispose(source, entry)
    else entry.discardOnRelease = true
  }
  for (const request of pending.values()) request.discardOnRelease = true
}
