import assert from 'node:assert/strict'
import { CylinderGeometry, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three'
import { createLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { addArea, rectFromDrag } from '../src/workspaces/gameplay/levelEdit.ts'
import { initialDocumentOrbit, panOffset, placeOrbitCamera } from '../src/workspaces/gameplay/levelVolumeCamera.ts'
import { buildAreaGeometry, buildPolygonVolume } from '../src/workspaces/gameplay/levelVolumeGeometry.ts'
import {
  DISPLAY_Y_MAX,
  DISPLAY_Y_MIN,
  areaDisplaySpan,
  resizeRect,
  translateArea,
  yFromHandle,
} from '../src/workspaces/gameplay/levelVolumeEdit.ts'

const camera = new PerspectiveCamera(40, 1, 0.05, 20000)
const indoor = createLevelDocument()
indoor.regions.push({ id: 'room', areas: [{ kind: 'rect', x: [0, 8], z: [0, 8], y: [60, 68] }], custom_data: {} })
const indoorOrbit = initialDocumentOrbit(indoor)
assert.equal(indoorOrbit.target.y, 64, '室内体积不能因初始相机只看 Y=0 而消失')
placeOrbitCamera(camera, indoorOrbit)
const projectedRoom = new Vector3(4, 64, 4).project(camera)
assert.ok(Math.abs(projectedRoom.x) < 1 && Math.abs(projectedRoom.y) < 1 && projectedRoom.z > -1 && projectedRoom.z < 1)
const onlyLandmark = createLevelDocument()
onlyLandmark.landmarks.push({ id: 'roof', kind: 'rpgtoolkit:pos', param: { x: 4, y: 172, z: 4 }, custom_data: {} })
assert.equal(initialDocumentOrbit(onlyLandmark).target.y, 172)
assert.ok(initialDocumentOrbit({ ...indoor, regions: [{ ...indoor.regions[0]!, areas: [{ ...indoor.regions[0]!.areas[0]!, y: 'all' }] }] }).radius < 100)
const orbit = { target: new Vector3(32, 0, 32), radius: 86, theta: 0.6, phi: 0.72 }
placeOrbitCamera(camera, orbit)
assert.ok(camera.position.y > orbit.target.y, '轨道相机在目标上方')
const toward = orbit.target.clone().sub(camera.position).normalize()
const forward = new Vector3()
camera.getWorldDirection(forward)
assert.ok(forward.dot(toward) > 0.99, '相机前方应对着目标')

const raycaster = new Raycaster()
raycaster.setFromCamera(new Vector2(0, 0), camera)
const hit = new Vector3()
assert.ok(raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), hit), '画面中心应打到 Y=0')
assert.ok(Math.hypot(hit.x - 32, hit.z - 32) < 0.5, `中心射线落在 ${hit.x}, ${hit.z}`)

const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
const movedRight = panOffset(camera, orbit, 480, 30, 0)
assert.ok(movedRight.dot(right) < -0.01, '向右拖应逆着屏幕右方向移动目标')
assert.ok(Math.abs(movedRight.dot(up)) < 1e-5)
const movedDown = panOffset(camera, orbit, 480, 0, 30)
assert.ok(movedDown.dot(up) > 0.01, '向下抓取时相机上移，让画面中的物体跟随鼠标向下')
const beforePan = orbit.target.clone().project(camera)
const grabbedOrbit = { ...orbit, target: orbit.target.clone().add(panOffset(camera, orbit, 480, 30, 30)) }
placeOrbitCamera(camera, grabbedOrbit)
const afterPan = orbit.target.clone().project(camera)
assert.ok(Math.abs((afterPan.x - beforePan.x) * 240 - 30) < .01, '投影中的物体向右跟随30像素')
assert.ok(Math.abs(-(afterPan.y - beforePan.y) * 240 - 30) < .01, '投影中的物体向下跟随30像素')
placeOrbitCamera(camera, orbit)

const allArea = { kind: 'rect' as const, x: [0, 4] as [number, number], z: [1, 5] as [number, number], y: 'all' as const }
const allGeometry = buildAreaGeometry(allArea, 80)
assert.ok(allGeometry)
assert.equal(allArea.y, 'all')
allGeometry.computeBoundingBox()
const allBox = allGeometry.boundingBox
assert.ok(allBox)
assert.ok(Math.abs(allBox.min.y - DISPLAY_Y_MIN) < 1e-4)
assert.ok(Math.abs(allBox.max.y - DISPLAY_Y_MAX) < 1e-4)
assert.ok(Math.abs(allBox.min.x) < 1e-4 && Math.abs(allBox.max.x - 5) < 1e-4)
assert.ok(Math.abs(allBox.min.z - 1) < 1e-4 && Math.abs(allBox.max.z - 6) < 1e-4)
assert.deepEqual(areaDisplaySpan('all'), [DISPLAY_Y_MIN, DISPLAY_Y_MAX])

const doc = addArea(createLevelDocument(), null, rectFromDrag(0, 1, 4, 5))
assert.equal(doc.regions[0]?.areas[0]?.y, 'all')
const source = doc.regions[0]?.areas[0]
assert.ok(source)
const moved = translateArea(source, 2, 3)
assert.equal(moved.y, 'all')
assert.equal(moved.kind, 'rect')
if (moved.kind === 'rect') {
  assert.deepEqual(moved.x, [2, 6])
  assert.deepEqual(moved.z, [4, 8])
}

for (const sample of [-64, 0, 64, 256, 320, 400]) {
  assert.notDeepEqual(yFromHandle('all', 'min', sample), [-64, 320])
  assert.notDeepEqual(yFromHandle('all', 'max', sample), [-64, 320])
}
assert.deepEqual(yFromHandle('all', 'max', 100), [0, 100])
assert.deepEqual(yFromHandle('all', 'min', 40), [40, 256])
assert.deepEqual(yFromHandle('all', 'max', -64), [0, 1])
assert.deepEqual(yFromHandle('all', 'min', 320), [255, 256])
assert.deepEqual(yFromHandle([10, 40], 'max', 80), [10, 79])
assert.deepEqual(yFromHandle([62.25, 62.25], 'max', 63.25), [62.25, 62.25])
assert.deepEqual(yFromHandle([62.25, 62.25], 'max', 64.25), [62.25, 63.25])

const resized = resizeRect(
  { kind: 'rect', x: [0, 4], z: [0, 4], y: 'all' },
  'maxXmaxZ',
  9.2,
  1.2,
)
assert.equal(resized.y, 'all')
assert.deepEqual(resized.x, [0, 8])
assert.deepEqual(resized.z, [0, 0])
const fractional = resizeRect(
  { kind: 'rect', x: [64.25, 70.25], z: [1.5, 4.5], y: [62.25, 70] },
  'maxX',
  71.25,
  4.5,
)
assert.deepEqual(fractional.x, [64.25, 70.25])
assert.deepEqual(fractional.z, [1.5, 4.5])
assert.deepEqual(fractional.y, [62.25, 70])
assert.deepEqual(
  resizeRect({ kind: 'rect', x: [64.25, 70.25], z: [1.5, 4.5], y: [62.25, 70] }, 'maxX', 72.25, 4.5).x,
  [64.25, 71.25],
)
const clamped = resizeRect({ kind: 'rect', x: [0, 4], z: [0, 4], y: 'all' }, 'maxX', -5, 0)
assert.deepEqual(clamped.x, [0, 0])
assert.deepEqual(clamped.z, [0, 4])

const flat = { kind: 'rect' as const, x: [3, 3] as [number, number], z: [4, 4] as [number, number], y: [0, 1] as [number, number] }
const flatGeometry = buildAreaGeometry(flat, 40)
assert.ok(flatGeometry)
flatGeometry.computeBoundingBox()
assert.ok(flatGeometry.boundingBox)
assert.ok(Math.abs(flatGeometry.boundingBox.min.x - 3) < 1e-4 && Math.abs(flatGeometry.boundingBox.max.x - 4) < 1e-4)
assert.ok(Math.abs(flatGeometry.boundingBox.min.z - 4) < 1e-4 && Math.abs(flatGeometry.boundingBox.max.z - 5) < 1e-4)
assert.ok(Math.abs(flatGeometry.boundingBox.min.y - 0) < 1e-4 && Math.abs(flatGeometry.boundingBox.max.y - 2) < 1e-4)
assert.ok(Math.abs((flatGeometry.boundingBox.max.x - flatGeometry.boundingBox.min.x) - 1) < 1e-6)
assert.deepEqual(flat.y, [0, 1])
const block = { kind: 'rect' as const, x: [0, 0] as [number, number], z: [0, 0] as [number, number], y: [64, 64] as [number, number] }
const blockGeometry = buildAreaGeometry(block, 40)
assert.ok(blockGeometry)
blockGeometry.computeBoundingBox()
assert.ok(blockGeometry.boundingBox)
assert.ok(Math.abs(blockGeometry.boundingBox.min.x - 0) < 1e-6 && Math.abs(blockGeometry.boundingBox.max.x - 1) < 1e-6)
assert.ok(Math.abs(blockGeometry.boundingBox.min.y - 64) < 1e-6 && Math.abs(blockGeometry.boundingBox.max.y - 65) < 1e-6)
assert.ok(Math.abs(blockGeometry.boundingBox.min.z - 0) < 1e-6 && Math.abs(blockGeometry.boundingBox.max.z - 1) < 1e-6)
assert.deepEqual(block, { kind: 'rect', x: [0, 0], z: [0, 0], y: [64, 64] })

const circle = { kind: 'circle' as const, center: [5, 7] as [number, number], radius: 10, y: [2, 8] as [number, number] }
const near = buildAreaGeometry(circle, 10)
assert.ok(near instanceof CylinderGeometry)
assert.equal(near.parameters.radialSegments, 28)
near.computeBoundingBox()
assert.ok(near.boundingBox)
assert.ok(Math.abs(near.boundingBox.min.y - 2) < 1e-3)
assert.ok(Math.abs(near.boundingBox.max.y - 9) < 1e-3)
assert.ok(Math.abs((near.boundingBox.min.x + near.boundingBox.max.x) / 2 - 5.5) < 1e-3)
assert.ok(Math.abs((near.boundingBox.min.z + near.boundingBox.max.z) / 2 - 7.5) < 1e-3)
const far = buildAreaGeometry({ ...circle, radius: 0.2 }, 100)
assert.ok(far instanceof CylinderGeometry)
assert.equal(far.parameters.radialSegments, 8)

const ccw: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]]
const cw: [number, number][] = [[0, 0], [0, 3], [4, 3], [4, 0]]
const ccwGeometry = buildPolygonVolume({ kind: 'polygon', points: ccw, y: [4, 10] }, 10, 6)
const cwGeometry = buildPolygonVolume({ kind: 'polygon', points: cw, y: [4, 10] }, 10, 6)
assert.ok(ccwGeometry && cwGeometry)
for (const geometry of [ccwGeometry, cwGeometry]) {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  assert.ok(box)
  assert.ok(Math.abs(box.min.x) < 1e-3 && Math.abs(box.max.x - 4) < 1e-3)
  assert.ok(Math.abs(box.min.z) < 1e-3 && Math.abs(box.max.z - 3) < 1e-3)
  assert.ok(Math.abs(box.min.y - 4) < 1e-3 && Math.abs(box.max.y - 10) < 1e-3, `挤出高度错了：${box.min.y}..${box.max.y}`)
}
assert.deepEqual(ccw, [[0, 0], [4, 0], [4, 3], [0, 3]])
assert.deepEqual(cw, [[0, 0], [0, 3], [4, 3], [4, 0]])
const polygonArea = { kind: 'polygon' as const, points: ccw, y: [4, 10] as [number, number] }
const polygonGeometry = buildAreaGeometry(polygonArea, 40)
assert.ok(polygonGeometry)
polygonGeometry.computeBoundingBox()
assert.ok(polygonGeometry.boundingBox)
assert.ok(Math.abs(polygonGeometry.boundingBox.min.x - 0.5) < 1e-3 && Math.abs(polygonGeometry.boundingBox.max.x - 4.5) < 1e-3)
assert.ok(Math.abs(polygonGeometry.boundingBox.min.z - 0.5) < 1e-3 && Math.abs(polygonGeometry.boundingBox.max.z - 3.5) < 1e-3)
assert.ok(Math.abs(polygonGeometry.boundingBox.min.y - 4) < 1e-3 && Math.abs(polygonGeometry.boundingBox.max.y - 11) < 1e-3)
assert.deepEqual(polygonArea.points, [[0, 0], [4, 0], [4, 3], [0, 3]])

console.log('PASS level volume: orbit frame, y:all display band, box cylinder extrusion')
