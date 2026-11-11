/**
 * Base64 与 PNG 结构解析。
 *
 * 纯 JS 实现，浏览器与 node 行为一致：不接受别家解码器的容错，
 * 校验规则就是协议规则（标准字母表、带填充、无空白、无 data: 前缀）。
 */

import { Deflate, Inflate, type ZStream } from 'pako'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(256).fill(-1)
for (let index = 0; index < ALPHABET.length; index += 1) {
  LOOKUP[ALPHABET.charCodeAt(index)] = index
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** 标准 Base64 解码；任何非法字符、错误填充、错误长度都返回 null */
export function decodeBase64(text: string): Uint8Array | null {
  if (typeof text !== 'string' || !text) return null
  if (text.length % 4 !== 0) return null
  let padding = 0
  if (text.endsWith('==')) padding = 2
  else if (text.endsWith('=')) padding = 1
  const body = padding ? text.slice(0, text.length - padding) : text
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index)
    if (code >= LOOKUP.length || LOOKUP[code] < 0) return null
  }
  const bytes = new Uint8Array((text.length / 4) * 3 - padding)
  let out = 0
  for (let index = 0; index < body.length; index += 4) {
    const chunk = body.slice(index, index + 4)
    let bits = 0
    for (let offset = 0; offset < 4; offset += 1) {
      const code = offset < chunk.length ? LOOKUP[chunk.charCodeAt(offset)] : 0
      bits = (bits << 6) | code
    }
    bytes[out] = (bits >>> 16) & 0xff
    if (out + 1 < bytes.length) bytes[out + 1] = (bits >>> 8) & 0xff
    if (out + 2 < bytes.length) bytes[out + 2] = bits & 0xff
    out += 3
  }
  return bytes
}

/** 标准 Base64 编码，带填充、无换行 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0
    const bits = (a << 16) | (b << 8) | c
    out += ALPHABET[(bits >>> 18) & 63]
    out += ALPHABET[(bits >>> 12) & 63]
    out += index + 1 < bytes.length ? ALPHABET[(bits >>> 6) & 63] : '='
    out += index + 2 < bytes.length ? ALPHABET[bits & 63] : '='
  }
  return out
}

/** 去掉 data: 前缀与空白后重新编码；只有能往返的才算合法 */
export function normalizeBase64(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  const comma = text.indexOf(',')
  if (text.startsWith('data:') && comma > 0) text = text.slice(comma + 1)
  text = text.replace(/\s+/g, '')
  if (!text) return null
  const bytes = decodeBase64(text)
  if (!bytes) return null
  const canonical = encodeBase64(bytes)
  return canonical === text ? canonical : null
}

export function base64ToBytes(raw: string): Uint8Array | null {
  const normalized = normalizeBase64(raw)
  return normalized ? decodeBase64(normalized) : null
}

export type PngInfo = {
  width: number
  height: number
  /** 是否含 acTL 块（APNG）；首版拒绝 */
  apng: boolean
  chunks: string[]
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let index = 0; index < 8; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false
  }
  return true
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

type PngStructure = PngInfo & {
  depth: number
  color: number
  interlace: number
  paletteEntries: number
  imageData: Uint8Array[]
}

function pngStructure(bytes: Uint8Array): PngStructure | null {
  if (!isPng(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let color = 0
  let interlace = 0
  let paletteEntries = 0
  let sawTransparency = false
  let imageDataEnded = false
  let apng = false
  const chunks: string[] = []
  const imageData: Uint8Array[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    )
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (length > 0x7fffffff || dataEnd + 4 > bytes.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return null
    if (crc32(bytes, offset + 4, dataEnd) !== view.getUint32(dataEnd)) return null
    if (chunks.length === 0 && type !== 'IHDR') return null
    if (type === 'IHDR') {
      if (chunks.length !== 0 || length !== 13) return null
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      depth = bytes[dataStart + 8]
      color = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [2, 4, 6].includes(color) ? [8, 16] : []
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths.includes(depth) ||
        bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || interlace > 1) return null
    } else if (type === 'PLTE') {
      if (paletteEntries || sawTransparency || imageData.length || color === 0 || color === 4 || length === 0 || length % 3 || length > 768) return null
      paletteEntries = length / 3
      if (color === 3 && paletteEntries > 2 ** depth) return null
    } else if (type === 'tRNS') {
      if (sawTransparency || imageData.length) return null
      if ((color === 0 && length !== 2) || (color === 2 && length !== 6) ||
        (color === 3 && (!paletteEntries || length === 0 || length > paletteEntries)) || color === 4 || color === 6) return null
      sawTransparency = true
    } else if (type === 'IDAT') {
      if (imageDataEnded || (color === 3 && !paletteEntries)) return null
      imageData.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      if (length !== 0 || dataEnd + 4 !== bytes.length || !imageData.some((part) => part.length > 0)) return null
      chunks.push(type)
      return { width, height, apng, chunks, depth, color, interlace, paletteEntries, imageData }
    } else if (type.charCodeAt(0) < 97) {
      // 未知关键块会改变像素解释，不能交给不同平台的容错解码器处理。
      return null
    }
    if (imageData.length && type !== 'IDAT') imageDataEnded = true
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') apng = true
    chunks.push(type)
    offset = dataEnd + 4
  }
  return null
}

/** 校验 PNG 块顺序、IHDR、调色板及每个块的 CRC；不分配像素位图。 */
export function pngInfo(bytes: Uint8Array): PngInfo | null {
  const info = pngStructure(bytes)
  return info ? { width: info.width, height: info.height, apng: info.apng, chunks: info.chunks } : null
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]

function paeth(left: number, up: number, upperLeft: number): number {
  const value = left + up - upperLeft
  const a = Math.abs(value - left)
  const b = Math.abs(value - up)
  const c = Math.abs(value - upperLeft)
  return a <= b && a <= c ? left : b <= c ? up : upperLeft
}

/**
 * 按行验证有界的 zlib 像素流，兼容所有静态 PNG 色型、位深和 Adam7。
 * 解压输出只保留 64KiB 块；索引图额外保留两行，用来检查调色板索引。
 */
export function validatePngPixels(bytes: Uint8Array): boolean {
  const info = pngStructure(bytes)
  if (!info || info.apng || info.width > 4096 || info.height > 4096) return false
  const channels = info.color === 2 ? 3 : info.color === 4 ? 2 : info.color === 6 ? 4 : 1
  const passes = (info.interlace ? ADAM7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((info.width - x) / dx))
    const height = Math.max(0, Math.ceil((info.height - y) / dy))
    return { width, height, rowBytes: Math.ceil(width * channels * info.depth / 8) }
  }).filter((pass) => pass.width > 0 && pass.height > 0)
  const packed = new Uint8Array(info.imageData.reduce((sum, part) => sum + part.length, 0))
  let packedOffset = 0
  for (const part of info.imageData) { packed.set(part, packedOffset); packedOffset += part.length }

  let passIndex = 0
  let row = 0
  let rowOffset = 0
  let filter = -1
  let current = new Uint8Array(info.color === 3 ? info.width : 0)
  let previous = new Uint8Array(current.length)
  const inflater = new Inflate({ windowBits: 15, chunkSize: 64 * 1024 })
  let stream: ZStream | undefined
  inflater.onStart = (value) => { stream = value }
  inflater.onData = (chunk) => {
    let offset = 0
    while (offset < chunk.length) {
      const pass = passes[passIndex]
      if (!pass) throw new Error('PNG 像素流超过 IHDR 声明的大小')
      if (filter < 0) {
        filter = chunk[offset++]
        if (filter > 4) throw new Error('PNG 行过滤器无效')
      }
      const take = Math.min(pass.rowBytes - rowOffset, chunk.length - offset)
      if (info.color === 3) current.set(chunk.subarray(offset, offset + take), rowOffset)
      offset += take
      rowOffset += take
      if (rowOffset !== pass.rowBytes) continue
      if (info.color === 3) {
        for (let index = 0; index < pass.rowBytes; index += 1) {
          const left = index > 0 ? current[index - 1] : 0
          const up = previous[index]
          const upperLeft = index > 0 ? previous[index - 1] : 0
          const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0
          current[index] = (current[index] + predictor) & 255
        }
        for (let x = 0; x < pass.width; x += 1) {
          const bit = x * info.depth
          const index = (current[bit >>> 3] >>> (8 - info.depth - (bit & 7))) & ((1 << info.depth) - 1)
          if (index >= info.paletteEntries) throw new Error('PNG 调色板索引越界')
        }
        const swap = previous
        previous = current
        current = swap
      }
      rowOffset = 0
      filter = -1
      row += 1
      if (row === pass.height) {
        passIndex += 1
        row = 0
        previous.fill(0)
      }
    }
  }
  try {
    return inflater.push(packed, true) && inflater.ended && inflater.err === 0 &&
      stream?.avail_in === 0 && passIndex === passes.length && rowOffset === 0 && filter === -1
  } catch {
    return false
  }
}

/** 单张图集的解码内存：宽 × 高 × 4 */
export function decodedTextureBytes(width: number, height: number): number {
  return width * height * 4
}

export type PngRgba = {
  width: number
  height: number
  rgba: Uint8Array
}

function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** 编码 8-bit 非隔行 RGBA PNG（filter None） */
export function encodePngRgba(image: PngRgba): Uint8Array {
  const { width, height, rgba } = image
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error('PNG 尺寸无效')
  }
  if (rgba.length !== width * height * 4) throw new Error('RGBA 长度与尺寸不符')
  const rowBytes = width * 4
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const dest = y * (rowBytes + 1)
    raw[dest] = 0
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), dest + 1)
  }
  const deflator = new Deflate({ level: 6 })
  deflator.push(raw, true)
  if (deflator.err || !deflator.result) throw new Error('PNG 压缩失败')
  const compressed = deflator.result instanceof Uint8Array
    ? deflator.result
    : new Uint8Array(deflator.result)

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Uint8Array.from(PNG_SIGNATURE)
  const parts = [signature, writeChunk('IHDR', ihdr), writeChunk('IDAT', compressed), writeChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * 解码 8-bit 非隔行真彩 PNG 为 RGBA。
 * 仅支持色型 2（RGB）与 6（RGBA）；其它格式返回 null，交给宿主解码器。
 */
export function decodePngRgba(bytes: Uint8Array): PngRgba | null {
  const info = pngStructure(bytes)
  if (!info || info.apng || info.interlace || info.depth !== 8 || (info.color !== 2 && info.color !== 6)) {
    return null
  }
  const channels = info.color === 6 ? 4 : 3
  const rowBytes = info.width * channels
  const packed = new Uint8Array(info.imageData.reduce((sum, part) => sum + part.length, 0))
  let packedOffset = 0
  for (const part of info.imageData) {
    packed.set(part, packedOffset)
    packedOffset += part.length
  }
  const inflater = new Inflate({ windowBits: 15 })
  inflater.push(packed, true)
  if (inflater.err || !inflater.result) return null
  const raw = inflater.result instanceof Uint8Array ? inflater.result : new Uint8Array(inflater.result)
  if (raw.length !== (rowBytes + 1) * info.height) return null

  const rgba = new Uint8Array(info.width * info.height * 4)
  const previous = new Uint8Array(rowBytes)
  const current = new Uint8Array(rowBytes)
  for (let y = 0; y < info.height; y += 1) {
    const rowStart = y * (rowBytes + 1)
    const filter = raw[rowStart]
    if (filter > 4) return null
    current.set(raw.subarray(rowStart + 1, rowStart + 1 + rowBytes))
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? current[index - channels] : 0
      const up = previous[index]
      const upperLeft = index >= channels ? previous[index - channels] : 0
      const predictor = filter === 1 ? left
        : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2)
            : filter === 4 ? paeth(left, up, upperLeft)
              : 0
      current[index] = (current[index] + predictor) & 255
    }
    for (let x = 0; x < info.width; x += 1) {
      const src = x * channels
      const dest = (y * info.width + x) * 4
      rgba[dest] = current[src]
      rgba[dest + 1] = current[src + 1]
      rgba[dest + 2] = current[src + 2]
      rgba[dest + 3] = channels === 4 ? current[src + 3] : 255
    }
    previous.set(current)
  }
  return { width: info.width, height: info.height, rgba }
}
