import assert from 'node:assert/strict'
import { createItem, stringifyItem } from '../src/workspaces/progress/itemDoc'
import { createEntity, stringifyEntity } from '../src/workspaces/progress/entityDoc'
import { displayTextBindings, displayTextReferences, displayTextRuntimeKey, displayTextSemanticKey, displayTextRuntimeTranslations, getDisplayText, replaceDisplayText } from '../src/workspaces/progress/displayTextLocale'
import { writeDisplayText } from '../src/workspaces/progress/displayTextNbt'
import { textAssetPath } from '../src/i18n/localeLayout'
import { ensureBuiltinCompilers } from '../src/export/compile/compilers/registerBuiltin'
import { listLocaleExportRules } from '../src/export/compile/registry'
import { itemCompiler } from '../src/export/compile/compilers/item'
import { entityCompiler } from '../src/export/compile/compilers/entity'
import type { CompileContext } from '../src/export/compile/types'
import { createProject } from '../src/workspace'
import { linkArtifacts } from '../src/export/compile/link'

const nameKey = displayTextRuntimeKey('item', 'display.custom_name', 'opaque-identity')
assert.equal(displayTextSemanticKey(nameKey, 'item'), 'display.custom_name')
assert.equal(displayTextSemanticKey(nameKey, 'entity'), null)
assert.equal(displayTextSemanticKey('minecraft.item.stick'), null)
assert.throws(() => displayTextRuntimeKey('item', '../bad'))
let item = replaceDisplayText('item', createItem(), 'item.custom_name', { translate: nameKey, italic: false, extra: [{ text: '!', color: 'gold' }] })
assert.equal(displayTextBindings('item', item)[0].runtimeKey, nameKey)
assert.deepEqual(getDisplayText('item', item, 'item.custom_name'), { translate: nameKey, italic: false, extra: [{ text: '!', color: 'gold' }] })
const first = displayTextRuntimeKey('item', 'display.lore.line-a', 'opaque-identity')
const second = displayTextRuntimeKey('item', 'display.lore.line-b', 'opaque-identity')
item = { ...item, item: { ...item.item, components: { ...item.item.components, 'minecraft:lore': { type: 'list', value: [writeDisplayText({ translate: first }), writeDisplayText({ translate: second })] } } } }
const before = displayTextBindings('item', item)
const lore = item.item.components['minecraft:lore']
assert.equal(lore.type, 'list')
if (lore.type === 'list') lore.value.reverse()
const after = displayTextBindings('item', item)
assert.equal(after.find(binding => binding.field === 'item.lore.0')?.semanticKey, 'display.lore.line-b')
assert.deepEqual(displayTextRuntimeTranslations(before, { 'display.custom_name': '名称', 'display.lore.line-a': '第一行', 'display.lore.line-b': '第二行', unused: '裁剪' }), displayTextRuntimeTranslations(after, { 'display.custom_name': '名称', 'display.lore.line-a': '第一行', 'display.lore.line-b': '第二行' }))
assert.equal(textAssetPath('zh_cn', 'weapons/sword.item'), 'assets/zh_cn/lang_item/weapons/sword.lang')
assert.equal(textAssetPath('en_us', 'guard.entity'), 'assets/en_us/lang_entity/guard.lang')
const entityKey = displayTextRuntimeKey('entity', 'display.custom_name', 'entity-identity')
const entity = replaceDisplayText('entity', createEntity(), 'entity.custom_name', { translate: entityKey })
assert.equal(displayTextBindings('entity', entity)[0].semanticKey, 'display.custom_name')
const advanced = replaceDisplayText('entity', entity, 'entity.custom_name', { text: 'Prefix ', extra: [{ translate: entityKey }] })
assert.equal(displayTextBindings('entity', advanced).length, 0)
assert.equal(displayTextReferences('entity', advanced)[0].runtimeKey, entityKey)
assert.deepEqual(displayTextRuntimeTranslations(displayTextReferences('entity', advanced), { 'display.custom_name': '名称' }), { [entityKey]: '名称' })

ensureBuiltinCompilers()
const pkg = createProject('display-text-locale')
const context: CompileContext = { index: { workspace: { packages: [pkg], activeScriptId: null, activeAssetId: null }, package: pkg, scriptsByName: new Map(), assetsByPath: new Map() }, report: diagnostic => { throw Error(diagnostic.message) } }
for (const [kind, name, content, compiler, key] of [
  ['item', 'sword.item', stringifyItem(item), itemCompiler, nameKey],
  ['entity', 'guard.entity', stringifyEntity(entity), entityCompiler, entityKey],
] as const) {
  const source = { id: kind, name, content, updatedAt: 0 }
  const artifacts = await compiler.compile(source, context)
  assert.ok(artifacts[0].requires?.some(ref => ref.id === 'display.custom_name'))
  assert.ok(artifacts[0].provides?.some(ref => ref.id === key))
  assert.ok(linkArtifacts([artifacts[0], { ...artifacts[0], path: `copy/${artifacts[0].path}` }]).some(diagnostic => diagnostic.code === 'duplicate_provide'))
  const owner = { source, artifacts, index: context.index }
  const rule = listLocaleExportRules().find(rule => rule.sourceExt === kind)!
  assert.equal(rule.text?.plane, 'shared')
  assert.equal(rule.text?.keys, 'referenced')
  assert.deepEqual(rule.text?.transformText?.({ 'display.custom_name': '名称', unused: '裁剪' }, owner), { [key]: '名称' })
}
console.log('通过：物品/实体稳定引用、lore 重排、TNBT 往返、语言归属路径与语义键编译。')
