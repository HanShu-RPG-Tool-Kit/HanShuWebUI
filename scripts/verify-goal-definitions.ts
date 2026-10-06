import assert from 'node:assert/strict'
import {
  BUILTIN_GOAL_DEFINITION_SCRIPTS,
  buildGoalDefinitionCatalog,
  isBuiltinGoalDocumentKey,
  parseGoalDefinitionsFromSource,
  withBuiltinGoalDefinitions,
} from '../src/workspaces/progress/goalDefinitions.ts'
import { ensurePackageSections, sectionFolderKey } from '../src/workspaces/progress/library.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('parses dialogue_choice config fields from builtin script', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('dialogue'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'x', sourceName: 'core_dialogue_choice.py' })
  assert.equal(defs.length, 1)
  assert.equal(defs[0]!.kind, 'core:dialogue_choice')
  assert.deepEqual(defs[0]!.fields.map((field) => field.key), ['choice', 'node'])
  assert.equal(defs[0]!.fields[0]!.required, true)
  assert.equal(defs[0]!.fields[0]!.type, 'string')
  assert.equal(defs[0]!.fields[1]!.default, '')
  assert.equal(defs[0]!.fields[1]!.hint, 'dialogue_node')
})

test('parses empty @config() for manual goal', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('manual'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'y', sourceName: 'core_manual.py' })
  assert.equal(defs[0]!.kind, 'core:manual')
  assert.deepEqual(defs[0]!.fields, [])
})

test('parses counter defaults', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('counter'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'z', sourceName: 'core_counter.py' })
  assert.equal(defs[0]!.kind, 'core:counter')
  const target = defs[0]!.fields.find((field) => field.key === 'target')
  assert.equal(target?.type, 'int')
  assert.equal(target?.default, 1)
})

test('empty workspace still exposes virtual builtin goal definitions', () => {
  const state = ensurePackageSections({ documents: [], folders: [], activeKey: null })
  const catalog = buildGoalDefinitionCatalog(state)
  assert.deepEqual(catalog.definitions.map((item) => item.kind).sort(), [
    'core:counter',
    'core:dialogue_choice',
    'core:manual',
  ])
  assert.ok(catalog.definitions.every((item) => item.sourceKey && isBuiltinGoalDocumentKey(item.sourceKey)))
  const view = withBuiltinGoalDefinitions(state)
  assert.equal(view.folders.some((folder) => folder.name === '内置'), true)
  assert.equal(view.documents.filter((doc) => isBuiltinGoalDocumentKey(doc.key)).length, 3)
  assert.equal(state.documents.length, 0, 'builtins must not mutate the base state')
})

test('project scripts override builtin kinds; custom kinds append', () => {
  const state = ensurePackageSections({ documents: [], folders: [], activeKey: null })
  const source = '@goal("core:manual")\n@config(field("note", "string", default="x"))\nclass OverrideManual(BaseGoalPy):\n    pass\n@goal("custom:only")\n@config(field("value", "int", default=7))\nclass OnlyGoal(BaseGoalPy):\n    pass'
  state.documents.push({ key: 'script', name: 'only.py', source, package: 'script', folderId: sectionFolderKey('script', 'goal-def') })
  state.documents.push({ key: 'ordinary', name: 'not_definition.py', source: source.replace('custom:only', 'custom:outside'), package: 'script', folderId: null })
  const catalog = buildGoalDefinitionCatalog(state)
  assert.ok(catalog.definitions.some((item) => item.kind === 'custom:only'))
  assert.ok(!catalog.definitions.some((item) => item.kind === 'custom:outside'))
  const manual = catalog.byKind.get('core:manual')!
  assert.equal(manual.sourceKey, 'script')
  assert.equal(manual.fields[0]!.key, 'note')
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
