/**
 * PNG → 规范化 RGBA（对照 skin-core normalize.rs，用 Canvas 解码）
 *
 * 支持输入（宽高为整数，64…1024）：
 *   - 正方形：宽 = 高
 *   - 半高：宽 = 2×高（64×32、128×64、任意偶数宽…），展开成正方形后入库
 * 不再要求宽为 64 倍数；UV 区按 width/64 比例映射。
 * SEMI_TRANSPARENT=0：原版 base 强制不透明；=1：保留任意 alpha。
 */

import type { SkinModel } from '../contracts/types'
import {
  FLAG_SEMI_TRANSPARENT,
  FormatError,
  MAX_TEXTURE_SIZE,
  SKIN_HEIGHT,
  SKIN_WIDTH,
  limits,
} from './codec'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Base UV regions forced opaque (non–semi-transparent mode). */
const BASE_REGIONS_64: [number, number, number, number][] = [
  [0, 8, 32, 16],
  [16, 20, 40, 32],
  [40, 20, 56, 32],
  [0, 20, 16, 32],
  [32, 52, 48, 64],
  [16, 52, 32, 64],
]

/** After Notch clear, restore these strips (PrismLauncher opaqueParts). */
const NOTCH_RESTORE_64: [number, number, number, number][] = [
  [0, 0, 32, 16],
  [0, 16, 64, 32],
  [16, 48, 48, 64],
]

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

/** 输入尺寸是否接受（入库前；半高会再展开成正方形）。 */
export function isSupportedSkinSize(width: number, height: number): boolean {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 64 ||
    width > MAX_TEXTURE_SIZE ||
    height <= 0
  ) {
    return false
  }
  if (height === width) return true
  // 半高：宽 = 2×高
  if (height * 2 === width) return true
  return false
}

/** 64 空间坐标 → 实际像素（整数比例，兼容非 64 倍数宽）。 */
function map64(coord: number, width: number): number {
  return Math.floor((coord * width) / 64)
}

/**
 * 半高贴图展开为正方形（64×32→64×64；128×64→128×128 …）。
 * 对齐 skinview-utils `convertSkinTo1_8`：逐面水平翻转，而非整块 16×12 翻转。
 * 右腿/右臂各面 → 左腿/左臂 UV；内外侧对调。
 */
function expandHalfHeight(src: Uint8Array, width: number): Uint8Array {
  const w = width
  const halfH = w / 2
  const out = new Uint8Array(w * w * 4)
  out.set(src.subarray(0, w * halfH * 4))
  const copyFace = (
    sx0: number,
    sy0: number,
    fw: number,
    fh: number,
    dx0: number,
    dy0: number,
  ) => {
    const sx = map64(sx0, w)
    const sy = map64(sy0, w)
    const dx = map64(dx0, w)
    const dy = map64(dy0, w)
    const fwS = map64(fw, w)
    const fhS = map64(fh, w)
    for (let y = 0; y < fhS; y++) {
      for (let x = 0; x < fwS; x++) {
        const si = ((sy + y) * w + (sx + x)) * 4
        const di = ((dy + y) * w + (dx + (fwS - 1 - x))) * 4
        out[di] = src[si]!
        out[di + 1] = src[si + 1]!
        out[di + 2] = src[si + 2]!
        out[di + 3] = src[si + 3]!
      }
    }
  }
  // Right leg → left leg
  copyFace(4, 16, 4, 4, 20, 48) // top
  copyFace(8, 16, 4, 4, 24, 48) // bottom
  copyFace(0, 20, 4, 12, 24, 52) // outer → left
  copyFace(4, 20, 4, 12, 20, 52) // front
  copyFace(8, 20, 4, 12, 16, 52) // inner → right
  copyFace(12, 20, 4, 12, 28, 52) // back
  // Right arm → left arm
  copyFace(44, 16, 4, 4, 36, 48) // top
  copyFace(48, 16, 4, 4, 40, 48) // bottom
  copyFace(40, 20, 4, 12, 40, 52) // outer → left
  copyFace(44, 20, 4, 12, 36, 52) // front
  copyFace(48, 20, 4, 12, 32, 52) // inner → right
  copyFace(52, 20, 4, 12, 44, 52) // back
  return out
}

function scaleRegion(
  r: [number, number, number, number],
  width: number,
): [number, number, number, number] {
  return [
    map64(r[0], width),
    map64(r[1], width),
    map64(r[2], width),
    map64(r[3], width),
  ]
}

/**
 * Legacy 64×32 skins (e.g. Notch) fill unused/hat areas with opaque black.
 * Minecraft clears the top-right 32×32 when that zone has no real transparency.
 * Must run after half-height expand; opaque base restore follows in applyAlphaRules.
 */
function applyNotchTransparencyHack(rgba: Uint8Array, width: number): void {
  const x0 = map64(32, width)
  const y0 = 0
  const x1 = map64(64, width)
  const y1 = map64(32, width)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (rgba[(y * width + x) * 4 + 3]! < 128) return
    }
  }
  // Only clear alpha — RGB must stay so restore can keep arm/body colors.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      rgba[(y * width + x) * 4 + 3] = 0
    }
  }
  for (const r of NOTCH_RESTORE_64) {
    const [rx0, ry0, rx1, ry1] = scaleRegion(r, width)
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        rgba[(y * width + x) * 4 + 3] = 255
      }
    }
  }
}

function applyAlphaRules(
  rgba: Uint8Array,
  width: number,
  height: number,
  semiTransparent: boolean,
): void {
  const baseRegions = BASE_REGIONS_64.map((r) => scaleRegion(r, width))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (!semiTransparent) {
        if (baseRegions.some((r) => inRegion(x, y, r))) {
          rgba[i + 3] = 255
        }
      }
      if (rgba[i + 3] === 0) {
        rgba[i] = 0
        rgba[i + 1] = 0
        rgba[i + 2] = 0
      }
    }
  }
}

export function detectSkinModel(
  rgba: Uint8Array,
  width: number,
  height: number,
): SkinModel {
  if (width !== height || width < 64) {
    return 'classic'
  }
  const x0 = map64(46, width)
  const x1 = map64(48, width)
  const y0 = map64(20, width)
  const y1 = map64(32, width)
  let opaque = 0
  let total = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      if (i + 3 >= rgba.length) continue
      total++
      if (rgba[i + 3]! > 0) opaque++
    }
  }
  if (total === 0) return 'classic'
  const threshold = Math.max(1, Math.floor(total / 4))
  return opaque < threshold ? 'slim' : 'classic'
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

export type NormalizedSkin = {
  rgba: Uint8Array
  model: SkinModel
  textureWidth: number
  textureHeight: number
  flags: number
  wasLegacy: boolean
}

export async function normalizePngBytes(
  buf: Uint8Array,
  preferredModel?: SkinModel,
  opts?: { semiTransparent?: boolean },
): Promise<NormalizedSkin> {
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
  if (!isSupportedSkinSize(header.width, header.height)) {
    throw new FormatError(
      'BAD_DIMENSIONS',
      `unsupported PNG size ${header.width}x${header.height}; need square (N×N) or half-height (2N×N) with N∈[64…${MAX_TEXTURE_SIZE}]`,
    )
  }
  const decoded = await decodePngToRgba(buf)
  if (decoded.width !== header.width || decoded.height !== header.height) {
    throw new FormatError('BAD_PNG', 'decoded size mismatch with IHDR')
  }
  const isHalfHeight = decoded.height === decoded.width / 2
  const expectedRaw = decoded.width * decoded.height * 4
  if (decoded.rgba.length !== expectedRaw) {
    throw new FormatError('BAD_PNG', 'unexpected pixel buffer size')
  }

  const semi = Boolean(opts?.semiTransparent)
  const flags = semi ? FLAG_SEMI_TRANSPARENT : 0

  let rgba: Uint8Array
  let textureWidth: number
  let textureHeight: number
  if (isHalfHeight) {
    rgba = expandHalfHeight(decoded.rgba, decoded.width)
    textureWidth = decoded.width
    textureHeight = decoded.width
    // Notch / opaque-legacy: clear unused hat zone before forcing base opaque.
    applyNotchTransparencyHack(rgba, textureWidth)
    applyAlphaRules(rgba, textureWidth, textureHeight, semi)
  } else {
    rgba = new Uint8Array(decoded.rgba)
    textureWidth = decoded.width
    textureHeight = decoded.height
    applyAlphaRules(rgba, textureWidth, textureHeight, semi)
  }

  const detected = isHalfHeight && textureWidth === 64
    ? 'classic'
    : detectSkinModel(rgba, textureWidth, textureHeight)
  const model = preferredModel ?? detected

  return {
    rgba,
    model,
    textureWidth,
    textureHeight,
    flags,
    wasLegacy: isHalfHeight,
  }
}

/** RGBA → PNG Blob（任意尺寸预览） */
export async function rgbaToPngBlob(
  rgba: Uint8Array,
  width = SKIN_WIDTH,
  height = SKIN_HEIGHT,
): Promise<Blob> {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new FormatError(
      'BAD_RGBA_LENGTH',
      `rgba must be ${expected} bytes`,
    )
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new FormatError('BAD_PNG', 'canvas unavailable')
  const imageData = new ImageData(
    new Uint8ClampedArray(rgba),
    width,
    height,
  )
  ctx.putImageData(imageData, 0, 0)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new FormatError('BAD_PNG', 'toBlob failed')),
      'image/png',
    )
  })
}
