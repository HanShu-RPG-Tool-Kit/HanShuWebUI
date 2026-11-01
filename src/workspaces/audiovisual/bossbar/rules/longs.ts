import { BOSSBAR_LONG_MAX, BOSSBAR_LONG_MIN, parseLong } from '../protocol'

/** long 的边界与安全运算 */
export function clampLong(value: bigint): bigint {
  if (value < BOSSBAR_LONG_MIN) return BOSSBAR_LONG_MIN
  if (value > BOSSBAR_LONG_MAX) return BOSSBAR_LONG_MAX
  return value
}

/** 差值可能溢出 int64，用 BigInt 计算不会溢出（Java 侧用 BigInteger） */
export function longSpan(max: bigint, min: bigint): bigint {
  return max - min
}

export function parseLongOrNull(text: unknown): bigint | null {
  return parseLong(text)
}

/** 十进制文本 → BigInt，容忍超出 int64 的范围（编辑器输入框解析用） */
export function parseLongLoose(text: string): bigint | null {
  const trimmed = text.trim()
  if (!/^-?[0-9]+$/.test(trimmed)) return null
  try {
    return BigInt(trimmed)
  } catch {
    return null
  }
}
