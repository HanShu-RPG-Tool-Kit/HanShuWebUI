import assert from 'node:assert/strict'
import { BUILTIN_GOAL_DEFINITION_SCRIPTS, buildGoalDefinitionCatalog, parseGoalDefinitionsFromSource } from '../src/workspaces/progress/goalDefinitions.ts'
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

test('catalog comes only from goal-definition scripts and follows edits/deletion', () => {
  const state = ensurePackageSections({ documents: [], folders: [], activeKey: null })
  assert.equal(buildGoalDefinitionCatalog(state).definitions.length, 0)
  const source = '@goal("custom:only")\n@config(field("value", "int", default=7))\nclass OnlyGoal(BaseGoalPy):\n    pass'
  state.documents.push({ key: 'script', name: 'only.py', source, package: 'script', folderId: sectionFolderKey('script', 'goal-def') })
  state.documents.push({ key: 'ordinary', name: 'not_definition.py', source: source.replace('custom:only', 'custom:outside'), package: 'script', folderId: null })
  assert.deepEqual(buildGoalDefinitionCatalog(state).definitions.map(item => item.kind), ['custom:only'])
  assert.equal(buildGoalDefinitionCatalog(state).definitions[0]!.fields[0]!.default, 7)
  state.documents[0]!.source = source.replace('custom:only', 'custom:renamed').replace('default=7', 'default=12')
  assert.equal(buildGoalDefinitionCatalog(state).definitions[0]!.kind, 'custom:renamed')
  assert.equal(buildGoalDefinitionCatalog(state).definitions[0]!.fields[0]!.default, 12)
  state.documents.splice(0, 1)
  assert.equal(buildGoalDefinitionCatalog(state).definitions.length, 0)
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
