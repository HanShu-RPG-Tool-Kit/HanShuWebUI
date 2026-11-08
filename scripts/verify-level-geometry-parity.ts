import assert from 'node:assert/strict'
import { createLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import { circleFromDrag, polygonFromPoints, rectFromDrag } from '../src/workspaces/gameplay/levelEdit.ts'
import {
  COORDINATE_LIMIT,
  anchoredPoint,
  authorCircleFromWorld,
  authorPointFromWorld,
  authorRectFromWorldFaces,
  circleWorldCenter,
  decimalAdd,
  decimalSub,
  moveAuthoredFace,
  polygonWorldPoint,
  rectWorldBox,
  snapAbsolute,
  snapFromOrigin,
  translateDelta,
  worldYSpan,
} from '../src/workspaces/gameplay/levelGeometry.ts'
import { buildAreaGeometry } from '../src/workspaces/gameplay/levelVolumeGeometry.ts'
import {
  movePolygonVertex,
  resizeCircle,
  resizeRect,
  translateArea,
  yFromHandle,
} from '../src/workspaces/gameplay/levelVolumeEdit.ts'

function exact(value: number, text: string, label: string) {
  assert.equal(value, Number(text), label)
  assert.equal(JSON.stringify(value), text, `${label} json`)
}

exact(decimalAdd(0.1, 0.2), '0.3', '0.1+0.2')
exact(decimalAdd(0.1, 1), '1.1', '0.1+1')
exact(decimalAdd(1.2, 0.2), '1.4', '1.2+0.2')
exact(decimalAdd(-0.1, -0.2), '-0.3', '-0.1+-0.2')
exact(decimalSub(1.1, 1), '0.1', '1.1-1')
exact(decimalSub(0.6, 0.5), '0.1', '0.6-0.5')
exact(decimalSub(-1.2, 0.2), '-1.4', '-1.2-0.2')
exact(decimalSub(-0.3, -0.2), '-0.1', '-0.3--0.2')
assert.notEqual(JSON.stringify(0.1 + 0.2), '0.3')
assert.notEqual(JSON.stringify(1.1 - 1), '0.1')

assert.equal(snapFromOrigin(9.25, 12.65), 12.25)
assert.equal(snapFromOrigin(10.25, 10.85), 11.25)
assert.equal(snapFromOrigin(10.25, 9.6), 9.25)
assert.equal(snapFromOrigin(10.25, 10.39, 0.1), 10.35)
assert.equal(snapFromOrigin(10.25, 10.41, 0.1), 10.45)
assert.equal(snapFromOrigin(64.25, 64.25), 64.25)
assert.equal(snapFromOrigin(64.25, 65.25), 65.25)
assert.equal(snapFromOrigin(9.5, 9.5), 9.5)
assert.equal(snapFromOrigin(62.25, 62.25), 62.25)
assert.equal(snapFromOrigin(0, -1.5), -2)
assert.equal(snapFromOrigin(0, -2.5), -3)
assert.equal(snapFromOrigin(-10.25, -11.75), -12.25)
assert.equal(snapFromOrigin(0, -0.15, 0.1), -0.2)
assert.equal(snapFromOrigin(0, -0.05, 0.1), -0.1)
assert.equal(snapFromOrigin(0, 0.05, 0.1), 0.1)
assert.equal(snapFromOrigin(64.25, Number.NaN), 64.25)
const fraction = 64.25
assert.equal(snapFromOrigin(fraction, fraction), fraction)

assert.equal(snapAbsolute(10.2), 10)
assert.equal(snapAbsolute(-1.2), -2)
assert.equal(snapAbsolute(-0), 0)
assert.equal(snapAbsolute(10.25, 0.1), 10.3)
assert.equal(snapAbsolute(-1.25, 0.1), -1.3)

const anchor = 0.1
assert.equal(anchoredPoint(anchor, 4, 4), anchor)
assert.equal(anchoredPoint(10.25, 0, -1.5), 8.25)
assert.equal(anchoredPoint(10.25, 10.25, 10.25 + 1), 11.25)
assert.equal(translateDelta(3, 3), 0)
assert.equal(translateDelta(0.1, -1.4), -2)
assert.equal(translateDelta(0, 0.2, 0.1), 0.2)
assert.equal(translateDelta(0, -0.25, 0.1), -0.3)

const tenthFace = decimalAdd(0.1, 1)
exact(moveAuthoredFace(tenthFace, tenthFace, 0, true) ?? Number.NaN, '0.1', 'unchanged max 0.1')
const rectTenth = { kind: 'rect' as const, x: [0, 0.1] as [number, number], z: [0, 0.2] as [number, number], y: 'all' as const }
const resizedTenth = resizeRect(rectTenth, 'maxX', tenthFace, 0)
assert.equal(resizedTenth.y, 'all')
exact(resizedTenth.x[1], '0.1', 'resize unchanged 0.1')
exact(resizedTenth.z[1], '0.2', 'resize leaves z')
const stepped = resizeRect(rectTenth, 'maxX', decimalAdd(tenthFace, 1), 0)
exact(stepped.x[1], '1.1', 'resize +1 keeps tenth')

const poly = { kind: 'polygon' as const, points: [[0.1, 0.2]] as [number, number][], y: [62.25, 62.25] as [number, number] }
const worldVertex = polygonWorldPoint(0.1, 0.2)
exact(worldVertex[0], '0.6', 'poly world x')
exact(worldVertex[1], '0.7', 'poly world z')
const stayed = movePolygonVertex(poly, 0, worldVertex[0], worldVertex[1])
exact(stayed.points[0]![0], '0.1', 'poly inverse')
exact(stayed.points[0]![1], '0.2', 'poly inverse z')
assert.deepEqual(stayed.y, [62.25, 62.25])

const shifted = translateArea(rectTenth, 0.2, -0.2)
assert.equal(shifted.kind, 'rect')
if (shifted.kind === 'rect') {
  exact(shifted.x[0], '0.2', 'translate 0+0.2')
  exact(shifted.x[1], '0.3', 'translate 0.1+0.2')
  exact(shifted.z[1], '0', 'translate 0.2-0.2')
}
const wide = { kind: 'rect' as const, x: [0.1, 1.2] as [number, number], z: [-1.2, -0.1] as [number, number], y: 'all' as const }
const wideMoved = translateArea(wide, 0.2, -0.2)
assert.equal(wideMoved.kind, 'rect')
if (wideMoved.kind === 'rect') {
  exact(wideMoved.x[0], '0.3', '0.1+0.2')
  exact(wideMoved.x[1], '1.4', '1.2+0.2')
  exact(wideMoved.z[0], '-1.4', '-1.2-0.2')
  exact(wideMoved.z[1], '-0.3', '-0.1-0.2')
}
const zeroMove = translateArea(wide, 0, 0)
assert.equal(zeroMove.kind, 'rect')
if (zeroMove.kind === 'rect') {
  exact(zeroMove.x[0], '0.1', 'zero dx')
  exact(zeroMove.x[1], '1.2', 'zero dx max')
}

const circle = { kind: 'circle' as const, center: [0.1, 0.2] as [number, number], radius: 0.1, y: 'all' as const }
const [circleX, circleZ] = circleWorldCenter(0.1, 0.2)
exact(circleX, '0.6', 'circle center x')
exact(circleZ, '0.7', 'circle center z')
const radiusHandle = decimalAdd(circleX, circle.radius)
exact(radiusHandle, '0.7', 'radius handle')
const sameRadius = resizeCircle(circle, radiusHandle, circleZ)
exact(sameRadius.radius, '0.1', 'radius unchanged')
exact(sameRadius.center[0], '0.1', 'center unchanged')
const grown = resizeCircle({ ...circle, radius: 9.5 }, decimalAdd(circleX, 10.5), circleZ)
assert.equal(grown.radius, 10.5)

const yStay = yFromHandle([62.25, 62.25], 'max', 63.25)
assert.deepEqual(yStay, [62.25, 62.25])
const yStep = yFromHandle([62.25, 62.25], 'max', 64.25)
assert.deepEqual(yStep, [62.25, 63.25])
assert.deepEqual(yFromHandle('all', 'max', 100), [0, 100])
assert.equal(yFromHandle([10, 40], 'max', 80)[1], 79)

const faces = rectWorldBox([0.1, 1.2], [0.2, 0.2], [62.25, 62.25])
exact(faces.minX, '0.1', 'face minX')
exact(faces.maxX, '2.2', 'face maxX')
exact(faces.minZ, '0.2', 'face minZ')
exact(faces.maxZ, '1.2', 'face maxZ')
exact(faces.minY, '62.25', 'face minY')
exact(faces.maxY, '63.25', 'face maxY')
exact(decimalSub(faces.maxX, 1), '1.2', 'inverse maxX')
exact(decimalSub(faces.maxY, 1), '62.25', 'inverse maxY')
assert.deepEqual(worldYSpan('all'), [-64, 320])
const single = rectWorldBox([0, 0], [0, 0], [64, 64])
assert.deepEqual([single.minX, single.minY, single.minZ, single.maxX, single.maxY, single.maxZ], [0, 64, 0, 1, 65, 1])

const block = buildAreaGeometry({ kind: 'rect', x: [0, 0], z: [0, 0], y: [64, 64] }, 40)
assert.ok(block)
block.computeBoundingBox()
const blockBox = block.boundingBox
assert.ok(blockBox)
assert.ok(Math.abs(blockBox.min.x) < 1e-6 && Math.abs(blockBox.max.x - 1) < 1e-6)
assert.ok(Math.abs(blockBox.min.y - 64) < 1e-6 && Math.abs(blockBox.max.y - 65) < 1e-6)
assert.ok(Math.abs(blockBox.min.z) < 1e-6 && Math.abs(blockBox.max.z - 1) < 1e-6)
assert.equal(buildAreaGeometry({ kind: 'circle', center: [0, 0], radius: 0, y: [0, 1] }, 40), null)
assert.equal(buildAreaGeometry({ kind: 'rect', x: [Number.NaN, 1], z: [0, 0], y: [0, 0] }, 40), null)

assert.deepEqual(authorRectFromWorldFaces(10, 10, 10, 10), { x: [10, 10], z: [10, 10] })
assert.deepEqual(rectFromDrag(10, 0, 10, 0), {
  kind: 'rect', x: [10, 10], z: [0, 0], y: 'all',
})
assert.deepEqual(rectFromDrag(10, 10, 10, 10), {
  kind: 'rect', x: [10, 10], z: [10, 10], y: 'all',
})
assert.deepEqual(rectFromDrag(0.2, 0.2, 3.8, 1.1), { kind: 'rect', x: [0, 4], z: [0, 1], y: 'all' })
const worldClick = rectFromDrag(10, 10, 10, 10, 'all', { worldFaces: true })
assert.deepEqual(worldClick, { kind: 'rect', x: [10, 10], z: [10, 10], y: 'all' })
assert.equal(authorRectFromWorldFaces(COORDINATE_LIMIT + 1, 0, COORDINATE_LIMIT + 1, 0), null)
assert.equal(rectFromDrag(0, 0, 4, 0, 'all', { worldFaces: true })?.kind, 'rect')

const authoredCircle = authorCircleFromWorld(10.5, 10.5, 10.5, 10.5)
assert.deepEqual(authoredCircle, { center: [10, 10], radius: 1 })
assert.deepEqual(authorPointFromWorld(10.6, -1.4), [10, -2])
assert.deepEqual(polygonFromPoints([[0.1, 0.2], [1.2, 0.2], [0.1, 1.2]], 'all', { authored: true }), {
  kind: 'polygon',
  points: [[0.1, 0.2], [1.2, 0.2], [0.1, 1.2]],
  y: 'all',
})

const clamped = resizeRect({ kind: 'rect', x: [0, 4], z: [0, 4], y: 'all' }, 'maxX', -5, 2)
assert.deepEqual(clamped.x, [0, 0])
assert.deepEqual(clamped.z, [0, 4])
assert.equal(clamped.y, 'all')
const overLimit = translateArea({ kind: 'rect', x: [COORDINATE_LIMIT, COORDINATE_LIMIT], z: [0, 0], y: 'all' }, 1, 0)
assert.equal(overLimit.kind, 'rect')
if (overLimit.kind === 'rect') assert.equal(overLimit.x[0], COORDINATE_LIMIT)

const doc = createLevelDocument()
assert.equal(doc.regions.length, 0)
console.log('level geometry parity ok')
