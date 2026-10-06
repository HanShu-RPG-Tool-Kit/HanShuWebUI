import assert from 'node:assert/strict'
import {
  createNavigationPoint,
  fromEngineObject,
  parseNavigationPoint,
  stringifyNavigationPoint,
  toEngineObject,
  validateNavigationPoint,
} from '../src/workspaces/progress/navigationPoint.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('default position omits type and writes coords', () => {
  const point = createNavigationPoint('旧塔')
  point.x = 40; point.y = 72; point.z = 40; point.radius = 8; point.public = true
  const raw = toEngineObject(point)
  assert.equal(raw.type, undefined)
  assert.equal(raw.label, '旧塔')
  assert.equal(raw.dimension, 'minecraft:overworld')
  assert.equal(raw.x, 40)
  assert.equal(raw.public, true)
  assert.equal(raw.radius, 8)
})

test('round-trip position JSON', () => {
  const source = stringifyNavigationPoint(createNavigationPoint('塔'))
  const again = parseNavigationPoint(source)
  assert.equal(again.type, 'position')
  assert.equal(again.label, '塔')
  assert.equal(again.y, 64)
})

test('entity tag XOR uuid', () => {
  const tag = fromEngineObject({
    type: 'entity',
    entity_tag: 'quest_source:quartermaster',
    label: '驿站补给员',
  })
  assert.equal(tag.entityMode, 'tag')
  assert.equal(tag.entityTag, 'quest_source:quartermaster')
  assert.equal(tag.scanRadius, 64)
  assert.deepEqual(Object.keys(toEngineObject(tag)).sort(), ['entity_tag', 'label', 'type'].sort())

  assert.throws(() => fromEngineObject({ type: 'entity', entity_tag: 'a', entity_uuid: '00000000-0000-0000-0000-000000000001' }))
  assert.throws(() => fromEngineObject({ type: 'position', x: 1, y: 2, z: 3, entity_tag: 'x' }))
  assert.throws(() => fromEngineObject({ type: 'entity', entity_tag: 'a', x: 1 }))
  assert.throws(() => fromEngineObject({ type: 'entity', entity_uuid: '00000000-0000-0000-0000-000000000001', scan_radius: 32 }))
})

test('entity tag scan_radius defaults to 64 and omits when default', () => {
  const point = createNavigationPoint('补给员')
  point.type = 'entity'
  point.entityMode = 'tag'
  point.entityTag = 'quest_source:quartermaster'
  assert.equal(point.scanRadius, 64)
  assert.equal(toEngineObject(point).scan_radius, undefined)

  point.scanRadius = 120
  const raw = toEngineObject(point)
  assert.equal(raw.scan_radius, 120)
  const again = fromEngineObject(raw)
  assert.equal(again.scanRadius, 120)
  assert.equal(again.entityMode, 'tag')
})

test('incomplete entity draft round-trips without parse error', () => {
  const draft = createNavigationPoint('新导航点')
  draft.type = 'entity'
  draft.entityMode = 'tag'
  draft.entityTag = ''
  const source = stringifyNavigationPoint(draft)
  const again = parseNavigationPoint(source)
  assert.equal(again.type, 'entity')
  assert.equal(again.entityMode, 'tag')
  assert.equal(again.entityTag, '')
  assert.ok(validateNavigationPoint(again).some((item) => item.includes('entity_tag')))
})

test('empty uuid mode survives round-trip', () => {
  const draft = createNavigationPoint('新导航点')
  draft.type = 'entity'
  draft.entityMode = 'uuid'
  draft.entityUuid = ''
  const again = parseNavigationPoint(stringifyNavigationPoint(draft))
  assert.equal(again.entityMode, 'uuid')
  assert.equal(again.entityUuid, '')
  assert.ok(validateNavigationPoint(again).some((item) => item.includes('entity_uuid')))
})

test('validate catches bad uuid and missing dimension', () => {
  const point = createNavigationPoint()
  point.type = 'entity'
  point.entityMode = 'uuid'
  point.entityUuid = 'not-a-uuid'
  point.dimension = ''
  const issues = validateNavigationPoint(point)
  assert.ok(issues.some((item) => item.includes('UUID')))

  const pos = createNavigationPoint()
  pos.dimension = ''
  assert.ok(validateNavigationPoint(pos).some((item) => item.includes('dimension')))
})

console.log(`\n${passed} navigation-point checks passed.`)
