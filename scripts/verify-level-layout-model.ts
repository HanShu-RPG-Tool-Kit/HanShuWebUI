import assert from 'node:assert/strict'
import type { LevelDocument, LevelRectArea } from '../src/workspaces/gameplay/levelDoc'
import { setRegionCustom } from '../src/workspaces/gameplay/levelEdit'
import {
  applyAreaDraft, buildAreaDraft, coerceSelection, deletePlan, evaluateLevelDrafts,
  planRename, writeCustomKey, type LevelDraftRecord,
} from '../src/workspaces/gameplay/levelLayoutModel'

const area: LevelRectArea = { kind: 'rect', x: [0.1, 2.1], z: [-3.2, 1.2], y: [64.25, 64.25] }
const doc: LevelDocument = {
  tags: ['kept'], custom_data: { untouched: true }, landmarks: [],
  regions: [{ id: 'room', areas: [area, { ...area, y: 'all' }], custom_data: { priority: 3, nested: { keep: ['a', 2] } } }],
}
const original = JSON.stringify(doc)
assert.deepEqual(buildAreaDraft(area, {}).area, area)
assert.equal(buildAreaDraft(area, { x0: '-' }).pending, true)
assert.ok(buildAreaDraft(area, { x0: '-' }).message)
assert.ok(buildAreaDraft(area, { x0: '4' }).message, 'inverted ranges remain a field draft')
assert.equal(buildAreaDraft(area, { x0: '0.1' }).pending, false, 'unchanged fractions stay clean')

const edited = buildAreaDraft(area, { x1: '3.1' })
const records: LevelDraftRecord[] = [
  { order: 2, pending: true, message: null, reduce: (base, shown) => applyAreaDraft(base, shown, 'room', 0, edited.area) },
  { order: 5, pending: true, message: null, reduce: base => setRegionCustom(base, 'room', writeCustomKey(base.regions[0]!.custom_data, 'priority', 7)) },
]
const applied = evaluateLevelDrafts(doc, doc, records, { readOnly: false })
assert.equal(applied.ok, true)
if (applied.ok) {
  assert.equal((applied.doc.regions[0]!.areas[0] as LevelRectArea).x[1], 3.1)
  assert.equal(applied.doc.regions[0]!.custom_data.priority, 7)
  assert.deepEqual(applied.doc.regions[0]!.custom_data.nested, { keep: ['a', 2] })
  assert.equal(applied.doc.regions[0]!.areas[1]!.y, 'all')
  assert.deepEqual(applied.doc.tags, ['kept'])
  assert.deepEqual(applied.doc.custom_data, { untouched: true })
}
assert.equal(JSON.stringify(doc), original, 'evaluating drafts never mutates the committed source')

let calls = 0
const counted: LevelDraftRecord = { order: 0, pending: true, message: null, reduce: base => { calls++; return base } }
const blocked = evaluateLevelDrafts(doc, doc, [counted, { order: 9, pending: true, message: 'JSON 尚未应用', reduce: null }], { readOnly: false })
assert.equal(blocked.ok, false)
assert.equal(calls, 0, 'invalid fields block the entire aggregate before any reducer runs')
const readOnly = evaluateLevelDrafts(doc, doc, [counted], { readOnly: true })
assert.equal(readOnly.ok, false)
assert.equal(calls, 0, 'role downgrade cannot apply a valid pending field')
assert.equal(evaluateLevelDrafts(doc, doc, [], { readOnly: true }).ok, true)

const special = writeCustomKey(doc.regions[0]!.custom_data, '__proto__', { keep: 4 })
assert.equal(Object.hasOwn(special, '__proto__'), true)
assert.deepEqual(JSON.parse(JSON.stringify(special)).__proto__, { keep: 4 })
assert.equal(({} as Record<string, unknown>).keep, undefined)
assert.deepEqual(special.nested, { keep: ['a', 2] })

const two = deletePlan('room', 1, 'rect', 2)
assert.equal(two.mode, 'split')
if (two.mode === 'split') {
  assert.notEqual(two.volumeLabel, two.regionLabel)
  assert.match(two.volumeLabel, /2/)
  assert.match(two.regionLabel, /全部 2/)
}
assert.equal(deletePlan('room', 0, 'rect', 1).mode, 'single')
assert.deepEqual(coerceSelection(doc, { kind: 'region', id: 'room', area: 8 }), { kind: 'region', id: 'room', area: 1 })
const renamed = planRename(doc, 'region', 'room', ' room_new ')
assert.equal(renamed.ok, true)
if (renamed.ok && !renamed.unchanged) {
  assert.equal(renamed.id, 'room_new')
  assert.deepEqual(renamed.doc.regions[0]!.custom_data, doc.regions[0]!.custom_data)
}
console.log('PASS level layout model: atomic pending fields, readonly, fractional values, unknown keys and named deletes')
