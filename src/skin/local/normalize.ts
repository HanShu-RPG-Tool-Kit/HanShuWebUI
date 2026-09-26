/**
 * PNG → 64x64 RGBA 规范化（对照 skin-core normalize.rs，用 Canvas 解码）
 */

import type { SkinModel } from '../contracts/types'
import {
  FormatError,
  RGBA_LENGTH,
  SKIN_HEIGHT,
  SKIN_WIDTH,
  limits,
} from './codec'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const BASE_REGIONS: [number, number, number, number][] = [
  [0, 8, 32, 16],
  [16, 20, 40, 32],
  [40, 20, 56, 32],
  [0, 20, 16, 32],
  [32, 52, 48, 64],
  [16, 52, 32, 64],
]

const HAT_REGION_32: [number, number, number, number] = [32, 0, 64, 16]

function inRegion(
  x: number,
  y: number,
  r: [number, number, number, number],
): boolean {
  return x >= r[0] && x < r[2] && y >= r[1] && y < r[3]
}

function inspectPng(buf: Uint8Array): {
  width: number
  height: number
  isApng: boolean
} {
  if (buf.length < 33 || !PNG_SIG.every((b, i) => buf[i] === b)) {
    throw new FormatError('NOT_PNG', 'missing PNG signature')
  }
  const ihdrLen =
    (buf[8]! << 24) | (buf[9]! << 16) | (buf[10]! << 8) | buf[11]!
  if (ihdrLen !== 13 || String.fromCharCode(...buf.slice(12, 16)) !== 'IHDR') {
    throw new FormatError('BAD_PNG', 'first chunk is not IHDR')
  }
  const width =
    (buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!
  const height =
    (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!
  let off = 8 + 4 + 4 + ihdrLen + 4
  let isApng = false
  while (off + 8 <= buf.length) {
    const len =
      (buf[off]! << 24) |
      (buf[off + 1]! << 16) |
      (buf[off + 2]! << 8) |
      buf[off + 3]!
    const typ = String.fromCharCode(
      buf[off + 4]!,
      buf[off + 5]!,
      buf[off + 6]!,
      buf[off + 7]!,
    )
    if (typ === 'acTL') {
      isApng = true
      break
    }
    if (typ === 'IDAT') break
    const next = off + 4 + 4 + len + 4
    if (next > buf.length) break
    off = next
  }
  return { width, height, isApng }
}

function expandLegacy32(src: Uint8Array): Uint8Array {
  const w = SKIN_WIDTH
  const out = new Uint8Array(RGBA_LENGTH)
  out.set(src.subarray(0, w * 32 * 4))
  const copyMirrored = (
    sx0: number,
    sy0: number,
    dx0: number,
    dy0: number,
    cw: number,
    ch: number,
  ) => {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = ((sy0 + y) * w + (sx0 + x)) * 4
        const di = ((dy0 + y) * w + (dx0 + (cw - 1 - x))) * 4
        out[di] = src[si]!
        out[di + 1] = src[si + 1]!
        out[di + 2] = src[si + 2]!
        out[di + 3] = src[si + 3]!
      }
    }
  }
  copyMirrored(40, 20, 32, 52, 16, 12)
  copyMirrored(0, 16, 16, 52, 16, 12)
  return out
}

function applyAlphaRules(rgba: Uint8Array, isLegacy: boolean): void {
  const w = SKIN_WIDTH
  for (let y = 0; y < SKIN_HEIGHT; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const base = BASE_REGIONS.some((r) => inRegion(x, y, r))
      const hat32 = isLegacy && inRegion(x, y, HAT_REGION_32)
      if (base && !hat32) {
        rgba[i + 3] = 255
      }
      if (rgba[i + 3] === 0) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
      }
    }
  }
}

async function decodePngToRgba(buf: Uint8Array): Promise<{
  width: number
  height: number
  rgba: Uint8Array
}> {
  const blob = new Blob([buf.buffer as ArrayBuffer], { type: 'image/png' })
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new FormatError('BAD_PNG', 'canvas unavailable')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return {
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8Array(imageData.data.buffer),
  }
}

export async function normalizePngBytes(
  buf: Uint8Array,
  _preferredModel?: SkinModel,
): Promise<{ rgba: Uint8Array; model: SkinModel }> {
  if (buf.length > limits.PNG_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `PNG ${buf.length} exceeds ${limits.PNG_BYTES}`,
    )
  }
  const header = inspectPng(buf)
  if (header.isApng) {
    throw new FormatError('BAD_PNG', 'APNG is not supported')
  }
  const okSize =
    (header.width === 64 && header.height === 64) ||
    (header.width === 64 && header.height === 32)
  if (!okSize) {
    throw new FormatError(
      'BAD_DIMENSIONS',
      `unsupported PNG size ${header.width}x${header.height}`,
    )
  }
  const decoded = await decodePngToRgba(buf)
  const isLegacy = decoded.height === 32
  let rgba = decoded.rgba
  if (isLegacy) {
    if (rgba.length !== 64 * 32 * 4) {
      throw new FormatError('BAD_PNG', 'unexpected legacy pixel buffer size')
    }
    rgba = expandLegacy32(rgba)
  } else if (rgba.length !== RGBA_LENGTH) {
    throw new FormatError('BAD_PNG', 'unexpected pixel buffer size')
  } else {
    rgba = new Uint8Array(rgba)
  }
  applyAlphaRules(rgba, isLegacy)
  // 模型默认 classic；slim 由调用方指定
  return { rgba, model: _preferredModel ?? 'classic' }
}

/** RGBA → PNG Blob（预览用） */
export async function rgbaToPngBlob(rgba: Uint8Array): Promise<Blob> {
  if (rgba.length !== RGBA_LENGTH) {
    throw new FormatError('BAD_RGBA_LENGTH', 'rgba must be 16384 bytes')
  }
  const canvas = document.createElement('canvas')
  canvas.width = SKIN_WIDTH
  canvas.height = SKIN_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new FormatError('BAD_PNG', 'canvas unavailable')
  const imageData = new ImageData(
    new Uint8ClampedArray(rgba),
    SKIN_WIDTH,
    SKIN_HEIGHT,
  )
  ctx.putImageData(imageData, 0, 0)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new FormatError('BAD_PNG', 'toBlob failed'))),
      'image/png',
    )
  })
}
