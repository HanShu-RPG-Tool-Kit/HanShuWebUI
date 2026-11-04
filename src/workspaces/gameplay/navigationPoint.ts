import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'

/**
 * 动态导航器（`.nav`）。只记录要追踪的地标，坐标在地图模板的地标里。
 *
 *   { id, level, track: { type: "landmark", ref: "<模板>$<地标>" } }
 *
 * 新建时 level / ref 可以先空着。出现坐标、`param` 或旧版字段则整份拒绝。
 */
export type NavigationTrack = {
  type: 'landmark'
  ref: string
}

export type NavigationPoint = {
  /** 建议与文件名（去掉 .nav）一致；空串表示尚未命名 */
  id: string
  /** 所属地图模板 ID；空串表示尚未选择 */
  level: string
  track: NavigationTrack
}

export type NavTypeId = 'rpgtoolkit:pos'

export const NAV_TYPE_POS: NavTypeId = 'rpgtoolkit:pos'
export const NAV_TRACK_LANDMARK = 'landmark'

export const NAV_DISPLAY_NAME = 'rpgtoolkit:display_name'
export const NAV_DISPLAY_ICON = 'rpgtoolkit:display_icon'
export const NAV_DISPLAY_MAX_DISTANCE = 'rpgtoolkit:display_max_distance'
export const NAV_DISPLAY_MIN_DISTANCE = 'rpgtoolkit:display_min_distance'

export const NAV_LABEL_MAX = 160
export const NAV_COORD_ABS_MAX = 30_000_000

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const LEVEL_ID_RE = /^[^$\\/:*?"<>|\u0000-\u001f]+$/

/** 旧版 `.nav` 字段：出现任意一个就明确拒绝。 */
const LEGACY_KEYS = ['dimension', 'label', 'radius', 'public', 'entity_tag', 'entity_uuid', 'scan_radius'] as const
/** 坐标权威字段。导航器只存 track.ref。 */
const COORD_KEYS = ['type', 'param', 'custom_data', 'x', 'y', 'z'] as const

export function createNavigationPoint(level = '', id = ''): NavigationPoint {
  return { id, level, track: { type: 'landmark', ref: '' } }
}

export function stringifyNavigationPoint(point: NavigationPoint): string {
  return `${JSON.stringify(toEngineObject(point), null, 2)}\n`
}

export function toEngineObject(point: NavigationPoint): Record<string, unknown> {
  return {
    id: point.id.trim(),
    level: point.level.trim(),
    track: { type: NAV_TRACK_LANDMARK, ref: point.track.ref.trim() },
  }
}

export function parseNavigationPoint(source: string): NavigationPoint {
  const raw = parseJsonValue(source)
  if (!isObject(raw)) throw new Error('导航器必须是 JSON 对象')
  return fromEngineObject(raw)
}

export function fromEngineObject(raw: Record<string, unknown>): NavigationPoint {
  const legacy = LEGACY_KEYS.filter((key) => key in raw)
  if (legacy.length) {
    throw new Error(`旧版 .nav 已不再支持（发现 ${legacy.join(' / ')}）。导航器只有 id / level / track，请重新创建或运行迁移。`)
  }
  const coords = COORD_KEYS.filter((key) => key in raw)
  if (coords.length) {
    throw new Error(`导航器不能保存坐标（发现 ${coords.join(' / ')}）。改用 track.ref 指向地标。`)
  }
  for (const key of Object.keys(raw)) {
    if (!['id', 'level', 'track'].includes(key)) throw new Error(`未知导航器字段：${key}`)
  }
  const id = raw.id === undefined ? '' : raw.id
  if (typeof id !== 'string') throw new Error('导航器 id 应为字符串')
  if (id.trim() && !partOk(id.trim())) throw new Error(`id 不是合法的导航器 ID：${id}`)
  if (typeof raw.level !== 'string') throw new Error('导航器需要字符串字段 level')
  const level = raw.level.trim()
  if (level && !partOk(level)) throw new Error(`level 不是合法的模板 ID：${raw.level}`)
  if (!isObject(raw.track)) throw new Error('导航器需要 track 对象')
  for (const key of Object.keys(raw.track)) {
    if (!['type', 'ref'].includes(key)) throw new Error(`未知 track 字段：${key}`)
  }
  if (raw.track.type !== NAV_TRACK_LANDMARK) {
    throw new Error(`track.type 只能是 ${NAV_TRACK_LANDMARK}`)
  }
  if (typeof raw.track.ref !== 'string') throw new Error('track.ref 应为字符串')
  return { id: id.trim(), level, track: { type: 'landmark', ref: raw.track.ref.trim() } }
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
  if (point.id.trim() && !partOk(point.id.trim())) issues.push('id 不是合法的导航器 ID')
  if (!point.level.trim()) issues.push('请选择所属地图模板（level）')
  else if (!partOk(point.level.trim())) issues.push('level 不是合法的模板 ID')
  if (point.track.type !== NAV_TRACK_LANDMARK) issues.push(`track.type 只能是 ${NAV_TRACK_LANDMARK}`)
  const ref = point.track.ref.trim()
  if (!ref) issues.push('请选择要追踪的地标（track.ref）')
  else {
    const dollar = ref.indexOf('$')
    const prefix = dollar > 0 ? ref.slice(0, dollar) : ''
    const local = dollar > 0 ? ref.slice(dollar + 1) : ''
    if (dollar <= 0 || dollar !== ref.lastIndexOf('$') || !partOk(prefix) || !partOk(local)) {
      issues.push('track.ref 必须是 <模板>$<地标>')
    } else if (point.level.trim() && point.level.indexOf(':') < 0 && prefix !== point.level.trim()) {
      issues.push(`track.ref 的模板前缀必须是 ${point.level.trim()}`)
    }
  }
  return issues
}

export function summarizeNavigationPoint(point: NavigationPoint): string[] {
  const lines = [
    point.level.trim() || '（未选择模板）',
    point.track.ref.trim() || '（未选择地标）',
  ]
  const issues = validateNavigationPoint(point)
  if (issues.length) lines.push(`问题：${issues.join('；')}`)
  return lines
}

/** UUID 校验留给以后的实体引用；当前地标 ref 不消费。 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}

function partOk(part: string): boolean {
  return part.length > 0 && part.length <= 64 && part !== '.' && part !== '..' && LEVEL_ID_RE.test(part)
}
