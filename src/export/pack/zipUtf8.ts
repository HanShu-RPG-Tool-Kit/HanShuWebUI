/**
 * ZIP 路径 UTF-8 强制：字节始终按 UTF-8 写；并给每条 local / central
 * 记录打上 Language encoding flag（general purpose bit 11 = 0x0800），
 * 避免 ASCII 路径缺标志时被按 CP437 解读。
 *
 * JSZip 默认只在「UTF-8 字节长 ≠ 字符串长」时置位；本函数补全其余条目。
 */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const EFS = 0x0800

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8)
}

function u32(b: Uint8Array, o: number): number {
  return (
    (b[o]! |
      (b[o + 1]! << 8) |
      (b[o + 2]! << 16) |
      (b[o + 3]! << 24)) >>>
    0
  )
}

function setU16(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff
  b[o + 1] = (v >>> 8) & 0xff
}

function orFlag(b: Uint8Array, flagOffset: number) {
  setU16(b, flagOffset, u16(b, flagOffset) | EFS)
}

/** 从末尾找 EOCD（允许短 comment） */
function findEocd(b: Uint8Array): number {
  const min = Math.max(0, b.length - (22 + 0xffff))
  for (let i = b.length - 22; i >= min; i--) {
    if (u32(b, i) === SIG_EOCD) return i
  }
  throw new Error('ZIP: 找不到 EOCD，无法强制 UTF-8 路径标志')
}

/**
 * 就地（拷贝后）为所有条目设置 EFS。输入须为完整 ZIP（未整包加密）。
 */
export function forceZipUtf8PathFlags(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)

  const eocd = findEocd(out)
  const entries = u16(out, eocd + 10)
  let off = u32(out, eocd + 16)

  for (let i = 0; i < entries; i++) {
    if (off + 46 > out.length || u32(out, off) !== SIG_CENTRAL) {
      throw new Error(`ZIP: central directory 损坏（条目 ${i}）`)
    }
    orFlag(out, off + 8)

    const localOff = u32(out, off + 42)
    if (localOff + 30 > out.length || u32(out, localOff) !== SIG_LOCAL) {
      throw new Error(`ZIP: local header 损坏（条目 ${i}）`)
    }
    orFlag(out, localOff + 6)

    const nameLen = u16(out, off + 28)
    const extraLen = u16(out, off + 30)
    const commentLen = u16(out, off + 32)
    off += 46 + nameLen + extraLen + commentLen
  }

  return out
}
