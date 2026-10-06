import assert from 'node:assert/strict'
import { BUILTIN_GOAL_DEFINITION_SCRIPTS, parseGoalDefinitionsFromSource } from '../src/workspaces/progress/goalDefinitions.ts'

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

console.log(`\n${passed} goal-definition checks passed.`)
