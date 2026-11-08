import assert from 'node:assert/strict'
import {
  createNavigationPoint,
  fromEngineObject,
  parseNavigationPoint,
  stringifyNavigationPoint,
  summarizeNavigationPoint,
  toEngineObject,
  validateNavigationPoint,
} from '../src/workspaces/gameplay/navigationPoint.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('tracker stores id, level and landmark ref only', () => {
  const point = createNavigationPoint('hub', 'camp')
  point.track.ref = 'hub$old_tower'
  const raw = toEngineObject(point)
  assert.deepEqual(Object.keys(raw).sort(), ['id', 'level', 'track'])
  assert.equal(raw.level, 'hub')
  assert.deepEqual(raw.track, { type: 'landmark', ref: 'hub$old_tower' })
  assert.equal('param' in raw, false)
  assert.equal('type' in raw, false)
  assert.equal('custom_data' in raw, false)
})

test('round-trip keeps the track and drops nothing', () => {
  const point = createNavigationPoint('hub', 'camp')
  point.track.ref = 'hub$old_tower'
  const again = parseNavigationPoint(stringifyNavigationPoint(point))
  assert.deepEqual(again, point)
})

test('legacy fields and embedded coordinates are rejected', () => {
  assert.throws(() => fromEngineObject({ type: 'position', dimension: 'minecraft:overworld', x: 1, y: 2, z: 3 }), /旧版 \.nav/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'position', label: '旧塔' }), /旧版 \.nav/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 } }), /不能保存坐标/)
  assert.throws(() => fromEngineObject({ id: 'camp', level: 'hub', x: 1, y: 2, z: 3, track: { type: 'landmark', ref: 'hub$old_tower' } }), /不能保存坐标/)
})

test('track must name a landmark and cannot carry unknown keys', () => {
  assert.throws(() => fromEngineObject({ level: 'hub', track: { type: 'position', ref: 'hub$old_tower' } }), /track\.type/)
  assert.throws(() => fromEngineObject({ level: 'hub', track: { type: 'landmark', ref: 'hub$old_tower' }, extra: 1 }), /未知导航器字段/)
  assert.throws(() => fromEngineObject({ level: 'hub', track: { type: 'landmark', ref: 'hub$old_tower', x: 1 } }), /未知 track 字段/)
})

test('validate requires a template and a <template>$<landmark> ref', () => {
  const point = createNavigationPoint('')
  const missing = validateNavigationPoint(point)
  assert.ok(missing.some((item) => item.includes('地图模板')))
  assert.ok(missing.some((item) => item.includes('地标')))
  point.level = 'hub'
  point.track.ref = 'other$old_tower'
  assert.ok(validateNavigationPoint(point).some((item) => item.includes('hub')))
  point.track.ref = 'hub$old_tower'
  assert.deepEqual(validateNavigationPoint(point), [])
  point.level = 'demo:hub'
  assert.ok(validateNavigationPoint(point).some((item) => item.includes('模板 ID')), '模板 ID 取文件名，不能含冒号')
})

test('summary names the template and the ref', () => {
  const point = createNavigationPoint('hub', 'camp')
  point.track.ref = 'hub$old_tower'
  assert.deepEqual(summarizeNavigationPoint(point), ['hub', 'hub$old_tower'])
})

console.log(`\n${passed} navigation-point checks passed.`)
