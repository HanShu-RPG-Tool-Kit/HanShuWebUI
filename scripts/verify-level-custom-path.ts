import assert from 'node:assert/strict'
import type { LevelCustomData } from '../src/workspaces/gameplay/levelDoc'
import {
  customValueKind,
  deleteAt,
  foldCustomDrafts,
  getAt,
  insertAt,
  ownCustomEntries,
  setAt,
  type CustomAddDraft,
} from '../src/workspaces/gameplay/levelCustomPath'

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function rec(entries: Record<string, unknown>): LevelCustomData {
  const next = Object.create(null) as LevelCustomData
  for (const [key, value] of Object.entries(entries)) define(next, key, value)
  return next
}

const shared = { z: true }
const nested = rec({ keep: ['a', 2], other: shared })
const root = rec({
  acceptance: 'preserve-region-extra',
  priority: 3,
  enabled: true,
  nested,
  sibling: shared,
})

const withString = setAt(root, ['nested', 'keep', 0], 'b')
assert.equal(getAt(withString, ['nested', 'keep', 0]), 'b')
assert.equal(getAt(root, ['nested', 'keep', 0]), 'a')
assert.deepEqual(getAt(withString, ['nested', 'keep']), ['b', 2])
assert.equal(typeof getAt(withString, ['nested', 'keep', 1]), 'number')
assert.equal(getAt(withString, ['sibling']), shared)
assert.equal(getAt(withString, ['nested']) !== nested, true)
assert.equal((getAt(withString, ['nested']) as { other: unknown }).other, shared)
assert.equal(getAt(withString, ['acceptance']), 'preserve-region-extra')
assert.equal(getAt(withString, ['priority']), 3)
assert.equal(getAt(withString, ['enabled']), true)

const withNumber = setAt(root, ['nested', 'keep', 1], 9)
assert.equal(getAt(withNumber, ['nested', 'keep', 1]), 9)
assert.equal(typeof getAt(withNumber, ['nested', 'keep', 1]), 'number')
assert.equal(getAt(withNumber, ['nested', 'keep', 0]), 'a')

const withBool = setAt(root, ['enabled'], false)
assert.equal(getAt(withBool, ['enabled']), false)
assert.equal(typeof getAt(withBool, ['enabled']), 'boolean')

const withNull = setAt(root, ['note'], null)
assert.equal(getAt(withNull, ['note']), null)
assert.equal(customValueKind(getAt(withNull, ['note'])), 'null')
assert.equal(Object.getOwnPropertyDescriptor(withNull, 'note')?.enumerable, true)
assert.equal(getAt(withNull, ['sibling']), shared)

const withObject = setAt(root, ['bag'], rec({}))
assert.equal(customValueKind(getAt(withObject, ['bag'])), 'object')
assert.equal(Object.getPrototypeOf(getAt(withObject, ['bag'])), null)
const withArray = setAt(withObject, ['bag', 'items'], ['a', 2, true])
let items = insertAt(withArray, ['bag', 'items'], 1, null)
assert.deepEqual(getAt(items, ['bag', 'items']), ['a', null, 2, true])
items = deleteAt(items, ['bag', 'items', 2])
assert.deepEqual(getAt(items, ['bag', 'items']), ['a', null, true])
assert.equal(getAt(items, ['priority']), 3)

const protoSource = Object.create(null) as LevelCustomData
define(protoSource, 'sibling', 's')
define(protoSource, '__proto__', rec({ keep: 1 }))
const protoNext = setAt(protoSource, ['__proto__', 'keep'], 2)
assert.equal(Object.getPrototypeOf(protoNext), null)
assert.equal(Object.getOwnPropertyDescriptor(protoNext, '__proto__')?.value.keep, 2)
assert.equal(getAt(protoNext, ['sibling']), 's')
assert.equal(JSON.parse(JSON.stringify(protoNext)).__proto__.keep, 2)
const protoLiteral = setAt(protoSource, ['__proto__'], 'literal')
assert.equal(Object.getOwnPropertyDescriptor(protoLiteral, '__proto__')?.value, 'literal')
assert.equal(Object.getPrototypeOf(protoLiteral), null)
assert.equal(({} as { own?: unknown }).own, undefined)
assert.deepEqual(ownCustomEntries(protoLiteral).map(([key]) => key), ['sibling', '__proto__'])

const partial = foldCustomDrafts(root, [], [{ path: ['nested', 'keep', 1], kind: 'number', raw: '2.' }], [])
assert.equal(partial.pending, true)
assert.equal(partial.message, '数字未完成')
assert.equal(getAt(partial.custom, ['nested', 'keep', 1]), 2)

const complete = foldCustomDrafts(root, [], [{ path: ['nested', 'keep', 1], kind: 'number', raw: '9' }], [])
assert.equal(complete.pending, true)
assert.equal(complete.message, null)
assert.equal(getAt(complete.custom, ['nested', 'keep', 1]), 9)
assert.equal(typeof getAt(complete.custom, ['nested', 'keep', 1]), 'number')

const same = foldCustomDrafts(root, [], [{ path: ['priority'], kind: 'number', raw: '3' }], [])
assert.equal(same.pending, false)
assert.equal(same.custom, root)

const blankAdd: CustomAddDraft = { container: [], mode: 'key', name: '', kind: 'string', raw: '' }
assert.equal(foldCustomDrafts(root, ['priority'], [], [blankAdd]).pending, false)

const namedEmpty: CustomAddDraft = { container: [], mode: 'key', name: 'extra', kind: 'string', raw: '' }
const blockedAdd = foldCustomDrafts(root, [], [], [namedEmpty])
assert.equal(blockedAdd.pending, true)
assert.equal(blockedAdd.message, '新键尚未添加')
assert.equal(getAt(blockedAdd.custom, ['extra']), undefined)

const reservedAdd: CustomAddDraft = { container: [], mode: 'key', name: 'priority', kind: 'string', raw: 'x' }
assert.equal(foldCustomDrafts(root, ['priority'], [], [reservedAdd]).message, '这个键已经在上面的表单里')

const nestedReserved: CustomAddDraft = { container: ['nested'], mode: 'key', name: 'priority', kind: 'number', raw: '4' }
const nestedAdd = foldCustomDrafts(root, ['priority'], [], [nestedReserved])
assert.equal(nestedAdd.message, null)
assert.equal(getAt(nestedAdd.custom, ['nested', 'priority']), 4)
assert.equal(typeof getAt(nestedAdd.custom, ['nested', 'priority']), 'number')
assert.equal(getAt(nestedAdd.custom, ['priority']), 3)
assert.equal((getAt(nestedAdd.custom, ['nested']) as { other: unknown }).other, shared)

const objectAdd: CustomAddDraft = { container: ['nested'], mode: 'key', name: 'bag', kind: 'object', raw: '' }
const addedObject = foldCustomDrafts(root, [], [], [objectAdd])
assert.equal(addedObject.message, null)
assert.equal(Object.getPrototypeOf(getAt(addedObject.custom, ['nested', 'bag'])), null)
assert.deepEqual(Object.keys(getAt(addedObject.custom, ['nested', 'bag']) as object), [])

const nullItem: CustomAddDraft = { container: ['nested', 'keep'], mode: 'item', name: '', kind: 'null', raw: '' }
const addedNull = foldCustomDrafts(root, [], [], [nullItem])
assert.deepEqual(getAt(addedNull.custom, ['nested', 'keep']), ['a', 2, null])

const boolLeaf = foldCustomDrafts(root, [], [{ path: ['acceptance'], kind: 'string', raw: 'kept' }], [])
assert.equal(getAt(boolLeaf.custom, ['acceptance']), 'kept')
assert.equal(getAt(boolLeaf.custom, ['enabled']), true)
assert.equal(getAt(boolLeaf.custom, ['nested']), nested)

console.log('level custom path ok')
