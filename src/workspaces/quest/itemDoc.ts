import {readDisplayTextEditor,type DisplayTextEditor} from './displayTextEditor'
import { readItemSync, TEMPLATE_COMPONENT, type ItemSync } from './itemSync'
/**
 * `.item` 物品库文档：与 `.itemstack` 同源，但不存 count。
 * format / schemaVersion / item.id 为必填；缺一即非法。
 */

import { readComponents, type ItemComponents } from './tnbtJson'
import { isObject } from './model'
import { parseJsonValue } from '../../utils/strictJson'
import { ingestDisplay } from './itemSnapshotCache'
import {
  parseItemStack,
  readItemStackDisplay,
  type ItemStackDisplay,
  type ItemStackFile,
} from './itemstack'

export const ITEM_FORMAT = 'rpgtoolkit:item'
export const ITEM_SCHEMA_VERSION = 2
export const ITEM_SCHEMA_MAX = 2
export const DEFAULT_ITEM_ID = 'minecraft:stick'

export type ItemData = {
  id: string
  components: ItemComponents
}

export type ItemDocument = {
  displayTextEditor?: DisplayTextEditor
  format: string
  schemaVersion: number
  /** 游戏标签：引擎可按标签查询；空则不写入文件 */
  tags: string[]
  item: ItemData
  sync?: ItemSync
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
  const components = readComponents(value.components, `${path}.components`)
  const id = readString(value.id).trim()
  if (!id) throw new Error(`${path}.id 不能为空`)
  return { id, components }
}

export function createItem(id = DEFAULT_ITEM_ID): ItemDocument {
  return {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    tags: [],
    sync: readItemSync(undefined),
    item: { id, components: {} },
  }
}

export function stringifyItem(doc: ItemDocument): string {
  const body: Record<string, unknown> = {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    sync: readItemSync(doc.sync),
    ...(doc.displayTextEditor?{displayTextEditor:readDisplayTextEditor(doc.displayTextEditor)}:{}),
    item: {
      id: doc.item.id.trim() || DEFAULT_ITEM_ID,
      components: readComponents(doc.item.components),
    },
  }
  const tags = unionItemTags(doc.tags)
  if (tags.length > 0) body.tags = tags
  // display 已迁出到本机快照缓存，工程文件不再写入
  return `${JSON.stringify(body, null, 2)}\n`
}

export function parseItem(source: string): ItemDocument {
  const raw = parseJsonValue(source.replace(/^\uFEFF/, ''), 96)
  if (!isObject(raw)) throw new Error('`.item` 根节点应为 JSON 对象')
  const format = readString(raw.format)
  if (!format) throw new Error('缺少 format')
  if (format !== ITEM_FORMAT) throw new Error(`未知 format：${format}（需要 ${ITEM_FORMAT}）`)
  if (typeof raw.schemaVersion !== 'number' || !Number.isFinite(raw.schemaVersion)) {
    throw new Error('缺少 schemaVersion')
  }
  const schemaVersion = raw.schemaVersion
  if (schemaVersion !== ITEM_SCHEMA_VERSION) throw new Error(`需要 .item v${ITEM_SCHEMA_VERSION}（TNBT JSON 完整组件集合），不支持版本 ${schemaVersion}`)
  if (!('item' in raw)) throw new Error('缺少 item')
  const item = readItemData(raw.item, 'item')
  const tags = readItemTags(raw.tags)
  const legacyDisplay = readItemStackDisplay(raw.display)
  if (legacyDisplay) ingestDisplay(item, legacyDisplay)
  return { format, schemaVersion, tags, item, sync: readItemSync(raw.sync), ...('displayTextEditor' in raw?{displayTextEditor:readDisplayTextEditor(raw.displayTextEditor)}:{}) }
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

/** `.itemstack` → `.item`：去掉 count；display 只 ingest 进本机缓存，不进文档 */
export function itemFromItemStack(file: ItemStackFile): ItemDocument {
  const item: ItemData = {
    id: file.item.id.trim(),
    components: readComponents(file.item.components),
  }
  delete item.components[TEMPLATE_COMPONENT]
  if (!item.id) throw new Error('item.id 不能为空')
  if (file.display) ingestDisplay(item, file.display)
  return {
    format: ITEM_FORMAT,
    schemaVersion: ITEM_SCHEMA_VERSION,
    tags: [],
    sync: readItemSync(undefined),
    item,
  }
}

export function itemFromItemStackSource(source: string): ItemDocument {
  return itemFromItemStack(parseItemStack(source))
}

/** @deprecated display 已出文件；保留空操作以免旧调用方报错 */
export function withStaleAwareDisplay(doc: ItemDocument): ItemDocument {
  if (doc.display) ingestDisplay(doc.item, doc.display)
  return { format: doc.format, schemaVersion: doc.schemaVersion, tags: doc.tags, item: doc.item, sync: readItemSync(doc.sync) }
}

export function itemPresentable(doc: ItemDocument): {
  id: string
  count: number
  components: Record<string, unknown>
} {
  return {
    id: doc.item.id,
    count: 1,
    components: readComponents(doc.item.components),
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
