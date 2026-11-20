import assert from 'node:assert/strict'
import { applyStick, copyLayout, defaultRecord, dockBeside, dockToEdge, emptyLanes, layoutFrame, layoutFromSaved, mergeTabs, orderTab, resizeCell, resizeLane, setCellPixels, workspaceBottomHit, DOCK_SASH, type DockLayout } from '../src/ui/panelDockModel'

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

const bottom = fixture()
const root = { width: 1200, height: 640 }
const visible = new Set(['a', 'b', 'inner', 'assets'])
bottom.panels.inner = defaultRecord({ id: 'inner' })
bottom.panels.assets = defaultRecord({ id: 'assets', defaultPlacement: 'float' })
dockToEdge(bottom, 'b', 'right', 260)
dockToEdge(bottom, 'inner', 'bottom', 160)
const legacyBottom = layoutFrame(bottom, root, visible)
assert.equal(legacyBottom.slots.inner.w, legacyBottom.main.w)
assert.equal(legacyBottom.slots.a.h, root.height)

const beforeDock = copyLayout(bottom)
const hit = workspaceBottomHit(beforeDock, root, visible, 250)
applyStick(bottom, 'assets', hit, 250)
for (const size of [root, { ...root, height: 341 }]) {
  const frame = layoutFrame(bottom, size, visible)
  assert.deepEqual(frame.slots.assets, workspaceBottomHit(beforeDock, size, visible, 250).preview)
  assert.equal(frame.slots.assets.w, size.width)
  assert.equal(frame.slots.assets.y + frame.slots.assets.h, size.height)
  assert.equal(frame.slots.a.h, frame.slots.assets.y - DOCK_SASH)
  assert.equal(frame.slots.b.h, frame.slots.a.h)
  assert.equal(frame.slots.inner.w, frame.main.w)
  assert.equal(frame.slots.inner.y + frame.slots.inner.h, frame.slots.a.h)
}
resizeLane(bottom, 'bottom', 0, 290, 120, 720)
const persisted = layoutFromSaved(JSON.parse(JSON.stringify(copyLayout(bottom))))!
assert.equal(layoutFrame(persisted, root, visible).slots.assets.h, 290)
assert.equal(layoutFrame(persisted, root, new Set(['a', 'b', 'inner'])).slots.a.h, root.height)

const grouped = copyLayout(persisted)
assert.equal(mergeTabs(grouped, 'b', 'assets'), true)
assert.equal(grouped.panels.b.lastFullWidth, true)
assert.equal(layoutFrame(grouped, root, visible).tabBars[0].rect.w, root.width)
assert.equal(dockBeside(grouped, 'a', 'b', 'top', 120), true)
assert.equal(layoutFrame(grouped, root, visible).slots.a.w, root.width)
console.log('通过：工作区全宽底部停靠、预览尺寸、分隔条、本机保存与隐藏恢复')
