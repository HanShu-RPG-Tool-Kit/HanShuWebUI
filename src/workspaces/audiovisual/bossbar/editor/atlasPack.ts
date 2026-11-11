/**
 * 编辑器侧图集拼合：多张 RGBA 拼成唯一 PNG 所需的像素缓冲。
 * 不改协议——产物仍是文档内那一张 texture。
 */

import { BOSSBAR_DEFAULT_TEXTURE, BOSSBAR_LIMITS, type BossbarUv } from '../protocol'
import { decodeBase64, decodePngRgba, encodeBase64, encodePngRgba, pngInfo, type PngRgba } from '../png'

export type AtlasPackPlacement = BossbarUv

export type AtlasPackOk = {
  ok: true
  width: number
  height: number
  rgba: Uint8Array
  /** 追加图片在新图集中的 UV；不含基底 */
  appended: AtlasPackPlacement[]
  base64: string
}

export type AtlasPackErr = { ok: false; error: string }

const DEFAULT_GAP = 1

function copySprite(
  dest: Uint8Array,
  destWidth: number,
  sprite: PngRgba,
  x: number,
  y: number,
) {
  for (let row = 0; row < sprite.height; row += 1) {
    const srcStart = row * sprite.width * 4
    const destStart = ((y + row) * destWidth + x) * 4
    dest.set(sprite.rgba.subarray(srcStart, srcStart + sprite.width * 4), destStart)
  }
}

/** 竖排追加：基底固定左上，新图依次落在下方左对齐。 */
export function packAtlasImages(
  base: PngRgba | null,
  additions: PngRgba[],
  options?: { gap?: number; maxSide?: number; maxBytes?: number; maxDecodeBytes?: number },
): AtlasPackOk | AtlasPackErr {
  if (!additions.length) return { ok: false, error: '请至少选择一张 PNG' }
  const gap = options?.gap ?? DEFAULT_GAP
  const maxSide = options?.maxSide ?? BOSSBAR_LIMITS.texture.maxSide
  const maxBytes = options?.maxBytes ?? BOSSBAR_LIMITS.texture.maxBytes
  const maxDecodeBytes = options?.maxDecodeBytes ?? BOSSBAR_LIMITS.texture.decodeBytes

  for (const sprite of additions) {
    if (!sprite.width || !sprite.height) return { ok: false, error: 'PNG 尺寸无效' }
    if (sprite.width > maxSide || sprite.height > maxSide) {
      return { ok: false, error: 'PNG 尺寸超过 ' + maxSide }
    }
    if (sprite.rgba.length !== sprite.width * sprite.height * 4) {
      return { ok: false, error: 'RGBA 长度与尺寸不符' }
    }
  }

  let width = base?.width ?? 0
  let cursorY = 0
  const appended: AtlasPackPlacement[] = []
  if (base) {
    width = base.width
    cursorY = base.height + gap
  }

  for (const sprite of additions) {
    if (cursorY + sprite.height > maxSide) {
      return { ok: false, error: '拼合后尺寸超过 ' + maxSide }
    }
    appended.push({ x: 0, y: cursorY, width: sprite.width, height: sprite.height })
    width = Math.max(width, sprite.width)
    cursorY += sprite.height + gap
  }

  const height = cursorY - gap
  if (!width || height <= 0) return { ok: false, error: '拼合结果为空' }
  if (width * height * 4 > maxDecodeBytes) {
    return { ok: false, error: '拼合后解码内存超过预算' }
  }

  const rgba = new Uint8Array(width * height * 4)
  if (base) copySprite(rgba, width, base, 0, 0)
  for (let index = 0; index < additions.length; index += 1) {
    const place = appended[index]
    copySprite(rgba, width, additions[index], place.x, place.y)
  }

  let encoded: Uint8Array
  try {
    encoded = encodePngRgba({ width, height, rgba })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'PNG 编码失败' }
  }
  if (encoded.length > maxBytes) {
    return { ok: false, error: '拼合后 PNG ' + encoded.length + ' 字节，超过上限 ' + maxBytes }
  }
  return {
    ok: true,
    width,
    height,
    rgba,
    appended,
    base64: encodeBase64(encoded),
  }
}

/** 新建文档的默认 1×1 透明底图视为空基底，避免追加时留下无用像素。 */
export function shouldDiscardDefaultBase(textureBase64: string): boolean {
  return !textureBase64 || textureBase64 === BOSSBAR_DEFAULT_TEXTURE
}

export function appendAtlasFromRgba(
  textureBase64: string,
  base: PngRgba | null,
  additions: PngRgba[],
  options?: { gap?: number; maxSide?: number; maxBytes?: number; maxDecodeBytes?: number },
): AtlasPackOk | AtlasPackErr {
  const keepBase = base && !shouldDiscardDefaultBase(textureBase64) ? base : null
  return packAtlasImages(keepBase, additions, options)
}

/** 仅支持可纯 JS 解码的真彩 PNG；浏览器侧请先解码再调用 appendAtlasFromRgba。 */
export function appendAtlasFromPngBytes(
  textureBase64: string,
  additionBytes: Uint8Array[],
  options?: { gap?: number; maxSide?: number; maxBytes?: number; maxDecodeBytes?: number },
): AtlasPackOk | AtlasPackErr {
  const maxSide = options?.maxSide ?? BOSSBAR_LIMITS.texture.maxSide
  let base: PngRgba | null = null
  if (textureBase64 && !shouldDiscardDefaultBase(textureBase64)) {
    const baseBytes = decodeBase64(textureBase64)
    if (!baseBytes) return { ok: false, error: '当前图集 Base64 无效' }
    const info = pngInfo(baseBytes)
    if (!info) return { ok: false, error: '当前图集不是有效的 PNG' }
    if (info.apng) return { ok: false, error: '不接受 APNG：动画必须来自显式 UV 序列' }
    base = decodePngRgba(baseBytes)
    if (!base) return { ok: false, error: '当前图集无法解码，请改用浏览器环境追加' }
  }

  const additions: PngRgba[] = []
  for (const bytes of additionBytes) {
    if (bytes.length > (options?.maxBytes ?? BOSSBAR_LIMITS.texture.maxBytes)) {
      return { ok: false, error: 'PNG ' + bytes.length + ' 字节，超过上限' }
    }
    const info = pngInfo(bytes)
    if (!info) return { ok: false, error: '这不是有效的 PNG' }
    if (info.apng) return { ok: false, error: '不接受 APNG：动画必须来自显式 UV 序列' }
    if (info.width > maxSide || info.height > maxSide) {
      return { ok: false, error: 'PNG 尺寸超过 ' + maxSide }
    }
    const rgba = decodePngRgba(bytes)
    if (!rgba) return { ok: false, error: '仅支持 8-bit RGB/RGBA PNG 追加（测试路径）' }
    additions.push(rgba)
  }
  return appendAtlasFromRgba(textureBase64, base, additions, options)
}
