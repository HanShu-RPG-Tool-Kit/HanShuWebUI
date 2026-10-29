import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import JSZip from 'jszip'
import { createSourceFile, type Workspace } from '../src/workspace'
import { exportPaks } from '../src/export/pack/exportPaks'
import { createShop, createShopEntry, stringifyShop } from '../src/workspaces/gameplay/shop'
import { createKitItem } from '../src/workspaces/gameplay/kit'

const shop = createShop()
shop.id = 'web-shop'; shop.tags = ['village']; shop.stockSubject = 'actor'
shop.icon = { ...createKitItem('minecraft:chest', 1), components: {
  'minecraft:custom_data': { type: 'compound', value: { shop_icon: { type: 'string', value: 'fixture' } } },
} }
shop.params = [{ id: 'level', kind: 'int', default: 2, hint: '' }]
shop.modifiers = [{ id: 'price', label: '', expr: 'x * level' }]
shop.script = [{ ref: 'trade' }]
shop.entries = [{ ...createShopEntry(), id: 'bread', tags: ['food/sell'], maxCapacity: 10,
  payment: [createKitItem('minecraft:emerald', 2)], goods: [createKitItem('minecraft:bread', 3), createKitItem('minecraft:carrot', 1)], visibility: 'level >= 2 && price(1) == 2' }]
const scripts = [createSourceFile('web-shop.shop', stringifyShop(shop)),
  createSourceFile('trade.py', 'from common.helper import marker\nassert marker() == "shop-library-ok"\nassert shop.id == "web-shop"\nassert shop.entry("bread").quantity > 0\n', 'shop'),
  createSourceFile('helper.py', 'def marker():\n    return "shop-library-ok"\n', 'common')]
const workspace = { packages: [{ id: 'shop-fixture', name: 'shop-fixture', scripts, assets: [], assetFolders: [] }], activePackageId: 'shop-fixture', activeScriptId: null } as unknown as Workspace
const exported = await exportPaks(workspace, { targets: ['server', 'client'] })
assert.ok(!exported.diagnostics.some(d => d.severity === 'error'))
for (const pack of exported.packs) {
  const bytes = new Uint8Array(await pack.blob.arrayBuffer()), zip = await JSZip.loadAsync(bytes)
  assert.equal(!!zip.file('shop/web-shop.shop'), pack.target === 'server')
  assert.equal(!!zip.file('script/shop/trade.py'), pack.target === 'server')
  if (pack.target === 'server') {
    const result = JSON.parse(await zip.file('shop/web-shop.shop')!.async('string'))
    assert.equal(Object.hasOwn(result, 'visibility'), false)
    assert.equal(Object.hasOwn(result, 'availability'), false)
    assert.equal(result.entries[0].visibility, shop.entries[0].visibility)
    assert.equal(result.entries[0].availability, shop.entries[0].availability)
    assert.equal(result.icon.id, 'minecraft:chest')
    assert.equal(result.icon.count, 1)
    assert.deepEqual(result.icon.components, shop.icon.components)
    assert.equal(result.entries[0].maxCapacity, 10)
    assert.equal(result.entries[0].goods.length, 2)
    if (process.env.SHOP_RUNTIME_PAK_PATH) { await mkdir(dirname(process.env.SHOP_RUNTIME_PAK_PATH), { recursive: true }); await writeFile(process.env.SHOP_RUNTIME_PAK_PATH, bytes) }
  }
}
console.log('PASS actual WebUI shop PAK: server template, typed Python/common scripts, tags, capacities, expressions, multi-output and client exclusion')
