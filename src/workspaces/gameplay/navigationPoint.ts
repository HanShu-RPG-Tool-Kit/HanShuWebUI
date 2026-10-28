import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'

/**
 * WebUI 的导航点草稿（v3 / RPGToolKit Level 模型）。
 *
 * 形状与引擎 `NavigationPoint` 一致，只是 `level` 允许暂时为空（新建时还没选模板）：
 *   { level, type, param, custom_data }
 *
 * - 不再有 `dimension`：维度由「哪个维度绑了哪个模板」决定，导航点只声明 level。
 * - 不再有 `public` / `radius` / 到达判定：到没到由给导航的 RPG 流程自己判断。
 * - `display_*` 是内置 custom_data 键，只是显示提示，不是授权。
 */
export type NavTypeId = 'rpgtoolkit:pos'

export type NavigationPoint = {
  /** 所属地图模板的 ID（= `.level` 文件名去掉后缀）；空串表示尚未选择 */
  level: string
  type: NavTypeId
  param: { x: number; y: number; z: number }
  custom_data: Record<string, unknown>
}

export const NAV_TYPE_POS: NavTypeId = 'rpgtoolkit:pos'
export const NAV_TYPE_LABELS: Record<NavTypeId, string> = {
  'rpgtoolkit:pos': '固定坐标',
}

export const NAV_DISPLAY_NAME = 'rpgtoolkit:display_name'
export const NAV_DISPLAY_ICON = 'rpgtoolkit:display_icon'
export const NAV_DISPLAY_MAX_DISTANCE = 'rpgtoolkit:display_max_distance'
export const NAV_DISPLAY_MIN_DISTANCE = 'rpgtoolkit:display_min_distance'

export const NAV_LABEL_MAX = 160
export const NAV_COORD_ABS_MAX = 30_000_000

const TYPE_IDS = new Set<string>([NAV_TYPE_POS])
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const IDENTIFIER_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i
const LEVEL_ID_RE = /^[^$\\/:*?"<>|\u0000-\u001f]+$/

/** 旧版 `.nav` 字段：出现任意一个就明确拒绝，避免静默丢字段。 */
const LEGACY_KEYS = ['dimension', 'label', 'radius', 'public', 'entity_tag', 'entity_uuid', 'scan_radius', 'x', 'y', 'z'] as const

export function createNavigationPoint(level = ''): NavigationPoint {
  return {
    level,
    type: NAV_TYPE_POS,
    param: { x: 0, y: 64, z: 0 },
    custom_data: { [NAV_DISPLAY_NAME]: 'display_name' },
  }
}

export function stringifyNavigationPoint(point: NavigationPoint): string {
  return `${JSON.stringify(toEngineObject(point), null, 2)}\n`
}

/** 写出与引擎一致的 JSON（无 WebUI 私有字段）。 */
export function toEngineObject(point: NavigationPoint): Record<string, unknown> {
  const custom: Record<string, unknown> = {}
  const name = typeof point.custom_data[NAV_DISPLAY_NAME] === 'string' ? String(point.custom_data[NAV_DISPLAY_NAME]) : ''
  if (name.trim()) custom[NAV_DISPLAY_NAME] = name.trim().slice(0, NAV_LABEL_MAX)
  const icon = typeof point.custom_data[NAV_DISPLAY_ICON] === 'string' ? String(point.custom_data[NAV_DISPLAY_ICON]).trim() : ''
  if (icon) custom[NAV_DISPLAY_ICON] = icon
  for (const key of [NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_MAX_DISTANCE] as const) {
    const value = point.custom_data[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) custom[key] = value
  }
  for (const [key, value] of Object.entries(point.custom_data)) {
    if (key in custom || key === NAV_DISPLAY_NAME || key === NAV_DISPLAY_ICON || key === NAV_DISPLAY_MIN_DISTANCE || key === NAV_DISPLAY_MAX_DISTANCE) continue
    custom[key] = value
  }
  return {
    level: point.level.trim(),
    type: point.type,
    param: { x: point.param.x, y: point.param.y, z: point.param.z },
    custom_data: custom,
  }
}

export function parseNavigationPoint(source: string): NavigationPoint {
  const raw = parseJsonValue(source)
  if (!isObject(raw)) throw new Error('导航点必须是 JSON 对象')
  return fromEngineObject(raw)
}

export function fromEngineObject(raw: Record<string, unknown>): NavigationPoint {
  const legacy = LEGACY_KEYS.filter((key) => key in raw)
  if (legacy.length) {
    throw new Error(`旧版 .nav 已不再支持（发现 ${legacy.join(' / ')}）。v3 导航点只有 level / type / param / custom_data，请重新创建。`)
  }

  for (const key of Object.keys(raw)) {
    if (!['level', 'type', 'param', 'custom_data'].includes(key)) throw new Error(`未知导航点字段：${key}`)
  }

  if (typeof raw.level !== 'string') throw new Error('导航点需要字符串字段 level')
  const level = raw.level.trim()
  if (level && (!LEVEL_ID_RE.test(level) || level === '.' || level === '..')) throw new Error(`level 不是合法的模板 ID：${raw.level}`)

  if (typeof raw.type !== 'string' || !TYPE_IDS.has(raw.type)) {
    throw new Error(`未知导航点类型：${String(raw.type)}（本轮只支持 ${NAV_TYPE_POS}）`)
  }
  const type = raw.type as NavTypeId

  if (!isObject(raw.param)) throw new Error('导航点需要 param 对象')
  if (type === NAV_TYPE_POS) {
    const param = raw.param
    for (const key of Object.keys(param)) if (!['x', 'y', 'z'].includes(key)) throw new Error(`未知 pos 参数：${key}`)
    const x = requireCoord(param.x, 'param.x')
    const y = requireCoord(param.y, 'param.y')
    const z = requireCoord(param.z, 'param.z')
    return { level, type, param: { x, y, z }, custom_data: readCustomData(raw.custom_data) }
  }

  throw new Error(`未知导航点类型：${type}`)
}

function readCustomData(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error('custom_data 必须是 JSON 对象')
  const data: Record<string, unknown> = { ...value }
  if (data[NAV_DISPLAY_NAME] !== undefined && typeof data[NAV_DISPLAY_NAME] !== 'string') {
    throw new Error(`${NAV_DISPLAY_NAME} 必须是字符串`)
  }
  if (data[NAV_DISPLAY_ICON] !== undefined && typeof data[NAV_DISPLAY_ICON] !== 'string') {
    throw new Error(`${NAV_DISPLAY_ICON} 必须是字符串`)
  }
  for (const key of [NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_MAX_DISTANCE]) {
    if (data[key] !== undefined && (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || (data[key] as number) < 0)) {
      throw new Error(`${key} 必须是 ≥ 0 的有限数字`)
    }
  }
  return data
}

export function readNavigationSource(source: string): { point: NavigationPoint; error: string } {
  try {
    return { point: parseNavigationPoint(source), error: '' }
  } catch (error) {
    return { point: createNavigationPoint(), error: error instanceof Error ? error.message : String(error) }
  }
}

export function validateNavigationPoint(point: NavigationPoint): string[] {
  const issues: string[] = []
  if (!point.level.trim()) issues.push('请选择所属地图模板（level）')
  else if (!LEVEL_ID_RE.test(point.level.trim()) || point.level.trim() === '.' || point.level.trim() === '..') issues.push('level 不是合法的模板 ID')
  if (!TYPE_IDS.has(point.type)) issues.push(`未知导航点类型：${point.type}`)
  if (point.type === NAV_TYPE_POS) {
    for (const [name, value] of [['x', point.param.x], ['y', point.param.y], ['z', point.param.z]] as const) {
      if (!Number.isFinite(value) || Math.abs(value) > NAV_COORD_ABS_MAX) issues.push(`${name} 须为有限数且绝对值 ≤ ${NAV_COORD_ABS_MAX}`)
    }
  }
  const displayName = point.custom_data[NAV_DISPLAY_NAME]
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > NAV_LABEL_MAX)) {
    issues.push(`display_name 必须是 ≤ ${NAV_LABEL_MAX} 的字符串`)
  }
  const icon = point.custom_data[NAV_DISPLAY_ICON]
  if (icon !== undefined && (typeof icon !== 'string' || (icon.trim() !== '' && !IDENTIFIER_RE.test(icon.trim())))) {
    issues.push('display_icon 须为 namespace:path')
  }
  const min = point.custom_data[NAV_DISPLAY_MIN_DISTANCE]
  const max = point.custom_data[NAV_DISPLAY_MAX_DISTANCE]
  for (const [name, value] of [['display_min_distance', min], ['display_max_distance', max]] as const) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      issues.push(`${name} 须为 ≥ 0 的有限数`)
    }
  }
  if (typeof min === 'number' && typeof max === 'number' && max > 0 && min > max) issues.push('display_min_distance 不能大于 display_max_distance')
  return issues
}

export function summarizeNavigationPoint(point: NavigationPoint): string[] {
  const lines = [
    point.level.trim() || '（未选择模板）',
    NAV_TYPE_LABELS[point.type] ?? point.type,
    `坐标：${point.param.x}, ${point.param.y}, ${point.param.z}`,
  ]
  const issues = validateNavigationPoint(point)
  if (issues.length) lines.push(`问题：${issues.join('；')}`)
  return lines
}

/** UUID 校验留给以后的 entity 类型；当前 pos 不消费。 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

function requireCoord(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > NAV_COORD_ABS_MAX) {
    throw new Error(`${name} 须为有限数且绝对值 ≤ ${NAV_COORD_ABS_MAX}`)
  }
  return value
}
