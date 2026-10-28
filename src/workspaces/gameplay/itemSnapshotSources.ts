/**
 * 物品展示快照的统一来源采集。
 *
 * 工程里只有 `.item` 是权威物品定义；礼包 / 商店内嵌 ItemStack、或链接 `.item`，
 * 外加可能存在的 `.itemstack` 文档，都收敛到这里，供菜单刷新和面板状态复用。
 *
 * 纯函数：不读写缓存、不发请求，方便单测。
 */

import { parseItem } from './itemDoc'
import { expandKitItem, normalizeItemRef, parseKit, type ItemCatalog, type KitItem } from './kit'
import { parseShop } from './shop'
import { isItemStackFileName, itemFingerprint, parseItemStack } from './itemstack'

/** 刷新只需要 id + components；count 不参与指纹。 */
export type SnapshotSourceItem = {
  id: string
  components: Record<string, unknown>
}

export type SnapshotSourceContext = {
  itemCatalog: ItemCatalog
}

export type SnapshotDocumentLike = {
  key?: string
  name: string
  package: string
  source: string
}

const EMPTY_CONTEXT: SnapshotSourceContext = { itemCatalog: new Map() }
const EMPTY_ITEM_CATALOG: ItemCatalog = new Map()

function pushItem(
  out: SnapshotSourceItem[],
  seen: Set<string>,
  id: string,
  components: Record<string, unknown>,
): void {
  const itemId = id.trim()
  if (!itemId) return
  const item = { id: itemId, components: { ...components } }
  const fingerprint = itemFingerprint(item)
  if (seen.has(fingerprint)) return
  seen.add(fingerprint)
  out.push(item)
}

function fromKitItem(
  out: SnapshotSourceItem[],
  seen: Set<string>,
  item: KitItem,
  catalog: ItemCatalog,
): void {
  // 缺失的 `.item` 链接没有可靠 id，不能拿引用名当物品 id 去请求快照
  if (item.item && !catalog.has(normalizeItemRef(item.item))) return
  const expanded = expandKitItem(item, catalog)
  pushItem(out, seen, expanded.id, expanded.components)
}

/** 单个礼包/商店物品列表 → 去重后的快照来源；链接项按 itemCatalog 展开。 */
export function collectKitSnapshotItems(
  items: readonly KitItem[],
  itemCatalog: ItemCatalog = EMPTY_ITEM_CATALOG,
): SnapshotSourceItem[] {
  const out: SnapshotSourceItem[] = []
  const seen = new Set<string>()
  for (const item of items) fromKitItem(out, seen, item, itemCatalog)
  return out
}

/** `.kit` 本文件声明的 items + pools；不展开 extends / includes（父礼包由全量扫描覆盖）。 */
function collectKitDocument(doc: SnapshotDocumentLike, context: SnapshotSourceContext): SnapshotSourceItem[] {
  let kit
  try {
    kit = parseKit(doc.source)
  } catch {
    return []
  }
  const items = [
    ...kit.items,
    ...kit.pools.flatMap((pool) => pool.entries.flatMap((entry) => entry.items)),
  ]
  return collectKitSnapshotItems(items, context.itemCatalog)
}

/** `.shop` 的 payment / goods；不区分类别，统一按指纹去重。 */
function collectShopDocument(doc: SnapshotDocumentLike, context: SnapshotSourceContext): SnapshotSourceItem[] {
  let shop
  try {
    // 草稿状态下也允许刷新已填好的物品，不因其它字段未完成而整体跳过
    shop = parseShop(doc.source, true)
  } catch {
    return []
  }
  const items = shop.entries.flatMap((entry) => [...entry.payment, ...entry.goods])
  return collectKitSnapshotItems(items, context.itemCatalog)
}

function collectItemDocument(doc: SnapshotDocumentLike): SnapshotSourceItem[] {
  try {
    const parsed = parseItem(doc.source)
    const out: SnapshotSourceItem[] = []
    pushItem(out, new Set(), parsed.item.id, parsed.item.components)
    return out
  } catch {
    return []
  }
}

function collectItemStackDocument(doc: SnapshotDocumentLike): SnapshotSourceItem[] {
  try {
    const parsed = parseItemStack(doc.source)
    const out: SnapshotSourceItem[] = []
    pushItem(out, new Set(), parsed.item.id, parsed.item.components)
    return out
  } catch {
    return []
  }
}

/**
 * 一个文档里需要展示快照的全部 ItemStack。
 *
 * - `.itemstack` 文档按 ItemStack 解析，display 只当缓存，不参与刷新
 * - `.kit` 只取本文件 items / pools
 * - `.shop` 取所有条目的 payment / goods
 * - 物品库表视图等虚拟文档没有 source，返回空
 */
export function collectDocumentSnapshotItems(
  doc: SnapshotDocumentLike,
  context: SnapshotSourceContext = EMPTY_CONTEXT,
): SnapshotSourceItem[] {
  if (!doc.source.trim()) return []
  const name = doc.name.toLowerCase()
  if (isItemStackFileName(name)) return collectItemStackDocument(doc)
  if (name.endsWith('.kit') || doc.package === 'gift') return collectKitDocument(doc, context)
  if (name.endsWith('.shop') || doc.package === 'shop') return collectShopDocument(doc, context)
  if (name.endsWith('.item') || doc.package === 'items') return collectItemDocument(doc)
  return []
}

/** 跨文档采集并按指纹去重；“刷新全部”和物品库表视图共用。 */
export function collectWorkspaceSnapshotItems(
  documents: readonly SnapshotDocumentLike[],
  context: SnapshotSourceContext = EMPTY_CONTEXT,
): SnapshotSourceItem[] {
  const out: SnapshotSourceItem[] = []
  const seen = new Set<string>()
  for (const doc of documents) {
    const items = collectDocumentSnapshotItems(doc, context)
    for (const item of items) pushItem(out, seen, item.id, item.components)
  }
  return out
}
