/**
 * Hanshu skin object codec (TS port of skin-core codec.rs)
 *
 * Canonical C: HSKN | ver | flags | uv | w | h | rgbaLen | rgba  (no model)
 * Disk .skin: header + enc + payloadLen + zlib(rgba)
 * Share: hanshu-skin:1:<classic|slim>:<base64url(zlib(C))>
 */

import { deflate, inflate } from 'pako'
import type { SkinModel } from '../contracts/types'

export const MAGIC = 0x48534b4e // HSKN
export const FORMAT_VERSION = 1
export const UV_LAYOUT_STANDARD = 0
export const FLAG_SEMI_TRANSPARENT = 1
export const ENC_RAW = 0
export const ENC_ZLIB = 1
export const HEADER_LENGTH = 15
export const DISK_HEADER_LENGTH = 16

export const SKIN_WIDTH = 64
export const SKIN_HEIGHT = 64
export const MAX_TEXTURE_SIZE = 1024
/** Convenience: 64×64 RGBA length. */
export const RGBA_LENGTH = SKIN_WIDTH * SKIN_HEIGHT * 4

export const SHARE_PREFIX = 'hanshu-skin:'
export const SHARE_WIRE_VERSION = '1'

export const limits = {
  SKIN_CODE_CHARS: 6 * 1024 * 1024,
  COMPRESSED_BYTES: 5 * 1024 * 1024,
  PNG_BYTES: 2 * 1024 * 1024,
  MAX_RGBA_BYTES: 1024 * 1024 * 4,
  MAX_DISK_BYTES: 5 * 1024 * 1024,
} as const

export class FormatError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FormatError'
    this.code = code
  }
}

export type DecodedSkin = {
  rgba: Uint8Array
  width: number
  height: number
  flags: number
}

export function semiTransparent(flags: number): boolean {
  return (flags & FLAG_SEMI_TRANSPARENT) !== 0
}

/** 入库对象须为正方形；允许任意整数边长（64…MAX），不再要求 64 倍数。 */
export function isSupportedTextureSize(width: number, height: number): boolean {
  return (
    width === height &&
    Number.isInteger(width) &&
    width >= 64 &&
    width <= MAX_TEXTURE_SIZE
  )
}

export function rgbaByteLen(width: number, height: number): number {
  return width * height * 4
}

function writeU16BE(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, false)
}

function writeU32BE(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, false)
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

export function buildC(
  flags: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  if (!isSupportedTextureSize(width, height)) {
    throw new FormatError(
      'BAD_DIMENSIONS',
      `dimensions ${width}x${height} not supported`,
    )
  }
  const expected = rgbaByteLen(width, height)
  if (rgba.length !== expected) {
    throw new FormatError(
      'BAD_RGBA_LENGTH',
      `rgba must be ${expected} bytes, got ${rgba.length}`,
    )
  }
  if (expected > limits.MAX_RGBA_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `rgba ${expected} exceeds ${limits.MAX_RGBA_BYTES}`,
    )
  }
  assertNormalizationInvariants(rgba)
  const c = new Uint8Array(HEADER_LENGTH + expected)
  const view = new DataView(c.buffer)
  writeU32BE(view, 0, MAGIC)
  c[4] = FORMAT_VERSION
  c[5] = flags & 0xff
  c[6] = UV_LAYOUT_STANDARD
  writeU16BE(view, 7, width)
  writeU16BE(view, 9, height)
  writeU32BE(view, 11, expected)
  c.set(rgba, HEADER_LENGTH)
  return c
}

export function parseC(c: Uint8Array): DecodedSkin {
  if (c.length < HEADER_LENGTH) {
    throw new FormatError('BAD_LENGTH', `C too short: ${c.length} bytes`)
  }
  const view = new DataView(c.buffer, c.byteOffset, c.byteLength)
  if (view.getUint32(0, false) !== MAGIC) {
    throw new FormatError('BAD_MAGIC', 'missing HSKN magic')
  }
  if (c[4] !== FORMAT_VERSION) {
    throw new FormatError(
      'UNSUPPORTED_VERSION',
      `format version ${c[4]} not supported`,
    )
  }
  const flags = c[5]!
  if (c[6] !== UV_LAYOUT_STANDARD) {
    throw new FormatError(
      'UNSUPPORTED_UV_LAYOUT',
      `uv layout ${c[6]} not supported`,
    )
  }
  const width = view.getUint16(7, false)
  const height = view.getUint16(9, false)
  if (!isSupportedTextureSize(width, height)) {
    throw new FormatError(
      'BAD_DIMENSIONS',
      `dimensions ${width}x${height} not supported`,
    )
  }
  const rgbaLen = view.getUint32(11, false)
  const expected = rgbaByteLen(width, height)
  if (rgbaLen !== expected) {
    throw new FormatError(
      'BAD_RGBA_LENGTH',
      `rgbaLength ${rgbaLen} != expected ${expected}`,
    )
  }
  if (c.length !== HEADER_LENGTH + rgbaLen) {
    throw new FormatError(
      'BAD_LENGTH',
      `C is ${c.length} bytes, need ${HEADER_LENGTH + rgbaLen}`,
    )
  }
  const rgba = c.slice(HEADER_LENGTH)
  assertNormalizationInvariants(rgba)
  return { rgba, width, height, flags }
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

export async function skinIdOf(c: Uint8Array): Promise<string> {
  const copy = new Uint8Array(c.byteLength)
  copy.set(c)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function encodeDiskFile(decoded: DecodedSkin): Uint8Array {
  const c = buildC(decoded.flags, decoded.width, decoded.height, decoded.rgba)
  const rgba = c.subarray(HEADER_LENGTH)
  // level 6：导入大批量时比 9 快很多，体积仍可接受
  const payload = deflate(rgba, { level: 6 })
  if (payload.length > limits.COMPRESSED_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `compressed payload ${payload.length} exceeds ${limits.COMPRESSED_BYTES}`,
    )
  }
  const out = new Uint8Array(DISK_HEADER_LENGTH + payload.length)
  const view = new DataView(out.buffer)
  writeU32BE(view, 0, MAGIC)
  out[4] = FORMAT_VERSION
  out[5] = decoded.flags & 0xff
  out[6] = UV_LAYOUT_STANDARD
  writeU16BE(view, 7, decoded.width)
  writeU16BE(view, 9, decoded.height)
  out[11] = ENC_ZLIB
  writeU32BE(view, 12, payload.length)
  out.set(payload, DISK_HEADER_LENGTH)
  return out
}

export async function decodeDiskFile(
  buf: Uint8Array,
): Promise<{ decoded: DecodedSkin; skinId: string }> {
  if (buf.length > limits.MAX_DISK_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `disk file ${buf.length} exceeds ${limits.MAX_DISK_BYTES}`,
    )
  }
  if (buf.length < DISK_HEADER_LENGTH) {
    throw new FormatError('BAD_LENGTH', 'disk file too short')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, false) !== MAGIC) {
    throw new FormatError('BAD_MAGIC', 'missing HSKN magic')
  }
  if (buf[4] !== FORMAT_VERSION) {
    throw new FormatError(
      'UNSUPPORTED_VERSION',
      `format version ${buf[4]} not supported`,
    )
  }
  const flags = buf[5]!
  if (buf[6] !== UV_LAYOUT_STANDARD) {
    throw new FormatError(
      'UNSUPPORTED_UV_LAYOUT',
      `uv layout ${buf[6]} not supported`,
    )
  }
  const width = view.getUint16(7, false)
  const height = view.getUint16(9, false)
  if (!isSupportedTextureSize(width, height)) {
    throw new FormatError(
      'BAD_DIMENSIONS',
      `dimensions ${width}x${height} not supported`,
    )
  }
  const enc = buf[11]!
  const payloadLen = view.getUint32(12, false)
  if (buf.length !== DISK_HEADER_LENGTH + payloadLen) {
    throw new FormatError(
      'BAD_LENGTH',
      `disk file is ${buf.length} bytes, need ${DISK_HEADER_LENGTH + payloadLen}`,
    )
  }
  const payload = buf.subarray(DISK_HEADER_LENGTH)
  const expected = rgbaByteLen(width, height)
  let rgba: Uint8Array
  if (enc === ENC_RAW) {
    if (payload.length !== expected) {
      throw new FormatError(
        'BAD_RGBA_LENGTH',
        `raw payload ${payload.length} != ${expected}`,
      )
    }
    rgba = payload.slice()
  } else if (enc === ENC_ZLIB) {
    if (payload.length > limits.COMPRESSED_BYTES) {
      throw new FormatError(
        'PAYLOAD_TOO_LARGE',
        `compressed payload ${payload.length} exceeds ${limits.COMPRESSED_BYTES}`,
      )
    }
    try {
      rgba = inflate(payload)
    } catch (e) {
      throw new FormatError(
        'INFLATE_FAILED',
        `zlib inflate failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (rgba.length !== expected) {
      throw new FormatError(
        'BAD_LENGTH',
        `decompressed is ${rgba.length} bytes, need ${expected}`,
      )
    }
  } else {
    throw new FormatError(
      'UNSUPPORTED_ENCODING',
      `payload encoding ${enc} not supported`,
    )
  }
  const c = buildC(flags, width, height, rgba)
  const decoded = parseC(c)
  const skinId = await skinIdOf(c)
  return { decoded, skinId }
}

export async function encodeShareCode(
  model: SkinModel,
  decoded: DecodedSkin,
): Promise<{ skinCode: string; skinId: string }> {
  const c = buildC(decoded.flags, decoded.width, decoded.height, decoded.rgba)
  const compressed = deflate(c, { level: 9 })
  if (compressed.length > limits.COMPRESSED_BYTES) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `compressed payload ${compressed.length} exceeds ${limits.COMPRESSED_BYTES}`,
    )
  }
  const skinId = await skinIdOf(c)
  return {
    skinCode: `${SHARE_PREFIX}${SHARE_WIRE_VERSION}:${model}:${bytesToBase64Url(compressed)}`,
    skinId,
  }
}

export async function decodeShareCode(code: string): Promise<{
  decoded: DecodedSkin
  model: SkinModel
  skinId: string
  skinCode: string
}> {
  const trimmed = code.trim()
  if (trimmed.length > limits.SKIN_CODE_CHARS) {
    throw new FormatError(
      'PAYLOAD_TOO_LARGE',
      `skin code exceeds ${limits.SKIN_CODE_CHARS}`,
    )
  }
  if (!trimmed.startsWith(SHARE_PREFIX)) {
    throw new FormatError(
      'BAD_PREFIX',
      `expected prefix "${SHARE_PREFIX}"`,
    )
  }
  const rest = trimmed.slice(SHARE_PREFIX.length)
  const parts = rest.split(':')
  if (parts.length < 3) {
    throw new FormatError('BAD_PREFIX', 'expected hanshu-skin:1:<model>:<payload>')
  }
  const [ver, modelS, ...b64Parts] = parts
  const b64 = b64Parts.join(':')
  if (ver !== SHARE_WIRE_VERSION) {
    throw new FormatError(
      'UNSUPPORTED_VERSION',
      `share wire version ${ver} not supported`,
    )
  }
  if (modelS !== 'classic' && modelS !== 'slim') {
    throw new FormatError('UNSUPPORTED_MODEL', `model "${modelS}" unknown`)
  }
  const compressed = base64UrlToBytes(b64)
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
  const decoded = parseC(inflated)
  const skinId = await skinIdOf(inflated)
  return {
    decoded,
    model: modelS,
    skinId,
    skinCode: trimmed,
  }
}

/** @deprecated alias — prefer encodeShareCode */
export async function encodeSkinCode(
  model: SkinModel,
  rgba: Uint8Array,
  opts?: { width?: number; height?: number; flags?: number },
): Promise<{ skinCode: string; skinId: string }> {
  return encodeShareCode(model, {
    rgba,
    width: opts?.width ?? SKIN_WIDTH,
    height: opts?.height ?? SKIN_HEIGHT,
    flags: opts?.flags ?? 0,
  })
}

/** @deprecated alias — prefer decodeShareCode */
export async function decodeSkinCode(code: string) {
  return decodeShareCode(code)
}

export function isValidSkinId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id)
}
