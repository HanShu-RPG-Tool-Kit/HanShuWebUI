import { parseLong, type BossbarValue } from '../protocol'

/** 只把服务端原值转为文本；本地化、单位、百分号和小数位由服务端提供。 */
export function formatRunValue(value: BossbarValue | undefined): string | null {
  if (!value) return null
  if (value.type === 'long') return parseLong(value.value) !== null ? value.value : null
  if (value.type === 'double') return Number.isFinite(value.value) ? String(value.value) : null
  if (value.type === 'bool') return value.value ? 'true' : 'false'
  return value.value
}
