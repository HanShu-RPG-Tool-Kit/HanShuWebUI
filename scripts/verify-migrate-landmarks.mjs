import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrateLandmarks } from './migrate-landmarks.mjs'

async function project(name) {
  return mkdtemp(path.join(tmpdir(), `landmarks-${name}-`))
}

async function put(root, rel, value) {
  const file = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function json(root, rel) {
  return JSON.parse(await readFile(path.join(root, ...rel.split('/')), 'utf8'))
}

async function missing(root, rel) {
  return !(await stat(path.join(root, ...rel.split('/'))).catch(() => null))
}

const conflict = await project('both')
await put(conflict, 'src/level/hub.level', {
  tags: [],
  regions: [],
  navigation: [{ id: 'old', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 } }],
  landmarks: [],
  custom_data: {},
})
await put(conflict, 'src/level/camp.level', {
  navigation: [{ id: 'gate', type: 'position', x: 4, y: 5, z: 6 }],
})
const blocked = await migrateLandmarks(conflict)
assert.equal(blocked.ok, false)
assert.equal(blocked.reportPath, null)
assert.ok(blocked.lines[0].includes('同时存在'))
assert.ok('navigation' in await json(conflict, 'src/level/camp.level'), '失败前不能改写其它模板')
assert.equal(await missing(conflict, 'migration-report.md'), true)

const root = await project('ok')
await put(root, 'src/level/hub.level', {
  tags: ['demo:hub'],
  regions: [],
  navigation: [
    { id: 'old_tower', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 }, custom_data: { 'rpgtoolkit:display_name': 'old_tower.display_name' } },
    { id: 'mob', type: 'rpgtoolkit:entity_tag', param: { tag: 'quest' } },
    { id: 'loose', type: 'position', x: 8, y: 9, z: 10 },
  ],
  custom_data: {},
})
await put(root, 'export/navigation_points/hub$quartermaster.json', {
  level: 'hub',
  type: 'rpgtoolkit:pos',
  param: { x: 3, y: 4, z: 5 },
})
await put(root, 'export/navigation_points/hub$kept.json', { level: 'hub', type: 'rpgtoolkit:entity', param: { id: 'pig' } })
await put(root, 'export/landmarks/hub$already.json', { level: 'hub', kind: 'rpgtoolkit:pos', param: { x: 0, y: 0, z: 0 } })
await put(root, 'export/navigation_points/hub$already.json', { level: 'hub', type: 'rpgtoolkit:pos', param: { x: 9, y: 9, z: 9 } })
await put(root, 'src/navigator/old_tower.nav', {
  level: 'hub',
  type: 'rpgtoolkit:pos',
  param: { x: 20, y: 64, z: 21 },
  custom_data: { 'rpgtoolkit:display_icon': 'minecraft:compass' },
})
await put(root, 'src/navigator/missing.nav', { level: 'nowhere', type: 'rpgtoolkit:pos', param: { x: 1, y: 2, z: 3 } })

const done = await migrateLandmarks(root)
assert.equal(done.ok, true)
const level = await json(root, 'src/level/hub.level')
assert.equal('navigation' in level, false)
assert.deepEqual(level.landmarks.map((point) => point.id), ['old_tower', 'loose'])
assert.equal(level.landmarks[0].kind, 'rpgtoolkit:pos')
assert.deepEqual(level.landmarks[0].param, { x: 1, y: 2, z: 3 })
assert.equal(level.landmarks[0].custom_data['rpgtoolkit:display_name'], 'old_tower.display_name')
assert.equal(level.tags[0], 'demo:hub')

const moved = await json(root, 'export/landmarks/hub$quartermaster.json')
assert.equal(moved.kind, 'rpgtoolkit:pos')
assert.equal('type' in moved, false)
assert.equal(await missing(root, 'export/navigation_points/hub$quartermaster.json'), true)
assert.ok(await json(root, 'export/navigation_points/hub$kept.json'), '无法映射的导出文件留在原地')
assert.deepEqual((await json(root, 'export/landmarks/hub$already.json')).param, { x: 0, y: 0, z: 0 })
assert.ok(await json(root, 'export/navigation_points/hub$already.json'), '目标已存在时不覆盖')

const nav = await json(root, 'src/navigator/old_tower.nav')
assert.deepEqual(nav, { id: 'old_tower', level: 'hub', track: { type: 'landmark', ref: 'hub$old_tower' } })
const afterNav = await json(root, 'src/level/hub.level')
const tower = afterNav.landmarks.find((point) => point.id === 'old_tower')
assert.deepEqual(tower.param, { x: 1, y: 2, z: 3 }, '同名地标已存在时不覆盖坐标')
assert.equal(tower.custom_data['rpgtoolkit:display_icon'], undefined)

const fresh = await project('nav')
await put(fresh, 'src/level/hub.level', { tags: [], regions: [], landmarks: [], custom_data: {} })
await put(fresh, 'src/navigator/gate.nav', { level: 'hub', type: 'position', x: 4, y: 70, z: 5 })
const added = await migrateLandmarks(fresh)
assert.equal(added.ok, true)
assert.deepEqual((await json(fresh, 'src/navigator/gate.nav')).track, { type: 'landmark', ref: 'hub$gate' })
assert.deepEqual((await json(fresh, 'src/level/hub.level')).landmarks[0], {
  id: 'gate',
  kind: 'rpgtoolkit:pos',
  param: { x: 4, y: 70, z: 5 },
})

const report = await readFile(done.reportPath, 'utf8')
assert.match(report, /无法映射的 kind：rpgtoolkit:entity_tag/)
assert.match(report, /找不到模板 nowhere/)
assert.match(report, /目标已存在/)
assert.equal(await missing(root, 'src/navigator/missing.nav') , false)
assert.ok('type' in await json(root, 'src/navigator/missing.nav'))

console.log('PASS: migrate landmarks fail-closed, level rewrite, export move, nav track')
