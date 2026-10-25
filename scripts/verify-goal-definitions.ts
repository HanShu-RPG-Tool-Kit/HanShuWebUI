import assert from 'node:assert/strict'
import {
  BUILTIN_GOAL_DEFINITION_SCRIPTS,
  buildGoalDefinitionCatalog,
  isBuiltinScriptDocumentKey,
  parseGoalDefinitionsFromSource,
  withBuiltinScripts,
} from '../src/workspaces/quest/goalDefinitions.ts'
import { ensurePackageSections, sectionFolderKey } from '../src/workspaces/quest/library.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('parses kill_mc_type config and file header', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('kill_mc_type'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'x', sourceName: 'core_kill_mc_type.py' })
  assert.equal(defs.length, 1)
  assert.equal(defs[0]!.kind, 'core:kill_mc_type')
  assert.deepEqual(defs[0]!.fields.map((field) => field.key), ['count', 'target'])
  assert.equal(defs[0]!.fields[0]!.type, 'int')
  assert.equal(defs[0]!.fields[0]!.default, 1)
  assert.equal(defs[0]!.labels?.zh_cn?.name, '击杀实体类型')
  assert.equal(defs[0]!.fields.find((field) => field.key === 'target')?.widget?.editor, 'suggest')
  assert.ok(defs[0]!.localize?.zh_cn?.includes('{target}'))
})

test('empty @config() does not swallow @state bag fields', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('instant_complete'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'y', sourceName: 'core_instant_complete.py' })
  assert.equal(defs[0]!.kind, 'core:instant_complete')
  assert.deepEqual(defs[0]!.fields, [])
  assert.ok(source.includes('field("done"'), 'fixture still has bag field done')
})

test('parses manual_complete required string', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('manual_complete'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'z', sourceName: 'core_manual_complete.py' })
  assert.equal(defs[0]!.kind, 'core:manual_complete')
  const token = defs[0]!.fields.find((field) => field.key === 'token')
  assert.equal(token?.type, 'string')
  assert.equal(token?.required, true)
})

test('double config type aliases to float', () => {
  const defs = parseGoalDefinitionsFromSource(
    '@goal("test:double")\n@config(field("rate", "double", default=1.5))\nclass D(BaseGoalPy):\n    pass\n',
    { sourceKey: 'd', sourceName: 'd.py' },
  )
  assert.equal(defs[0]!.fields[0]!.type, 'float')
  assert.equal(defs[0]!.fields[0]!.default, 1.5)
})

test('empty workspace still exposes virtual builtin goal definitions', () => {
  const state = ensurePackageSections({ documents: [], folders: [], activeKey: null })
  const catalog = buildGoalDefinitionCatalog(state)
  assert.ok(catalog.definitions.some((item) => item.kind === 'core:kill_mc_type'))
  assert.ok(catalog.definitions.some((item) => item.kind === 'core:dialog'))
  assert.ok(catalog.definitions.every((item) => item.sourceKey && isBuiltinScriptDocumentKey(item.sourceKey)))
  const view = withBuiltinScripts(state)
  assert.equal(view.folders.some((folder) => folder.name === '内置'), true)
  assert.ok(view.documents.filter((doc) => isBuiltinScriptDocumentKey(doc.key)).length >= 20)
  assert.equal(state.documents.length, 0, 'builtins must not mutate the base state')
})

test('project scripts override builtin kinds; custom kinds append', () => {
  const state = ensurePackageSections({ documents: [], folders: [], activeKey: null })
  const source = '@goal("core:kill_mc_type")\n@config(field("note", "string", default="x"))\nclass OverrideManual(BaseGoalPy):\n    pass\n@goal("custom:only")\n@config(field("value", "int", default=7))\nclass OnlyGoal(BaseGoalPy):\n    pass'
  state.documents.push({ key: 'script', name: 'only.py', source, package: 'script', folderId: sectionFolderKey('script', 'goal-def') })
  state.documents.push({ key: 'ordinary', name: 'not_definition.py', source: source.replace('custom:only', 'custom:outside'), package: 'script', folderId: null })
  const catalog = buildGoalDefinitionCatalog(state)
  assert.ok(catalog.definitions.some((item) => item.kind === 'custom:only'))
  assert.ok(!catalog.definitions.some((item) => item.kind === 'custom:outside'))
  const kill = catalog.byKind.get('core:kill_mc_type')!
  assert.equal(kill.sourceKey, 'script')
  assert.equal(kill.fields[0]!.key, 'note')
  assert.equal(catalog.byKind.get('custom:only')!.fields[0]!.default, 7)
})

test('multiple goals cannot borrow the next class config', () => {
  const defs = parseGoalDefinitionsFromSource(`@goal("test:first")
@config()
class FirstGoal(BaseGoalPy):
    pass
@goal("test:second")
@config(
    field("count", "int", default=3),
)
class SecondGoal(BaseGoalPy):
    pass`, { sourceKey: 'two', sourceName: 'two.py' })
  assert.deepEqual(defs[0]!.fields, [])
  assert.equal(defs[1]!.fields[0]!.default, 3)
})

console.log(`\n${passed} goal-definition checks passed.`)
