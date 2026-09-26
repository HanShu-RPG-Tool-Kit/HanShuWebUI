/**
 * hskin1 codec — TS port of skin-core codec.rs
 * Wire: "hskin1:" + base64url-nopad(zlib(P))
 * P: HSK1 | normVer | uv | model | w | h | rgbaLen | rgba(16384)
 */

import { deflate, inflate } from 'pako'
import type { SkinModel } from '../contracts/types'

export const FORMAT_PREFIX = 'hskin1:'
export const MAGIC = 0x48534b31 // HSK1
export const NORMALIZATION_VERSION = 1
export const UV_LAYOUT_STANDARD = 0
export const MODEL_CLASSIC = 0
export const MODEL_SLIM = 1
export const SKIN_WIDTH = 64
export const SKIN_HEIGHT = 64
export const RGBA_LENGTH = SKIN_WIDTH * SKIN_HEIGHT * 4
export const HEADER_LENGTH = 15
export const P_LENGTH = HEADER_LENGTH + RGBA_LENGTH

export const limits = {
  SKIN_CODE_CHARS: 24 * 1024,
  COMPRESSED_BYTES: 18 * 1024,
  PNG_BYTES: 512 * 1024,
} as const

export class FormatError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FormatError'
    this.code = code
  }
}

export type DecodedSkin = { model: SkinModel; rgba: Uint8Array }

function modelToByte(model: SkinModel): number {
  return model === 'slim' ? MODEL_SLIM : MODEL_CLASSIC
}

function modelFromByte(b: number): SkinModel | null {
  if (b === MODEL_CLASSIC) return 'classic'
  if (b === MODEL_SLIM) return 'slim'
  return null
}

function writeU16BE(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, false)
}

function writeU32BE(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, false)
}

export function buildP(model: SkinModel, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== RGBA_LENGTH) {
    throw new FormatError(
      'BAD_RGBA_LENGTH',
      `rgba must be ${RGBA_LENGTH} bytes, got ${rgba.length}`,
    )
  }
  const p = new Uint8Array(P_LENGTH)
  const view = new DataView(p.buffer)
  writeU32BE(view, 0, MAGIC)
  p[4] = NORMALIZATION_VERSION
  p[5] = UV_LAYOUT_STANDARD
  p[6] = modelToByte(model)
  writeU16BE(view, 7, SKIN_WIDTH)
  writeU16BE(view, 9, SKIN_HEIGHT)
  writeU32BE(view, 11, RGBA_LENGTH)
  p.set(rgba, HEADER_LENGTH)
  return p
}

export function assertNormalizationInvariants(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      rgba[i + 3] === 0 &&
      (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0)
    ) {
      throw new FormatError(
        'NORMALIZATION_INVARIANT',
        `transparent pixel at byte ${i} carries non-zero RGB`,
      )
    }
  }
}

export function parseP(p: Uint8Array): DecodedSkin {
  if (p.length !== P_LENGTH) {
    throw new FormatError(
      'BAD_LENGTH',
      `P must be exactly ${P_LENGTH} bytes, got ${p.length}`,
    )
  }
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
  if (view.getUint32(0, false) !== MAGIC) {
    throw new FormatError('BAD_MAGIC', 'missing HSK1 magic')
  }
  if (p[4] !== NORMALIZATION_VERSION) {
    throw new FormatError(
      'UNSUPPORTED_VERSION',
      `normalization version ${p[4]} not supported`,
    )
  }
  if (p[5] !== UV_LAYOUT_STANDARD) {
    throw new FormatError(
      'UNSUPPORTED_UV_LAYOUT',
      `uv layout ${p[5]} not supported`,
    )
  }
  const model = modelFromByte(p[6]!)
  if (!model) {
    throw new FormatError('UNSUPPORTED_MODEL', `model byte ${p[6]} unknown`)
  }
  if (
    view.getUint16(7, false) !== SKIN_WIDTH ||
    view.getUint16(9, false) !== SKIN_HEIGHT
  ) {
    throw new FormatError('BAD_DIMENSIONS', 'dimensions must be 64x64')
  }
  if (view.getUint32(11, false) !== RGBA_LENGTH) {
    throw new FormatError('BAD_RGBA_LENGTH', 'rgbaLength must be 16384')
  }
  const rgba = p.slice(HEADER_LENGTH)
  assertNormalizationInvariants(rgba)
  return { model, rgba }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new FormatError('BAD_BASE64', 'invalid base64url characters')
  }
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch (e) {
    throw new FormatError(
      'BAD_BASE64',
      `invalid base64url: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export async function skinIdOf(p: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', p.buffer as ArrayBuffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export async function encodeSkinCode(
  model: SkinModel,
  rgba: Uint8Array,
): Promise<{ skinCode: string; skinId: string }> {
  const p = buildP(model, rgba)
  const compressed = deflate(p, { level: 9 })
  if (compressed.length > limits.COMPRESSED_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `compressed payload ${compressed.length} exceeds ${limits.COMPRESSED_BYTES}`,
    )
  }
  const skinId = await skinIdOf(p)
  return {
    skinCode: `${FORMAT_PREFIX}${bytesToBase64Url(compressed)}`,
    skinId,
  }
}

export async function decodeSkinCode(
  code: string,
): Promise<{ decoded: DecodedSkin; skinId: string; skinCode: string }> {
  if (code.length > limits.SKIN_CODE_CHARS) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `skin code exceeds ${limits.SKIN_CODE_CHARS}`,
    )
  }
  if (!code.startsWith(FORMAT_PREFIX)) {
    throw new FormatError(
      'BAD_PREFIX',
      `expected prefix "${FORMAT_PREFIX}"`,
    )
  }
  const payload = code.slice(FORMAT_PREFIX.length)
  const compressed = base64UrlToBytes(payload)
  if (compressed.length > limits.COMPRESSED_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `compressed payload ${compressed.length} exceeds ${limits.COMPRESSED_BYTES}`,
    )
  }
  let inflated: Uint8Array
  try {
    inflated = inflate(compressed)
  } catch (e) {
    throw new FormatError(
      'INFLATE_FAILED',
      `zlib inflate failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (inflated.length !== P_LENGTH) {
    throw new FormatError(
      'BAD_LENGTH',
      `decompressed P is ${inflated.length} bytes, need exactly ${P_LENGTH}`,
    )
  }
  const decoded = parseP(inflated)
  const skinId = await skinIdOf(inflated)
  return { decoded, skinId, skinCode: code.trim() }
}

export function isValidSkinId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id)
}
