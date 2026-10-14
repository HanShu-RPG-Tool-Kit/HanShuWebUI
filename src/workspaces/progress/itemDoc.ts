/**
 * `.item` 物品库文档：与 `.itemstack` 同源，但不存 count。
 * format / schemaVersion / item.id 为必填；缺一即非法。
 */

import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import {
  itemFingerprint,
  parseItemStack,
  readItemStackDisplay,
  type ItemStackDisplay,
  type ItemStackFile,
} from './itemstack'

export const ITEM_FORMAT = 'rpgtoolkit:item'
export const ITEM_SCHEMA_VERSION = 1
export const ITEM_SCHEMA_MAX = 1
export const DEFAULT_ITEM_ID = 'minecraft:stick'

export type ItemData = {
  id: string
  components: Record<string, unknown>
}

export type ItemDocument = {
  format: string
  schemaVersion: number
  /** 游戏标签：引擎可按标签查询；空则不写入文件 */
  tags: string[]
  item: ItemData
  display?: ItemStackDisplay
}

export const isItemFileName = (name: string) => /\.item$/i.test(name) && !/\.itemstack$/i.test(name)

const readString = (value: unknown) => typeof value === 'string' ? value : ''

/** 规范化标签：去首尾空白；空串视为无效（与礼包 tags 相同规则） */
export function normalizeItemTag(value: string): string {
  return value.trim().normalize('NFC')
}

/** 去重并集：大小写不敏感，保留先出现的写法 */
export function unionItemTags(...groups: string[][]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const raw of group) {
      const tag = normalizeItemTag(raw)
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(tag)
    }
  }
  return result
}

function readItemTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('tags 应为字符串数组')
  const tags: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'string') throw new Error(`tags[${index}] 应为字符串`)
    const tag = normalizeItemTag(item)
    if (!tag) throw new Error(`tags[${index}] 不能为空`)
    tags.push(tag)
  }
  return unionItemTags(tags)
}

function readItemData(value: unknown, path: string): ItemData {
  if (!isObject(value)) throw new Error(`${path} 应为对象`)
  let components: Record<string, unknown> = {}
  if (value.components !== undefined) {
    if (!isObject(value.components)) throw new Error(`${path}.components 应为对象`)
    components = { ...value.components }
  }
  const id = readString(value.id).trim()
  if (!id) throw new Error(`${path}.id 不能为空`)
  return { id, components }
}

export function createItem(id = DEFAULT_ITEM_ID): ItemDocument {
  return {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    tags: [],
    item: { id, components: {} },
  }
}

export function stringifyItem(doc: ItemDocument): string {
  const body: Record<string, unknown> = {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    item: {
      id: doc.item.id.trim() || DEFAULT_ITEM_ID,
      components: doc.item.components,
    },
  }
  const tags = unionItemTags(doc.tags)
  if (tags.length > 0) body.tags = tags
  if (doc.display) body.display = doc.display
  return `${JSON.stringify(body, null, 2)}\n`
}

export function parseItem(source: string): ItemDocument {
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''))
  if (!isObject(raw)) throw new Error('`.item` 根节点应为 JSON 对象')
  const format = readString(raw.format)
  if (!format) throw new Error('缺少 format')
  if (format !== ITEM_FORMAT) throw new Error(`未知 format：${format}（需要 ${ITEM_FORMAT}）`)
  if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion)) {
    throw new Error('缺少 schemaVersion')
  }
  const schemaVersion = Math.floor(raw.schemaVersion)
  if (schemaVersion < 1) throw new Error(`schemaVersion 无效：${schemaVersion}`)
  if (schemaVersion > ITEM_SCHEMA_MAX) {
    throw new Error(`schemaVersion ${schemaVersion} 过高（当前支持 1..${ITEM_SCHEMA_MAX}）`)
  }
  if (!('item' in raw)) throw new Error('缺少 item')
  const item = readItemData(raw.item, 'item')
  const tags = readItemTags(raw.tags)
  const display = readItemStackDisplay(raw.display)
  return { format, schemaVersion, tags, item, display }
}

export function readItemSource(source: string): { doc: ItemDocument; error: string } {
  try {
    return { doc: parseItem(source), error: '' }
  } catch (cause) {
    return {
      doc: createItem(),
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** `.itemstack` → `.item`：去掉 count，改 format / schemaVersion，保留组件与快照 */
export function itemFromItemStack(file: ItemStackFile): ItemDocument {
  const item: ItemData = {
    id: file.item.id.trim(),
    components: { ...file.item.components },
  }
  if (!item.id) throw new Error('item.id 不能为空')
  const display = file.display
    ? { ...file.display, snapshotOf: itemFingerprint(item) }
    : undefined
  return {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    tags: [],
    item,
    display,
  }
}

export function itemFromItemStackSource(source: string): ItemDocument {
  return itemFromItemStack(parseItemStack(source))
}

/** 编辑后若改了 id/components，快照指纹仍指向旧数据 → 视为过期（保留图标等展示） */
export function withStaleAwareDisplay(doc: ItemDocument): ItemDocument {
  if (!doc.display) return doc
  return {
    ...doc,
    display: {
      ...doc.display,
      snapshotOf: doc.display.snapshotOf ?? itemFingerprint(doc.item),
    },
  }
}

export function itemPresentable(doc: ItemDocument): {
  id: string
  count: number
  components: Record<string, unknown>
  display?: ItemStackDisplay
} {
  return {
    id: doc.item.id,
    count: 1,
    components: doc.item.components,
    display: doc.display,
  }
}

export async function readItemStackAsItems(files: Iterable<File>): Promise<{
  items: { name: string; doc: ItemDocument }[]
  errors: string[]
}> {
  const items: { name: string; doc: ItemDocument }[] = []
  const errors: string[] = []
  for (const file of files) {
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.itemstack')) continue
    try {
      const doc = itemFromItemStackSource(await file.text())
      const name = file.name.replace(/\.itemstack$/i, '.item')
      items.push({ name, doc })
    } catch (cause) {
      errors.push(`${file.name}：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return { items, errors }
}
