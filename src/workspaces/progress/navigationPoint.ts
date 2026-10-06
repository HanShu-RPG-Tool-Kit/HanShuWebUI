import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'

export type NavigationPointType = 'position' | 'entity'
export type NavigationEntityMode = 'tag' | 'uuid'

/** WebUI 草稿用的导航点；形状对齐引擎 NavigationPoint，不写 datapack 路径 / 资源 id。 */
export type NavigationPoint = {
  type: NavigationPointType
  label: string
  radius: number
  public: boolean
  dimension: string
  x: number
  y: number
  z: number
  entityMode: NavigationEntityMode
  entityTag: string
  entityUuid: string
  /** 仅 entity + tag：在周围扫描匹配实体的半径（格） */
  scanRadius: number
}

export const NAV_RADIUS_DEFAULT = 6
export const NAV_RADIUS_MIN = 1
export const NAV_RADIUS_MAX = 32
export const NAV_SCAN_RADIUS_DEFAULT = 64
export const NAV_SCAN_RADIUS_MIN = 1
export const NAV_SCAN_RADIUS_MAX = 256
export const NAV_COORD_ABS_MAX = 30_000_000
export const NAV_LABEL_MAX = 160
export const NAV_TAG_MAX = 128

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const DIM_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i

export function createNavigationPoint(label = '新导航点'): NavigationPoint {
  return {
    type: 'position',
    label,
    radius: NAV_RADIUS_DEFAULT,
    public: false,
    dimension: 'minecraft:overworld',
    x: 0,
    y: 64,
    z: 0,
    entityMode: 'tag',
    entityTag: '',
    entityUuid: '',
    scanRadius: NAV_SCAN_RADIUS_DEFAULT,
  }
}

export function stringifyNavigationPoint(point: NavigationPoint): string {
  return `${JSON.stringify(toEngineObject(point), null, 2)}\n`
}

/** 写出与引擎标准一致的 JSON（无 WebUI 私有字段）。 */
export function toEngineObject(point: NavigationPoint): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (point.type !== 'position') body.type = point.type
  if (point.label.trim()) body.label = point.label.trim().slice(0, NAV_LABEL_MAX)
  if (point.radius !== NAV_RADIUS_DEFAULT) body.radius = clampRadius(point.radius)
  if (point.public) body.public = true

  if (point.type === 'position') {
    body.dimension = point.dimension.trim()
    body.x = point.x
    body.y = point.y
    body.z = point.z
    return body
  }

  const dim = point.dimension.trim()
  if (dim) body.dimension = dim
  // 空 target 也写出对应键，保证草稿往返能记住 tag / uuid 模式
  if (point.entityMode === 'uuid') {
    body.entity_uuid = point.entityUuid.trim()
  } else {
    body.entity_tag = point.entityTag.trim()
    if (point.scanRadius !== NAV_SCAN_RADIUS_DEFAULT) body.scan_radius = clampScanRadius(point.scanRadius)
  }
  return body
}

export function parseNavigationPoint(source: string): NavigationPoint {
  const raw = parseJsonValue(source)
  if (!isObject(raw)) throw new Error('导航点必须是 JSON 对象')
  return fromEngineObject(raw)
}

export function fromEngineObject(raw: Record<string, unknown>): NavigationPoint {
  const type: NavigationPointType = raw.type === 'entity' ? 'entity' : 'position'
  if (raw.type !== undefined && raw.type !== 'position' && raw.type !== 'entity') {
    throw new Error(`未知导航点类型：${String(raw.type)}（仅支持 position / entity）`)
  }

  const base = createNavigationPoint(typeof raw.label === 'string' ? raw.label : '')
  base.type = type
  base.label = typeof raw.label === 'string' ? raw.label : ''
  base.radius = typeof raw.radius === 'number' && Number.isFinite(raw.radius) ? clampRadius(raw.radius) : NAV_RADIUS_DEFAULT
  if (raw.public !== undefined && typeof raw.public !== 'boolean') throw new Error('public 必须是布尔值')
  base.public = raw.public === true
  base.dimension = typeof raw.dimension === 'string' ? raw.dimension : type === 'position' ? 'minecraft:overworld' : ''

  if (type === 'position') {
    if ('entity_uuid' in raw || 'entity_tag' in raw) throw new Error('position 类型不能包含 entity_uuid / entity_tag')
    if ('scan_radius' in raw) throw new Error('position 类型不能包含 scan_radius')
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || typeof raw.z !== 'number') {
      throw new Error('position 类型需要有限数字字段 x / y / z')
    }
    base.x = requireCoord(raw.x, 'x')
    base.y = requireCoord(raw.y, 'y')
    base.z = requireCoord(raw.z, 'z')
    return base
  }

  if ('x' in raw || 'y' in raw || 'z' in raw) throw new Error('entity 类型不能包含 x / y / z')
  const uuidRaw = typeof raw.entity_uuid === 'string' ? raw.entity_uuid.trim() : ''
  const tagRaw = typeof raw.entity_tag === 'string' ? raw.entity_tag.trim() : ''
  const hasUuidKey = typeof raw.entity_uuid === 'string' || 'entity_uuid' in raw
  if (uuidRaw && tagRaw) throw new Error('entity_uuid 与 entity_tag 只能二选一')
  // 草稿允许缺 target；用已有键推断模式，避免空 UUID 模式被读回成 tag
  if (uuidRaw || (hasUuidKey && !tagRaw)) {
    if ('scan_radius' in raw) throw new Error('entity_uuid 模式不能包含 scan_radius')
    base.entityMode = 'uuid'
    base.entityUuid = uuidRaw
  } else {
    base.entityMode = 'tag'
    base.entityTag = tagRaw
    if (raw.scan_radius !== undefined) {
      if (typeof raw.scan_radius !== 'number' || !Number.isFinite(raw.scan_radius)) throw new Error('scan_radius 须为有限数')
      base.scanRadius = clampScanRadius(raw.scan_radius)
    }
  }
  return base
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
  if (point.label.length > NAV_LABEL_MAX) issues.push(`label 长度不能超过 ${NAV_LABEL_MAX}`)
  if (!Number.isFinite(point.radius) || point.radius < NAV_RADIUS_MIN || point.radius > NAV_RADIUS_MAX) {
    issues.push(`radius 须在 ${NAV_RADIUS_MIN}..${NAV_RADIUS_MAX}`)
  }
  if (point.type === 'position') {
    if (!point.dimension.trim()) issues.push('position 必须填写 dimension')
    else if (!DIM_RE.test(point.dimension.trim())) issues.push('dimension 格式应为 namespace:path')
    for (const [name, value] of [['x', point.x], ['y', point.y], ['z', point.z]] as const) {
      if (!Number.isFinite(value) || Math.abs(value) > NAV_COORD_ABS_MAX) issues.push(`${name} 须为有限数且绝对值 ≤ ${NAV_COORD_ABS_MAX}`)
    }
  } else if (point.entityMode === 'uuid') {
    if (!point.entityUuid.trim()) issues.push('请填写 entity_uuid')
    else if (!UUID_RE.test(point.entityUuid.trim())) issues.push('entity_uuid 不是合法 UUID')
    if (point.dimension.trim() && !DIM_RE.test(point.dimension.trim())) issues.push('dimension 格式应为 namespace:path')
  } else {
    const tag = point.entityTag.trim()
    if (!tag) issues.push('请填写 entity_tag')
    else if (tag.length > NAV_TAG_MAX) issues.push(`entity_tag 长度不能超过 ${NAV_TAG_MAX}`)
    if (!Number.isFinite(point.scanRadius) || point.scanRadius < NAV_SCAN_RADIUS_MIN || point.scanRadius > NAV_SCAN_RADIUS_MAX) {
      issues.push(`scan_radius 须在 ${NAV_SCAN_RADIUS_MIN}..${NAV_SCAN_RADIUS_MAX}`)
    }
    if (point.dimension.trim() && !DIM_RE.test(point.dimension.trim())) issues.push('dimension 格式应为 namespace:path')
  }
  return issues
}

export function summarizeNavigationPoint(point: NavigationPoint): string[] {
  const lines = [
    point.label.trim() || '（未命名）',
    point.type === 'position' ? '类型：固定坐标' : '类型：绑定实体',
    `半径：${clampRadius(point.radius)} · ${point.public ? '公开可选' : '非公开'}`,
  ]
  if (point.type === 'position') {
    lines.push(`维度：${point.dimension || '—'}`)
    lines.push(`坐标：${point.x}, ${point.y}, ${point.z}`)
  } else if (point.entityMode === 'uuid') {
    lines.push(`实体 UUID：${point.entityUuid || '—'}`)
    if (point.dimension.trim()) lines.push(`限定维度：${point.dimension}`)
  } else {
    lines.push(`实体 tag：${point.entityTag || '—'}`)
    lines.push(`扫描半径：${clampScanRadius(point.scanRadius)}`)
    if (point.dimension.trim()) lines.push(`限定维度：${point.dimension}`)
  }
  const issues = validateNavigationPoint(point)
  if (issues.length) lines.push(`问题：${issues.join('；')}`)
  return lines
}

function clampRadius(value: number) {
  return Math.min(NAV_RADIUS_MAX, Math.max(NAV_RADIUS_MIN, value))
}

function clampScanRadius(value: number) {
  return Math.min(NAV_SCAN_RADIUS_MAX, Math.max(NAV_SCAN_RADIUS_MIN, value))
}

function requireCoord(value: number, name: string) {
  if (!Number.isFinite(value) || Math.abs(value) > NAV_COORD_ABS_MAX) {
    throw new Error(`${name} 须为有限数且绝对值 ≤ ${NAV_COORD_ABS_MAX}`)
  }
  return value
}
