import assert from 'node:assert/strict'
import {
  closeInGroup,
  focusedGroupId,
  joinGroups,
  moveTab,
  normalizeGroups,
  openInGroup,
  readGroup,
  splitTab,
  togglePinInGroup,
} from '../src/workspaces/progress/editorGroups.ts'
import type { FlowDocument, FlowWorkspaceState } from '../src/workspaces/progress/storage.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

const doc = (key: string) => ({ key, name: `${key}.hflow`, source: '{}', package: 'story', folderId: null }) as unknown as FlowDocument
function workspace(open: string[], active = open.at(-1) ?? null): FlowWorkspaceState {
  return { documents: ['a', 'b', 'c', 'd'].map(doc), folders: [], activeKey: active, openKeys: open, pinnedKeys: [], split: null }
}
const keys = (state: FlowWorkspaceState, id: 0 | 1) => readGroup(state, id).openKeys
const active = (state: FlowWorkspaceState, id: 0 | 1) => readGroup(state, id).activeKey

test('splitting the rightmost active page keeps the left group intact', () => {
  const split = splitTab(workspace(['a', 'b', 'c']), 'c', 'right', 'copy')
  assert.deepEqual(keys(split, 0), ['a', 'b', 'c'])
  assert.deepEqual(keys(split, 1), ['c'])
  assert.equal(focusedGroupId(split), 1)
  const clickedLeft = openInGroup(split, 0, 'a')
  assert.equal(active(clickedLeft, 0), 'a')
  assert.deepEqual(keys(clickedLeft, 1), ['c'])
  assert.equal(focusedGroupId(clickedLeft), 0)
})

test('opening from the explorer goes to the focused group only', () => {
  const split = splitTab(workspace(['a', 'b']), 'b', 'right', 'copy')
  const opened = openInGroup(split, focusedGroupId(split), 'd')
  assert.deepEqual(keys(opened, 0), ['a', 'b'])
  assert.deepEqual(keys(opened, 1), ['b', 'd'])
  assert.equal(active(opened, 0), 'b')
})

test('dragging to an edge moves the page; left/top puts the new group first', () => {
  const right = splitTab(workspace(['a', 'b', 'c'], 'b'), 'b', 'right', 'move')
  assert.deepEqual(keys(right, 0), ['a', 'c'])
  assert.equal(active(right, 0), 'c')
  assert.deepEqual(keys(right, 1), ['b'])
  assert.equal(right.split?.direction, 'horizontal')
  const top = splitTab(workspace(['a', 'b', 'c']), 'a', 'top', 'move')
  assert.deepEqual(keys(top, 0), ['a'])
  assert.deepEqual(keys(top, 1), ['b', 'c'])
  assert.equal(top.split?.direction, 'vertical')
  assert.equal(focusedGroupId(top), 0)
})

test('moving the only page out of a group must not leave it empty', () => {
  const single = splitTab(workspace(['a']), 'a', 'bottom', 'move')
  assert.deepEqual(keys(single, 0), ['a'])
  assert.deepEqual(keys(single, 1), ['a'])
})

test('cross-group drag inserts before the target and collapses an emptied group', () => {
  const split = splitTab(workspace(['a', 'b', 'c']), 'c', 'right', 'move')
  const moved = moveTab(split, 0, 1, 'a', 'c')
  assert.deepEqual(keys(moved, 0), ['b'])
  assert.deepEqual(keys(moved, 1), ['a', 'c'])
  assert.equal(active(moved, 1), 'a')
  const collapsed = moveTab(moved, 0, 1, 'b', null)
  assert.equal(collapsed.split, null)
  assert.deepEqual(keys(collapsed, 0), ['a', 'c', 'b'])
})

test('closing the last page of the primary group promotes the secondary', () => {
  const split = splitTab(workspace(['a', 'b']), 'b', 'right', 'move')
  const closed = closeInGroup(split, 0, ['a'])
  assert.equal(closed.split, null)
  assert.deepEqual(keys(closed, 0), ['b'])
})

test('pinned pages survive close and keep pin when moved', () => {
  let state = togglePinInGroup(workspace(['a', 'b', 'c']), 0, 'c')
  assert.deepEqual(keys(state, 0), ['c', 'a', 'b'])
  state = closeInGroup(state, 0, ['a', 'b', 'c'])
  assert.deepEqual(keys(state, 0), ['c'])
  state = splitTab(openInGroup(state, 0, 'd'), 'd', 'right', 'move')
  state = moveTab(state, 0, 1, 'c', null)
  assert.equal(state.split, null)
  assert.deepEqual(readGroup(state, 0).pinnedKeys, ['c'])
})

test('join merges pages and keeps the focused page', () => {
  const split = openInGroup(splitTab(workspace(['a', 'b']), 'b', 'right', 'move'), 1, 'c')
  const joined = joinGroups(split)
  assert.equal(joined.split, null)
  assert.deepEqual(keys(joined, 0), ['a', 'b', 'c'])
  assert.equal(active(joined, 0), 'c')
})

test('normalize drops removed documents and clamps the ratio', () => {
  const split = splitTab(workspace(['a', 'b']), 'b', 'right', 'move')
  const state = normalizeGroups({ ...split, split: { ...split.split!, ratio: 3 } })
  assert.equal(state.split?.ratio, 0.8)
  const removed = normalizeGroups({ ...split, documents: split.documents.filter((item) => item.key !== 'b') })
  assert.equal(removed.split, null)
  assert.deepEqual(keys(removed, 0), ['a'])
})

console.log(`\n${passed} editor-group checks passed.`)
