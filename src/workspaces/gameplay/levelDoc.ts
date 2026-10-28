import { normalizeKitTag, unionKitTags } from './kit'
import { parseJsonValue } from '../../utils/strictJson'
import { isObject } from './model'
import {
  NAV_COORD_ABS_MAX,
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MAX_DISTANCE,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_NAME,
  NAV_LABEL_MAX,
  NAV_TYPE_POS,
  type NavTypeId,
} from './navigationPoint'

/**
 * 地图模板（`.level`）的作者文档。
 *
 * 编辑侧是一个模板文件里嵌 regions + 导航点；编译时摊平成：
 *   levels/<模板>.json
 *   regions/<模板>$<区域 id>.json
 *   navigation_points/<模板>$<导航点 id>.json
 *
 * 因此子对象的 `level` 由编译器写入，作者不写；区域/导航点的 `id` 只在本模板内唯一。
 */
export type LevelY = 'all' | [number, number]

export type LevelRectArea = { kind: 'rect'; x: [number, number]; z: [number, number]; y: LevelY }
export type LevelCircleArea = { kind: 'circle'; center: [number, number]; radius: number; y: LevelY }
export type LevelPolygonArea = { kind: 'polygon'; points: [number, number][]; y: LevelY }
export type LevelArea = LevelRectArea | LevelCircleArea | LevelPolygonArea

export type LevelCustomData = Record<string, unknown>

export type LevelRegion = {
  id: string
  areas: LevelArea[]
  custom_data: LevelCustomData
}

export type LevelNavigationPoint = {
  id: string
  type: NavTypeId
  param: { x: number; y: number; z: number }
  custom_data: LevelCustomData
}

export type LevelDocument = {
  tags: string[]
  regions: LevelRegion[]
  navigation: LevelNavigationPoint[]
  custom_data: LevelCustomData
}

export const LEVEL_EXT = '.level'
export const LEVEL_ID_MAX = 64
export const LEVEL_AREAS_MAX = 256
export const LEVEL_CHILD_SEPARATOR = '$'

const LEVEL_ID_RE = /^[^$\\/:*?"<>|\u0000-\u001f]+$/
const IDENTIFIER_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i

export function levelTemplateId(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.level$/i, '')
}

/** 导出 id：`<模板>$<本地 id>`；mod 侧由文件路径还原出同一个 ID。 */
export function levelChildExportId(templateId: string, childId: string): string {
  return `${templateId}${LEVEL_CHILD_SEPARATOR}${childId}`
}

export function createLevelDocument(): LevelDocument {
  return { tags: [], regions: [], navigation: [], custom_data: {} }
}

export function stringifyLevelDocument(doc: LevelDocument): string {
  return `${JSON.stringify(toAuthorObject(doc), null, 2)}\n`
}

function toAuthorObject(doc: LevelDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    tags: doc.tags,
    regions: doc.regions.map((region) => ({
      id: region.id,
      areas: region.areas.map(areaToJson),
      ...(Object.keys(region.custom_data).length ? { custom_data: region.custom_data } : {}),
    })),
    navigation: doc.navigation.map((point) => ({
      id: point.id,
      type: point.type,
      param: { x: point.param.x, y: point.param.y, z: point.param.z },
      ...(Object.keys(point.custom_data).length ? { custom_data: point.custom_data } : {}),
    })),
  }
  if (Object.keys(doc.custom_data).length) out.custom_data = doc.custom_data
  return out
}

function areaToJson(area: LevelArea): Record<string, unknown> {
  if (area.kind === 'rect') return { x: area.x, z: area.z, y: area.y }
  if (area.kind === 'circle') return { shape: 'circle', center: area.center, radius: area.radius, y: area.y }
  return { shape: 'polygon', points: area.points, y: area.y }
}

export function parseLevelDocument(source: string): LevelDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw)) throw new Error('地图模板必须是 JSON 对象')
  for (const key of Object.keys(raw)) {
    if (!['tags', 'regions', 'navigation', 'custom_data'].includes(key)) throw new Error(`未知地图模板字段：${key}`)
  }
  const tags = readTags(raw.tags, 'tags')
  const regions = readList(raw.regions, 'regions').map((value, index) => readRegion(value, `regions[${index}]`))
  const navigation = readList(raw.navigation, 'navigation').map((value, index) => readNavigationPoint(value, `navigation[${index}]`))
  const customData = readCustomData(raw.custom_data, 'custom_data')
  const doc: LevelDocument = { tags, regions, navigation, custom_data: customData }
  for (const issue of validateLevelDocument(doc)) throw new Error(issue)
  return doc
}

export function readLevelSource(source: string): { doc: LevelDocument | null; error: string } {
  try {
    return { doc: parseLevelDocument(source), error: '' }
  } catch (error) {
    return { doc: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function readRegion(value: unknown, path: string): LevelRegion {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  for (const key of Object.keys(value)) {
    if (!['id', 'areas', 'custom_data'].includes(key)) throw new Error(`${path} 未知字段：${key}`)
  }
  const id = readId(value.id, `${path}.id`)
  const areas = readList(value.areas, `${path}.areas`).map((area, index) => readArea(area, `${path}.areas[${index}]`))
  if (areas.length < 1) throw new Error(`${path}.areas 至少需要一个 Area`)
  if (areas.length > LEVEL_AREAS_MAX) throw new Error(`${path}.areas 最多 ${LEVEL_AREAS_MAX} 个`)
  return { id, areas, custom_data: readCustomData(value.custom_data, `${path}.custom_data`) }
}

function readArea(value: unknown, path: string): LevelArea {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const declared = typeof value.shape === 'string' ? value.shape : undefined
  if (declared !== undefined && !['rect', 'circle', 'polygon'].includes(declared)) {
    throw new Error(`${path}.shape 只能是 rect / circle / polygon`)
  }
  const inferred = declared ?? ('points' in value ? 'polygon' : 'center' in value ? 'circle' : 'rect')
  const y = readY(value.y, `${path}.y`)
  const hasXZ = 'x' in value || 'z' in value
  const hasCenter = 'center' in value
  const hasPoints = 'points' in value
  if (inferred === 'circle') {
    if (hasXZ || hasPoints) throw new Error(`${path} 的 circle 不能同时包含 x/z 或 points`)
    return { kind: 'circle', center: readPair(value.center, `${path}.center`), radius: readPositive(value.radius, `${path}.radius`), y }
  }
  if (inferred === 'polygon') {
    if (hasXZ || hasCenter) throw new Error(`${path} 的 polygon 不能同时包含 x/z 或 center`)
    const points = readList(value.points, `${path}.points`).map((point, index) => readPair(point, `${path}.points[${index}]`))
    if (points.length < 3) throw new Error(`${path}.points 至少需要 3 个点`)
    return { kind: 'polygon', points, y }
  }
  if (hasCenter || hasPoints) throw new Error(`${path} 的 rect 不能同时包含 center 或 points`)
  return { kind: 'rect', x: readRange(value.x, `${path}.x`), z: readRange(value.z, `${path}.z`), y }
}

function readNavigationPoint(value: unknown, path: string): LevelNavigationPoint {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  for (const key of Object.keys(value)) {
    if (!['id', 'type', 'param', 'custom_data'].includes(key)) throw new Error(`${path} 未知字段：${key}`)
  }
  const id = readId(value.id, `${path}.id`)
  if (value.type !== NAV_TYPE_POS) throw new Error(`${path}.type 本轮只支持 ${NAV_TYPE_POS}`)
  if (!isObject(value.param)) throw new Error(`${path}.param 应为对象`)
  for (const key of Object.keys(value.param)) if (!['x', 'y', 'z'].includes(key)) throw new Error(`${path}.param 未知字段：${key}`)
  const param = {
    x: readCoord(value.param.x, `${path}.param.x`),
    y: readCoord(value.param.y, `${path}.param.y`),
    z: readCoord(value.param.z, `${path}.param.z`),
  }
  const custom = readCustomData(value.custom_data, `${path}.custom_data`)
  validateDisplayData(custom, path)
  return { id, type: NAV_TYPE_POS, param, custom_data: custom }
}

function validateDisplayData(custom: LevelCustomData, path: string) {
  const name = custom[NAV_DISPLAY_NAME]
  if (name !== undefined && (typeof name !== 'string' || name.length > NAV_LABEL_MAX)) {
    throw new Error(`${path}.${NAV_DISPLAY_NAME} 必须是 ≤ ${NAV_LABEL_MAX} 的字符串`)
  }
  const icon = custom[NAV_DISPLAY_ICON]
  if (icon !== undefined && (typeof icon !== 'string' || (icon.trim() !== '' && !IDENTIFIER_RE.test(icon.trim())))) {
    throw new Error(`${path}.${NAV_DISPLAY_ICON} 须为 namespace:path`)
  }
  for (const key of [NAV_DISPLAY_MIN_DISTANCE, NAV_DISPLAY_MAX_DISTANCE]) {
    const value = custom[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${path}.${key} 须为 ≥ 0 的有限数`)
    }
  }
}

export function validateLevelDocument(doc: LevelDocument): string[] {
  const issues: string[] = []
  const sawRegion = new Set<string>()
  doc.regions.forEach((region, index) => {
    const path = `regions[${index}]`
    issues.push(...validateId(region.id, `${path}.id`))
    const key = region.id.trim()
    if (sawRegion.has(key.toLowerCase())) issues.push(`${path}.id 与前面的区域重复：${key}`)
    sawRegion.add(key.toLowerCase())
    if (region.areas.length < 1 || region.areas.length > LEVEL_AREAS_MAX) issues.push(`${path}.areas 需要 1..${LEVEL_AREAS_MAX} 个`)
  })
  const sawNav = new Set<string>()
  doc.navigation.forEach((point, index) => {
    const path = `navigation[${index}]`
    issues.push(...validateId(point.id, `${path}.id`))
    const key = point.id.trim()
    if (sawNav.has(key.toLowerCase())) issues.push(`${path}.id 与前面的导航点重复：${key}`)
    sawNav.add(key.toLowerCase())
  })
  return issues
}

function validateId(value: string, path: string): string[] {
  const id = value.trim()
  if (!id) return [`${path} 不能为空`]
  if (id.length > LEVEL_ID_MAX) return [`${path} 不能超过 ${LEVEL_ID_MAX} 个字符`]
  if (!LEVEL_ID_RE.test(id) || id === '.' || id === '..') return [`${path} 不能包含 $ \\ / : * ? " < > | 或控制字符`]
  return []
}

function readId(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} 应为字符串`)
  const issues = validateId(value, path)
  if (issues.length) throw new Error(issues[0])
  return value.trim()
}

function readY(value: unknown, path: string): LevelY {
  if (value === undefined || value === 'all') return 'all'
  return readRange(value, path)
}

function readRange(value: unknown, path: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${path} 应为 [min, max]`)
  const min = readNumber(value[0], `${path}[0]`)
  const max = readNumber(value[1], `${path}[1]`)
  if (min > max) throw new Error(`${path} 的 min 不能大于 max`)
  return [min, max]
}

function readPair(value: unknown, path: string): [number, number] {
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new Error(`${path} 应为 [x, z]`)
    return [readNumber(value[0], `${path}[0]`), readNumber(value[1], `${path}[1]`)]
  }
  if (isObject(value)) {
    return [readNumber(value.x, `${path}.x`), readNumber(value.z, `${path}.z`)]
  }
  throw new Error(`${path} 应为 [x, z] 或 { x, z }`)
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 应为有限数字`)
  return value
}

function readPositive(value: unknown, path: string): number {
  const number = readNumber(value, path)
  if (number <= 0) throw new Error(`${path} 必须大于 0`)
  return number
}

function readCoord(value: unknown, path: string): number {
  const number = readNumber(value, path)
  if (Math.abs(number) > NAV_COORD_ABS_MAX) throw new Error(`${path} 绝对值不能超过 ${NAV_COORD_ABS_MAX}`)
  return number
}

function readTags(value: unknown, path: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} 应为数组`)
  return unionKitTags(value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${path}[${index}] 应为字符串`)
    const tag = normalizeKitTag(item)
    if (!tag) throw new Error(`${path}[${index}] 不能为空`)
    return tag
  }))
}

function readCustomData(value: unknown, path: string): LevelCustomData {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} 应为 JSON 对象`)
  return { ...value }
}

function readList(value: unknown, path: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path} 应为数组`)
  return value
}
