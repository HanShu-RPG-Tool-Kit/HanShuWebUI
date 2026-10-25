import assert from 'node:assert/strict'
import {
  defaultEditorForFieldType,
  parseGoalHeaderMeta,
  pickGoalLocaleName,
  renderGoalLocalizeTemplate,
  resolveGoalWidget,
} from '../src/workspaces/gameplay/goalWidgets/index.ts'
import type { GoalConfigField } from '../src/workspaces/gameplay/goalDefinitions.ts'

let passed = 0
function test(name: string, check: () => void) {
  check()
  passed += 1
  console.log(`[OK] ${name}`)
}

test('header parser skips comments and reads widget options', () => {
  const meta = parseGoalHeaderMeta(`
# note
'''
{
  "id": "demo:x",
  "labels": { "zh_cn": { "name": "示例" } },
  "params": {
    "mode": {
      "widget": {
        "editor": "select",
        "options": [
          { "value": "a", "labels": { "zh_cn": { "name": "甲" } } },
          { "value": "b", "labels": { "en_us": { "name": "Bee" } } }
        ]
      }
    }
  },
  "localize": { "zh_cn": "模式 {mode}" }
}
'''
@goal("demo:x")
`)
  assert.equal(meta?.id, 'demo:x')
  assert.equal(meta?.labels?.zh_cn?.name, '示例')
  const options = meta?.params?.mode?.widget?.options as {
    value: string
    labels?: Record<string, { name?: string }>
  }[]
  assert.equal(options?.[0]?.value, 'a')
  assert.equal(pickGoalLocaleName(options?.[0]?.labels, 'zh_cn', 'a'), '甲')
})

test('resolve falls back: unknown editor, suggest without RPC, broken slider', () => {
  const base: GoalConfigField = { key: 'x', type: 'string', required: false, label: 'x' }
  assert.equal(resolveGoalWidget(base).editorId, 'text')
  assert.equal(resolveGoalWidget({ ...base, widget: { editor: 'nope' } }).editorId, 'text')
  assert.equal(
    resolveGoalWidget({ ...base, widget: { editor: 'suggest', type: 'entity_mc_type' } }).editorId,
    'text',
  )
  assert.equal(
    resolveGoalWidget({
      key: 'n',
      type: 'int',
      required: false,
      widget: { editor: 'slider' },
    }).editorId,
    'number',
  )
  assert.equal(
    resolveGoalWidget({
      key: 'n',
      type: 'int',
      required: false,
      widget: { editor: 'slider', min: 1, max: 8 },
    }).editorId,
    'slider',
  )
  assert.equal(defaultEditorForFieldType('bool'), 'bool')
  assert.equal(defaultEditorForFieldType('float'), 'number')
})

test('localize template substitutes config keys', () => {
  assert.equal(
    renderGoalLocalizeTemplate('击杀 {target}（{have}/{count}）', {
      target: 'minecraft:zombie',
      count: 3,
    }),
    '击杀 minecraft:zombie（…/3）',
  )
})

console.log(`\n${passed} goal-widget checks passed.`)
