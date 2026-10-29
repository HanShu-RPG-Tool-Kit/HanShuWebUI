/**
 * 物品快照来源采集：.item / .itemstack / .kit / .shop 统一展开与去重。
 */

import assert from 'node:assert/strict'
import { createItem, stringifyItem } from '../src/workspaces/gameplay/itemDoc.ts'
import { createKit, stringifyKit } from '../src/workspaces/gameplay/kit.ts'
import { createShop, createShopEntry, stringifyShop } from '../src/workspaces/gameplay/shop.ts'
import {
  ITEMSTACK_FORMAT,
  ITEMSTACK_SCHEMA_VERSION,
  stringifyItemStack,
} from '../src/workspaces/gameplay/itemstack.ts'
import {
  collectDocumentSnapshotItems,
  collectKitSnapshotItems,
  collectWorkspaceSnapshotItems,
} from '../src/workspaces/gameplay/itemSnapshotSources.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed += 1
  console.log(`[OK] ${name}`)
}

const emerald = createItem('minecraft:emerald')
const catalog = new Map([['货币', emerald]])
const itemDoc = { name: '货币.item', package: 'items', source: stringifyItem(emerald) }

const kit = createKit()
kit.items = [
  { item: '货币', id: '', components: {}, count: 2 },
  { id: 'minecraft:bread', components: {}, count: 1 },
  { item: '不存在', id: '', components: {}, count: 9 },
]
kit.pools = [{
  rolls: 1,
  entries: [{
    weight: 1,
    items: [
      { id: 'minecraft:apple', components: {}, count: 1 },
      // 与上面 bread 指纹相同：count 不参与指纹，只保留一项
      { id: 'minecraft:bread', components: {}, count: 4 },
    ],
  }],
}]
const kitDoc = { name: '新手礼包.kit', package: 'gift', source: stringifyKit(kit) }

const shop = createShop()
shop.entries = [
  { ...createShopEntry(), payment: [{ item: '货币', id: '', components: {}, count: 2 }], goods: [{ id: 'minecraft:bread', components: {}, count: 3 }] },
  { ...createShopEntry(), payment: [], goods: [{ item: '货币', id: '', components: {}, count: 1 }] },
]
const shopDoc = { name: '村庄商店.shop', package: 'shop', source: stringifyShop(shop) }

const stackDoc = {
  name: '木棍.itemstack',
  package: 'items',
  source: stringifyItemStack({
    format: ITEMSTACK_FORMAT,
    schemaVersion: ITEMSTACK_SCHEMA_VERSION,
    item: { id: 'minecraft:stick', count: 5, components: {} },
  }),
}

test('.item 只取权威 item', () => {
  const items = collectDocumentSnapshotItems(itemDoc)
  assert.deepEqual(items.map((item) => item.id), ['minecraft:emerald'])
})

test('.itemstack 文档按 ItemStack 解析', () => {
  const items = collectDocumentSnapshotItems(stackDoc)
  assert.deepEqual(items.map((item) => item.id), ['minecraft:stick'])
})

test('.kit 含链接、内嵌、随机池，按指纹去重且跳过缺失链接', () => {
  const items = collectDocumentSnapshotItems(kitDoc, { itemCatalog: catalog })
  assert.deepEqual(items.map((item) => item.id).sort(), ['minecraft:apple', 'minecraft:bread', 'minecraft:emerald'])
})

test('.shop 合并 payment 与 goods 并跨条目去重', () => {
  const items = collectDocumentSnapshotItems(shopDoc, { itemCatalog: catalog })
  assert.deepEqual(items.map((item) => item.id).sort(), ['minecraft:bread', 'minecraft:emerald'])
})

test('.shop 图标参与快照采集并保留物品链接', () => {
 const source = stringifyShop({ ...shop, icon: { id: 'minecraft:diamond', count: 1, components: {} } })
 const items = collectDocumentSnapshotItems({ ...shopDoc, source }, { itemCatalog: catalog })
 assert(items.some(item => item.id === 'minecraft:diamond'))
 const linked = stringifyShop({ ...shop, icon: { item: '货币', id: '', count: 1, components: {} } })
 assert(collectDocumentSnapshotItems({ ...shopDoc, source: linked }, { itemCatalog: catalog }).some(item => item.id === 'minecraft:emerald'))
})

test('跨文档全量按指纹去重', () => {
  const items = collectWorkspaceSnapshotItems([itemDoc, kitDoc, shopDoc, stackDoc], { itemCatalog: catalog })
  assert.deepEqual(
    items.map((item) => item.id).sort(),
    ['minecraft:apple', 'minecraft:bread', 'minecraft:emerald', 'minecraft:stick'],
  )
})

test('虚拟文档/空正文不产生请求', () => {
  assert.deepEqual(collectDocumentSnapshotItems({ name: '物品库表视图', package: 'items', source: '' }), [])
})

test('礼包链接列表可直接供面板汇总使用', () => {
  const items = collectKitSnapshotItems(kit.items, catalog)
  assert.deepEqual(items.map((item) => item.id).sort(), ['minecraft:bread', 'minecraft:emerald'])
})

console.log(`\n${passed} 项通过`)
