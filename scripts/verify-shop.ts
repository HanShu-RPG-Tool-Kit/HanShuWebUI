import assert from 'node:assert/strict'
import { createShop, createShopEntry, parseShop, stringifyShop } from '../src/workspaces/gameplay/shop'
import { newFileTypesByGroup } from '../src/newFileTypes'
import { packageAcceptsImportFile, packageDocumentExt } from '../src/workspaces/gameplay/library'
import { createSourceFile, sourcePathOf, defaultPlaneForFile } from '../src/workspace'
import { sourcesToProgressDocuments, applyProgressDocumentsToWorkspace } from '../src/project/projectSession'
import { shopCompiler } from '../src/export/compile/compilers/shop'
import { readFileSync } from 'node:fs'
import { buildKitModifierEnv } from '../src/workspaces/gameplay/kitExpr'
import { compileShopCondition, evalShopCondition } from '../src/workspaces/gameplay/shopExpr'
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/shop-expr-v1.json', import.meta.url), 'utf8'))
const env = buildKitModifierEnv(fixtures.params, fixtures.modifiers)
for (const c of fixtures.cases) assert.equal(evalShopCondition(c.source, env), c.expected, c.source)
for (const source of fixtures.invalid) assert.throws(() => compileShopCondition(source, env), source)

const doc = createShop()
doc.entries.push({ ...createShopEntry(), payment: [{ item: '货币', id: '', components: {}, count: 2 }], goods: [{ id: 'minecraft:bread', components: {}, count: 3 }] })
assert.deepEqual(parseShop(stringifyShop(doc)), doc)
for (const stockSubject of ['player', 'game', 'actor'])
  assert.equal(parseShop(JSON.stringify({ ...doc, stockSubject })).stockSubject, stockSubject)
for (const stockSubject of ['world', 'server', 'npc'])
  assert.throws(() => parseShop(JSON.stringify({ ...doc, stockSubject })))

assert.equal(doc.icon, null)
const legacy = JSON.parse(stringifyShop(doc)); delete legacy.icon
assert.equal(parseShop(JSON.stringify(legacy)).icon, null)
const icon = { id: 'minecraft:chest', count: 7, components: {} }
assert.equal(parseShop(JSON.stringify({ ...doc, icon })).icon?.count, 1)
assert.equal(parseShop(JSON.stringify({ ...doc, icon: { id: '', count: 1, components: {} } })).icon, null)
assert.equal(parseShop(JSON.stringify({ ...doc, icon: { item: 'badge', count: 1 } })).icon?.item, 'badge')
for (const icon of ['bad', { id: 2 }, { id: 'minecraft:chest', mods: { count: 'price' } }])
  assert.throws(() => parseShop(JSON.stringify({ ...doc, icon })))
doc.tags = ['village']; doc.entries[0].tags = ['apple/sell']; doc.entries[0].initialCapacity = 4; doc.entries[0].maxCapacity = 10
assert.deepEqual(parseShop(stringifyShop(doc)), doc)
assert.throws(() => parseShop(JSON.stringify({ ...doc, entries: [{ ...doc.entries[0], initialCapacity: 11 }] })))
assert.throws(() => parseShop(JSON.stringify({ ...doc, script: [{ ref: 'src/script/shop/trade.py' }] })))
const draft = { ...doc, entries: [{ ...doc.entries[0], payment: [{ id: '', count: 1, components: {} }] }] }
assert.doesNotThrow(() => parseShop(stringifyShop(draft), true))
assert.throws(() => parseShop(stringifyShop(draft)), /item|ItemStack/)
assert.equal(packageDocumentExt('shop'), '.shop')
assert.equal(packageAcceptsImportFile('shop', '交易.shop'), true)
assert.equal(packageAcceptsImportFile('shop', '交易.kit'), false)
assert.ok(newFileTypesByGroup().find(g => g.group.id === 'gameplay')?.items.some(t => t.id === 'shop'))
assert.equal(sourcePathOf({ name: '交易.shop' }), 'src/shop/交易.shop')
assert.equal(defaultPlaneForFile('交易.shop'), 'server')
const file = createSourceFile('交易.shop', stringifyShop(doc))
const documents = sourcesToProgressDocuments([file])
assert.equal(documents[0].package, 'shop')
const changed = { ...doc, stockSubject: 'game' as const }
const result = applyProgressDocumentsToWorkspace({ packages: [{ id: 'p', name: 'test', scripts: [file] }] } as Parameters<typeof applyProgressDocumentsToWorkspace>[0], [{ ...documents[0], source: stringifyShop(changed) }])
assert.ok(JSON.stringify(result).includes('game'))
for (const patch of [{ extends: 'parent' }, { includes: [] }, { entries: [...doc.entries, doc.entries[0]] }, { entries: [{ ...doc.entries[0], payment: [{ count: 1 }] }] }, { stockSubject: 'entity-id' }]) {
  assert.throws(() => parseShop(JSON.stringify({ ...doc, ...patch })))
}
for (const field of ['visibility', 'availability']) {
  const legacy = parseShop(JSON.stringify({ ...doc, [field]: [] }))
  assert.equal(Object.hasOwn(legacy, field), false)
  assert.equal(Object.hasOwn(JSON.parse(stringifyShop(legacy)), field), false)
  assert.throws(() => parseShop(JSON.stringify({ ...doc, [field]: [{ kind: 'expr', state: 'true', target: '0' }] })), /条件组已移除/)
}
doc.entries[0].visibility = 'level > 2'
doc.entries[0].availability = 'price(1) > 0'
const entryRoundTrip = parseShop(stringifyShop(doc))
assert.equal(entryRoundTrip.entries[0].visibility, 'level > 2')
assert.equal(entryRoundTrip.entries[0].availability, 'price(1) > 0')
const reports: unknown[] = []
await shopCompiler.compile(file, { index: { package: { name: 'test', scripts: [file] } }, report: r => reports.push(r) } as Parameters<typeof shopCompiler.compile>[1])
assert.ok(reports.length > 0, 'missing item references must block export')
console.log('shop: template roundtrip, instance boundary, resource pipeline and export validation passed')
