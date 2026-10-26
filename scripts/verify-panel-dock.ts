import assert from 'node:assert/strict'
import { defaultRecord, emptyLanes, layoutFrame, layoutFromSaved, orderTab, resizeCell, setCellPixels, type DockLayout } from '../src/ui/panelDockModel'

function fixture(): DockLayout {
  return { version: 3, agentSized: true, panels: Object.fromEntries(['a', 'hidden', 'b'].map(id => [id, defaultRecord({ id })])), lanes: { ...emptyLanes(), left: [{ size: 280, cells: ['a', 'hidden', 'b'].map(id => ({ id, weight: 1 })) }] }, floatGroups: [] }
}
const layout = fixture()
const before = JSON.stringify(layout)
assert.deepEqual(Object.keys(layoutFrame(layout, { width: 1200, height: 600 }, new Set(['a', 'b'])).bands), ['a', 'b'])
assert.equal(JSON.stringify(layout), before, 'hiding panels must not mutate the persisted layout')
setCellPixels(layout, 'left', 0, 0, 200, 394, 600, new Set(['a', 'b']))
const cells = layout.lanes.left[0].cells
assert.equal(cells[1].weight, 1)
assert.ok(Math.abs(cells[0].weight + cells[2].weight - 2) < 1e-9)
const restored = layoutFrame(layout, { width: 1200, height: 600 }, new Set(['a', 'hidden', 'b']))
assert.equal(restored.bands.hidden.h, 196, 'restored hidden cell retains its share')
resizeCell(layout, 'left', 0, 0, 40, 600)
assert.ok(Math.abs(cells.reduce((sum, cell) => sum + cell.weight, 0) - 3) < 1e-9)
resizeCell(layout, 'left', 0, 0, 1000, 20)
assert.ok(cells.every(cell => cell.weight > 0), 'tiny containers never produce negative cell weights')

for (const floating of [false, true]) {
  const tabs = fixture()
  if (floating) {
    for (const panel of Object.values(tabs.panels)) panel.placement = 'float'
    tabs.lanes = emptyLanes()
    tabs.floatGroups = [{ tabs: ['a', 'hidden', 'b'], active: 'a' }]
  } else tabs.lanes.left[0].cells = [{ id: 'a', tabs: ['a', 'hidden', 'b'], weight: 1 }]
  orderTab(tabs, 'a', 1, new Set(['a', 'b']))
  assert.deepEqual(floating ? tabs.floatGroups![0].tabs : tabs.lanes.left[0].cells[0].tabs, ['b', 'hidden', 'a'])
  assert.deepEqual(layoutFromSaved(JSON.parse(JSON.stringify(tabs))), tabs)
}
console.log('通过：隐藏面板布局保持、分隔条权重、极小容器、隐藏 tab 排序与持久化')
