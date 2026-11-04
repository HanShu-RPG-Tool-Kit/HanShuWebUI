import assert from 'node:assert/strict'
import { createLevelDocument } from '../src/workspaces/gameplay/levelDoc.ts'
import {
  addArea,
  addLandmark,
  circleFromDrag,
  deleteArea,
  hitArea,
  levelHistory,
  levelHistoryCommit,
  levelHistoryRedo,
  levelHistoryUndo,
  levelIssues,
  moveLandmark,
  polygonFromPoints,
  rectFromDrag,
  renameLandmark,
} from '../src/workspaces/gameplay/levelEdit.ts'

const area = rectFromDrag(0.2, 0.2, 3.8, 1.1)
assert.deepEqual(area, { kind: 'rect', x: [0, 4], z: [0, 1], y: 'all' })
assert.equal(circleFromDrag(1, 1, 1, 1).radius, 1)

const created = addArea(createLevelDocument(), null, area)
assert.equal(created.regions.length, 1)
assert.equal(created.regions[0]!.id, 'region')
assert.deepEqual(deleteArea(created, 'region', 0).regions, [])

const first = addLandmark(createLevelDocument(), 1.2, 2.8, 70.4)
assert.equal(first.id, 'landmark')
assert.deepEqual(first.doc.landmarks[0]!.param, { x: 1, y: 70, z: 3 })
const moved = moveLandmark(first.doc, first.id, -1.6, 4.2)
assert.deepEqual(moved.landmarks[0]!.param, { x: -2, y: 70, z: 4 })

let history = levelHistory(first.doc)
assert.equal(levelHistoryCommit(history, first.doc), history, '相同文档不进撤销栈')
history = levelHistoryCommit(history, moved)
assert.equal(history.undo.length, 1)
assert.equal(history.current.landmarks[0]!.param.x, -2)
const undone = levelHistoryUndo(history)
assert.equal(undone.current.landmarks[0]!.param.x, 1)
const redone = levelHistoryRedo(undone)
assert.equal(redone.current.landmarks[0]!.param.x, -2)

let capped = levelHistory(createLevelDocument())
for (let index = 0; index < 120; index += 1) {
  capped = levelHistoryCommit(capped, addLandmark(capped.current, index, 0, 64).doc)
}
assert.equal(capped.undo.length, 100)
assert.equal(capped.current.landmarks.at(-1)?.param.x, 119)

const second = addLandmark(first.doc, 8, 8, 64)
const collided = renameLandmark(second.doc, second.id, first.id)
assert.equal(collided, second.doc, '重名地标保持原文档')
const forced = {
  ...second.doc,
  landmarks: second.doc.landmarks.map((point, index) => index === 1 ? { ...point, id: first.id } : point),
}
assert.ok(levelIssues(forced).some((issue) => issue.includes('重复')))

const polygon = polygonFromPoints([[0, 0], [4, 0], [4, 4], [0, 4]])
assert.equal(hitArea(polygon, 2, 2), true)
assert.equal(hitArea(polygon, 5, 2), false)
assert.equal(hitArea(area, 1, 0.5), true)
assert.equal(hitArea(area, 5, 0.5), false)

console.log('PASS: level edit snap, history, last-area deletion, duplicate id, polygon hit')
