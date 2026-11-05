import assert from 'node:assert/strict'
import { PerspectiveCamera, Vector3 } from 'three'
import { createLevelDocument, stringifyLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import {
  placeOrbitCamera,
  selectionFocusOrbit,
  viewAngles,
  type OrbitState,
} from '../src/workspaces/gameplay/levelVolumeCamera.ts'
import { stableHandleScale } from '../src/workspaces/gameplay/levelVolumeViewport.ts'

const camera = new PerspectiveCamera(40, 1, 0.05, 20000)

function offsetOf(orbit: OrbitState): Vector3 {
  placeOrbitCamera(camera, orbit)
  return camera.position.clone().sub(orbit.target)
}

const doc = createLevelDocument()
doc.regions.push({
  id: 'near',
  areas: [{ kind: 'rect', x: [10, 12], z: [0, 0], y: [64, 64] }],
  custom_data: {},
})
doc.regions.push({
  id: 'far',
  areas: [{ kind: 'rect', x: [400, 420], z: [400, 408], y: [70, 90] }],
  custom_data: {},
})
doc.landmarks.push({ id: 'roof', kind: 'rpgtoolkit:pos', param: { x: 4, y: 172, z: 4 }, custom_data: {} })
const before = stringifyLevelDocument(doc)
const kept = { theta: 1.2, phi: 0.9 }
const selected = selectionFocusOrbit(doc, { kind: 'region', id: 'near', area: 0 }, kept)
assert.equal(stringifyLevelDocument(doc), before, '对准不改文档')
assert.equal(selected.theta, kept.theta)
assert.equal(selected.phi, kept.phi)
assert.ok(Math.abs(selected.target.x - 11.5) < 1e-6, '选中矩形用世界外表面中心，不拉向远处体积')
assert.ok(Math.abs(selected.target.y - 64.5) < 1e-6)
assert.ok(Math.abs(selected.target.z - 0.5) < 1e-6)
assert.ok(selected.radius < 40)

const scene = selectionFocusOrbit(doc, null, kept)
assert.ok(Math.abs(scene.target.x - selected.target.x) > 20, '未选中时对准整场，而不是停在单个体积')

const landmark = selectionFocusOrbit(doc, { kind: 'landmark', id: 'roof' }, kept)
assert.equal(landmark.target.x, 4)
assert.equal(landmark.target.y, 172)
assert.equal(landmark.target.z, 4)
assert.ok(landmark.radius < 40, '地标用原始坐标，零跨度不把相机拉远')

const tall = createLevelDocument()
tall.regions.push({
  id: 'column',
  areas: [{ kind: 'rect', x: [0, 8], z: [0, 8], y: 'all' }],
  custom_data: {},
})
tall.regions.push({
  id: 'tower',
  areas: [{ kind: 'rect', x: [500, 504], z: [0, 2], y: [0, 300] }],
  custom_data: {},
})
const allFocus = selectionFocusOrbit(tall, { kind: 'region', id: 'column', area: 0 }, kept)
assert.ok(allFocus.radius < 80, '全高度对准用编辑带，不用 -64..320 显示柱')
assert.ok(Math.abs(allFocus.target.y - 150.5) < 1, '编辑带跟有限体积的中位高度')
const tower = selectionFocusOrbit(tall, { kind: 'region', id: 'tower', area: 0 }, kept)
assert.ok(Math.abs(tower.target.x - 502.5) < 1e-6)
assert.ok(tower.radius > allFocus.radius)

function framed(kind: 'perspective' | 'top' | 'front' | 'side', theta = 0.4): OrbitState {
  const angles = viewAngles(kind, theta)
  return { target: new Vector3(20, 64, -12), radius: 48, theta: angles.theta, phi: angles.phi }
}

const top = framed('top', 0.4)
const topOffset = offsetOf(top)
assert.ok(topOffset.y > top.radius * 0.9, '顶视从上方看')
const topNudged = offsetOf({ ...top, theta: top.theta + 0.5 })
assert.ok(topOffset.distanceTo(topNudged) > top.radius * 0.05, '顶视离开垂直奇点，转角仍能带动相机')

const front = offsetOf(framed('front'))
assert.ok(front.z > Math.abs(front.x) * 3 && front.y > 0, '前视主要从 +Z 看向目标，并留出俯仰')
const side = offsetOf(framed('side'))
assert.ok(side.x > Math.abs(side.z) * 3 && side.y > 0, '侧视主要从 +X 看向目标')
const perspective = offsetOf(framed('perspective'))
assert.ok(Math.abs(perspective.x) > 48 * 0.2 && Math.abs(perspective.z) > 48 * 0.2 && perspective.y > 0)

const nearScale = stableHandleScale(10, 480, 40, 0.7, 12)
const farScale = stableHandleScale(20, 480, 40, 0.7, 12)
assert.ok(Math.abs(farScale / nearScale - 2) < 1e-6, '距离加倍时手柄世界缩放加倍，屏幕尺寸才稳定')
assert.ok(stableHandleScale(10, 960, 40, 0.7, 12) < nearScale)

console.log('PASS level viewport: selected focus bounds, view directions, stable handle scale')
