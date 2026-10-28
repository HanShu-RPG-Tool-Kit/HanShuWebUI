import assert from 'node:assert/strict'
import {
  createNavigationPoint,
  fromEngineObject,
  NAV_DISPLAY_ICON,
  NAV_DISPLAY_MAX_DISTANCE,
  NAV_DISPLAY_MIN_DISTANCE,
  NAV_DISPLAY_NAME,
  NAV_TYPE_POS,
  parseNavigationPoint,
  stringifyNavigationPoint,
  toEngineObject,
  validateNavigationPoint,
} from '../src/workspaces/gameplay/navigationPoint.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('default v3 point has level/type/param/custom_data only', () => {
  const point = createNavigationPoint('hub')
  point.param = { x: 40, y: 72, z: 40 }
  const raw = toEngineObject(point)
  assert.deepEqual(Object.keys(raw).sort(), ['custom_data', 'level', 'param', 'type'].sort())
  assert.equal(raw.level, 'hub')
  assert.equal(raw.type, NAV_TYPE_POS)
  assert.deepEqual(raw.param, { x: 40, y: 72, z: 40 })
  assert.equal((raw.custom_data as Record<string, unknown>)[NAV_DISPLAY_NAME], 'display_name')
  assert.equal('dimension' in raw, false)
  assert.equal('x' in raw, false)
})

test('round-trip v3 JSON', () => {
  const point = createNavigationPoint('hub')
  point.custom_data[NAV_DISPLAY_ICON] = 'minecraft:compass'
  point.custom_data[NAV_DISPLAY_MAX_DISTANCE] = 256
  point.custom_data[NAV_DISPLAY_MIN_DISTANCE] = 8
  const again = parseNavigationPoint(stringifyNavigationPoint(point))
  assert.equal(again.level, 'hub')
  assert.equal(again.type, NAV_TYPE_POS)
  assert.equal(again.custom_data[NAV_DISPLAY_ICON], 'minecraft:compass')
  assert.equal(again.custom_data[NAV_DISPLAY_MAX_DISTANCE], 256)
  assert.equal(again.custom_data[NAV_DISPLAY_MIN_DISTANCE], 8)
})

test('legacy .nav is rejected explicitly instead of silently dropping fields', () => {
  assert.throws(() => fromEngineObject({ type: 'position', dimension: 'minecraft:overworld', x: 1, y: 2, z: 3 }), /旧版 \.nav/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'position', x: 1, y: 2, z: 3 }), /旧版 \.nav/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'position', label: '旧塔' }), /旧版 \.nav/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'position', public: true }), /旧版 \.nav/)
})

test('only rpgtoolkit:pos is accepted this round', () => {
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:entity_tag', param: { tag: 'x' } }), /未知导航点类型/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 1, y: 2 } }), /param\.z/)
})

test('unknown fields and bad custom_data are rejected', () => {
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 }, extra: 1 }), /未知导航点字段/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 }, custom_data: { [NAV_DISPLAY_NAME]: 3 } }), /display_name/)
  assert.throws(() => fromEngineObject({ level: 'hub', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 }, custom_data: { [NAV_DISPLAY_MAX_DISTANCE]: -1 } }), /display_max_distance/)
})

test('validate warns on missing level and bad coordinates', () => {
  const point = createNavigationPoint('')
  assert.ok(validateNavigationPoint(point).some((item) => item.includes('地图模板')))
  point.level = 'hub'
  point.param.x = 40_000_000
  assert.ok(validateNavigationPoint(point).some((item) => item.includes('x')))
})

test('display_icon and distance ranges are validated', () => {
  const point = createNavigationPoint('hub')
  point.custom_data[NAV_DISPLAY_ICON] = 'not a resource id'
  point.custom_data[NAV_DISPLAY_MIN_DISTANCE] = 20
  point.custom_data[NAV_DISPLAY_MAX_DISTANCE] = 10
  const issues = validateNavigationPoint(point)
  assert.ok(issues.some((item) => item.includes('display_icon')))
  assert.ok(issues.some((item) => item.includes('display_min_distance')))
})

console.log(`\n${passed} navigation-point checks passed.`)
