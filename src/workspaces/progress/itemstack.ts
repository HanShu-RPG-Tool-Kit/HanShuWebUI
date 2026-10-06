import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'

export const ITEMSTACK_FORMAT = 'rpgtoolkit:itemstack'
export const ITEMSTACK_SCHEMA_MAX = 2

export type ItemTextSegment = {
  text: string
  color?: string
  shadowColor?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

export type ItemStackIcon = {
  mime: string
  size: number
  glint: boolean
  data: string
}

/** `.itemstack` 的 display 快照；只给 UI，权威数据在 item */
export type ItemStackDisplay = {
  locale?: string
  advanced?: boolean
  generatedAt?: number
  defaultColor?: string
  name?: ItemTextSegment[]
  tooltip?: ItemTextSegment[][]
  rarity?: string
  rarityColor?: string
  foil?: boolean
  tooltipStyle?: string | null
  icon?: ItemStackIcon
  /** WebUI 扩展：生成快照时 id + components 的指纹，不一致即快照过期 */
  snapshotOf?: string
}

export type ItemStackData = {
  id: string
  count: number
  components: Record<string, unknown>
}

export type ItemStackFile = {
  format: string
  schemaVersion: number
  item: ItemStackData
  display?: ItemStackDisplay
}

export type KitItemFromStack = ItemStackData & { display?: ItemStackDisplay }

export const isItemStackFileName = (name: string) => /\.itemstack$/i.test(name)

const readString = (value: unknown) => typeof value === 'string' ? value : ''

function readSegment(value: unknown, path: string): ItemTextSegment {
  if (!isObject(value)) throw new Error(`${path} 应为文本片段对象`)
  const text = readString(value.text)
  const segment: ItemTextSegment = { text }
  if (typeof value.color === 'string') segment.color = value.color
  if (typeof value.shadowColor === 'string') segment.shadowColor = value.shadowColor
  if (value.bold === true) segment.bold = true
  if (value.italic === true) segment.italic = true
  if (value.underlined === true) segment.underlined = true
  if (value.strikethrough === true) segment.strikethrough = true
  if (value.obfuscated === true) segment.obfuscated = true
  return segment
}

function readIcon(value: unknown, path: string): ItemStackIcon | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  const data = readString(value.data)
  if (!data) return undefined
  return {
    mime: readString(value.mime) || 'image/png',
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? Math.max(1, Math.floor(value.size)) : 128,
    glint: value.glint === true,
    data,
  }
}

export function readItemStackDisplay(value: unknown): ItemStackDisplay | undefined {
  if (!isObject(value)) return undefined
  const display: ItemStackDisplay = {}
  if (typeof value.locale === 'string') display.locale = value.locale
  if (typeof value.advanced === 'boolean') display.advanced = value.advanced
  if (typeof value.generatedAt === 'number' && Number.isFinite(value.generatedAt)) display.generatedAt = value.generatedAt
  if (typeof value.defaultColor === 'string') display.defaultColor = value.defaultColor
  if (Array.isArray(value.name)) display.name = value.name.map((segment, index) => readSegment(segment, `display.name[${index}]`))
  if (Array.isArray(value.tooltip)) {
    display.tooltip = value.tooltip.map((line, lineIndex) => {
      if (!Array.isArray(line)) throw new Error(`display.tooltip[${lineIndex}] 应为片段数组`)
      return line.map((segment, index) => readSegment(segment, `display.tooltip[${lineIndex}][${index}]`))
    })
  }
  if (typeof value.rarity === 'string') display.rarity = value.rarity
  if (typeof value.rarityColor === 'string') display.rarityColor = value.rarityColor
  if (typeof value.foil === 'boolean') display.foil = value.foil
  if (value.tooltipStyle === null || typeof value.tooltipStyle === 'string') display.tooltipStyle = value.tooltipStyle
  const icon = readIcon(value.icon, 'display.icon')
  if (icon) display.icon = icon
  if (typeof value.snapshotOf === 'string') display.snapshotOf = value.snapshotOf
  return display
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 数量不影响 tooltip 与图标，不参与指纹 */
export function itemFingerprint(item: { id: string; components: Record<string, unknown> }): string {
  const text = stableStringify({ id: item.id, components: item.components })
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function isSnapshotFresh(item: { id: string; components: Record<string, unknown>; display?: ItemStackDisplay }): boolean {
  return !!item.display && item.display.snapshotOf === itemFingerprint(item)
}

function readItem(value: unknown, path: string): ItemStackData {
  if (!isObject(value)) throw new Error(`${path} 应为 ItemStack 对象`)
  let components: Record<string, unknown> = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 应为对象`)
    components = value.components
  }
  const count = typeof value.count === 'number' && Number.isFinite(value.count) ? Math.max(0, Math.floor(value.count)) : 1
  return { id: readString(value.id), count, components }
}

export function parseItemStack(source: string): ItemStackFile {
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''))
  if (!isObject(raw)) throw new Error('`.itemstack` 根节点应为 JSON 对象')
  const format = readString(raw.format) || ITEMSTACK_FORMAT
  if (format !== ITEMSTACK_FORMAT) throw new Error(`未知 format：${format}`)
  const schemaVersion = typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
    ? Math.floor(raw.schemaVersion)
    : 1
  if (schemaVersion < 1) throw new Error(`schemaVersion 无效：${schemaVersion}`)
  if (schemaVersion > ITEMSTACK_SCHEMA_MAX) {
    throw new Error(`schemaVersion ${schemaVersion} 过高（当前支持 1..${ITEMSTACK_SCHEMA_MAX}）`)
  }
  if (!('item' in raw)) throw new Error('缺少 item')
  const item = readItem(raw.item, 'item')
  if (!item.id) throw new Error('item.id 不能为空')
  const display = schemaVersion >= 2 ? readItemStackDisplay(raw.display) : undefined
  return { format, schemaVersion, item, display }
}

/** 导入：只取 item 为权威数据；display 仅附带给 UI */
export function kitItemFromItemStack(file: ItemStackFile): KitItemFromStack {
  if (!file.display) return { ...file.item }
  return { ...file.item, display: { ...file.display, snapshotOf: itemFingerprint(file.item) } }
}

export async function readItemStackFiles(files: Iterable<File>): Promise<{ items: KitItemFromStack[]; errors: string[] }> {
  const items: KitItemFromStack[] = []
  const errors: string[] = []
  for (const file of files) {
    if (!isItemStackFileName(file.name)) continue
    try {
      items.push(kitItemFromItemStack(parseItemStack(await file.text())))
    } catch (cause) {
      errors.push(`${file.name}：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return { items, errors }
}

export function itemStackIconSrc(icon: ItemStackIcon): string {
  return `data:${icon.mime || 'image/png'};base64,${icon.data}`
}

export function segmentPlainText(segments: ItemTextSegment[] | undefined): string {
  if (!segments?.length) return ''
  return segments.map((segment) => segment.text).join('')
}

export function hasItemStackDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types ?? [])
  if (types.some((type) => type.toLowerCase() === 'files')) return true
  return Array.from(dataTransfer.files ?? []).some((file) => isItemStackFileName(file.name))
}

export function collectItemStackFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files ?? []).filter((file) => isItemStackFileName(file.name))
}

export function itemHasFoil(display: ItemStackDisplay | undefined): boolean {
  return display?.foil === true
}
