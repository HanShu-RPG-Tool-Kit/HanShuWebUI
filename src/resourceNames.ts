/** Shared base-name validation for source files and virtual folders. */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 10 }, (_, index) => `COM${index}`),
  ...Array.from({ length: 10 }, (_, index) => `LPT${index}`),
])

export const MAX_BASE_LENGTH = 120

export function resourceBaseError(base: string): string | null {
  const value = base.trim()
  if (!value) return '名字不能为空'
  if (/[\\/:*?"<>|]/.test(value)) return '不能含 \\ / : * ? " < > |'
  if ([...value].some((ch) => ch.charCodeAt(0) < 32)) return '不能含控制字符'
  if (value === '.' || value === '..') return '这个名字不能用'
  if (value.endsWith('.')) return '结尾不能是点'
  const device = value.split('.')[0]
  if (WINDOWS_RESERVED_NAMES.has(device.toUpperCase())) {
    return `「${device}」是 Windows 保留设备名，换一个`
  }
  if (value.length > MAX_BASE_LENGTH) {
    return `名字太长（最多 ${MAX_BASE_LENGTH} 个字符，当前 ${value.length}）`
  }
  return null
}

